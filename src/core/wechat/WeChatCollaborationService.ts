import { createHash, randomUUID } from 'crypto';

import type SecondBrainPlugin from '../../main';
import { historySourcePath } from '../../utils/boundedHistory';
import { appendMarkdownSnippet } from '../../utils/markdown';
import { normalizeVaultNoteLinks } from '../../utils/vaultNoteLinks';
import { CodexSessionService } from '../agent/CodexSessionService';
import {
  type CustomInstructionsOperation,
  extractCustomInstructionsProposal,
  MAX_CUSTOM_INSTRUCTIONS_LENGTH,
} from '../agent/customInstructionsControl';
import { resolveConversationCommand } from '../commands/conversationCommandResolver';
import { formatLocalTimestamp } from '../knowledge/InboxCaptureService';
import { type OwnedTextChange, rollbackOwnedChanges, serializeVaultOperation, writeTextIfUnchanged } from '../knowledge/VaultMutation';
import type { ChatMessage, CodexPerformanceMode, Conversation, UsageInfo } from '../types';
import { BACKEND_CODEX } from '../types';
import type { WeChatStateStore } from './WeChatStateStore';

const ACTION_PATTERN = /<wechat_action>\s*([\s\S]*?)\s*<\/wechat_action>/giu;
const CAPTURE_PATTERN = /<wechat_capture\s*\/>/giu;
const ACTION_TTL_MS = 30 * 60 * 1000;
const MAX_ACTION_CHANGES = 8;
const MAX_ACTION_CHARS = 80_000;
const HISTORY_FALLBACK_MESSAGES = 20;

export type WeChatCollaborationMode = CodexPerformanceMode;

export interface WeChatConversationPreferences {
  conversationId?: string;
  mode: WeChatCollaborationMode;
}

export type WeChatActionChange =
  | { operation: 'mkdir'; path: string }
  | { operation: 'create'; path: string; content: string }
  | { operation: 'append'; path: string; content: string }
  | { operation: 'replace'; path: string; oldText: string; newText: string };

export interface WeChatActionProposal {
  title: string;
  summary: string;
  changes: WeChatActionChange[];
}

export interface WeChatActionBaseline {
  path: string;
  exists: boolean;
  sha256: string;
}

export interface WeChatPendingFileAction extends WeChatActionProposal {
  kind: 'files';
  id: string;
  request: string;
  createdAt: string;
  expiresAt: string;
  baselines: WeChatActionBaseline[];
}

export interface WeChatPendingCustomInstructionsAction {
  kind: 'custom-instructions';
  id: string;
  title: string;
  summary: string;
  request: string;
  createdAt: string;
  expiresAt: string;
  operation: CustomInstructionsOperation;
  content: string;
  previousContent: string;
  baselineSha256: string;
}

export type WeChatPendingAction = WeChatPendingFileAction | WeChatPendingCustomInstructionsAction;

export type WeChatCollaborationCommand =
  | { kind: 'new' }
  | { kind: 'status' }
  | { kind: 'help' }
  | { kind: 'summary' }
  | { kind: 'mode'; mode: WeChatCollaborationMode }
  | { kind: 'today' }
  | { kind: 'butler-brief' }
  | { kind: 'cancel-action' }
  | { kind: 'confirm-action'; id?: string };

export interface WeChatIntent {
  kind: 'chat' | 'capture';
  text: string;
  forced: boolean;
}

export interface WeChatChatResult {
  replies: string[];
  mode: WeChatCollaborationMode;
  captureRequested: boolean;
  pendingAction?: WeChatPendingAction;
}

export interface WeChatRunChatOptions {
  excludeLatestInboundFromHistory?: boolean;
}

export interface WeChatActionApplyResult {
  changedPaths: string[];
  snapshotPath: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function actionStamp(now: Date): string {
  return formatLocalTimestamp(now).replace(/[-:T]/gu, '').slice(0, 14);
}

function normalizeActionPath(value: string, requireMarkdown: boolean): string {
  const normalized = value.trim().replace(/\\/gu, '/').replace(/^\.\//u, '');
  const segments = normalized.split('/');
  if (
    !normalized
    || normalized.startsWith('/')
    || normalized.includes(':')
    || segments.some((segment) => !segment || segment === '..' || segment.startsWith('.'))
    || (requireMarkdown && !normalized.toLowerCase().endsWith('.md'))
  ) {
    throw new Error(`不允许修改该路径：${value}`);
  }
  if (normalized === '010_收件箱/原始输入_raw' || normalized.startsWith('010_收件箱/原始输入_raw/')) {
    throw new Error('原始输入只读，不能通过微信修改。');
  }
  return normalized;
}

function normalizeVaultPath(value: string): string {
  return normalizeActionPath(value, true);
}

function normalizeFolderPath(value: string): string {
  return normalizeActionPath(value.replace(/\/+$/u, ''), false);
}

function countOccurrences(content: string, value: string): number {
  if (!value) return 0;
  let count = 0;
  let offset = 0;
  while (offset <= content.length) {
    const index = content.indexOf(value, offset);
    if (index < 0) break;
    count++;
    offset = index + value.length;
  }
  return count;
}

function parseActionChange(value: unknown): WeChatActionChange | null {
  if (!isRecord(value) || typeof value.operation !== 'string' || typeof value.path !== 'string') {
    return null;
  }
  if (value.operation === 'mkdir') {
    return { operation: 'mkdir', path: normalizeFolderPath(value.path) };
  }
  const path = normalizeVaultPath(value.path);
  if (value.operation === 'create' || value.operation === 'append') {
    if (typeof value.content !== 'string' || !value.content.trim()) return null;
    return { operation: value.operation, path, content: value.content };
  }
  if (value.operation === 'replace') {
    if (
      typeof value.oldText !== 'string'
      || !value.oldText
      || typeof value.newText !== 'string'
      || value.oldText === value.newText
    ) return null;
    return { operation: 'replace', path, oldText: value.oldText, newText: value.newText };
  }
  return null;
}

export function extractWeChatAction(text: string): {
  reply: string;
  proposal: WeChatActionProposal | null;
  error?: string;
} {
  const matches = [...text.matchAll(ACTION_PATTERN)];
  if (matches.length === 0) return { reply: text.trim(), proposal: null };
  const reply = text.replace(ACTION_PATTERN, '').trim();
  if (matches.length !== 1) {
    return { reply, proposal: null, error: '模型返回了多个修改提案，本次不会执行。' };
  }

  try {
    const parsed: unknown = JSON.parse(matches[0][1]);
    if (!isRecord(parsed) || !Array.isArray(parsed.changes)) {
      throw new Error('缺少 changes');
    }
    const title = typeof parsed.title === 'string' ? parsed.title.trim() : '';
    const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
    const changes = parsed.changes.map(parseActionChange).filter((item): item is WeChatActionChange => Boolean(item));
    if (!title || !summary || changes.length !== parsed.changes.length || changes.length === 0) {
      throw new Error('字段不完整');
    }
    if (changes.length > MAX_ACTION_CHANGES) throw new Error(`一次最多修改 ${MAX_ACTION_CHANGES} 个位置`);
    const totalChars = changes.reduce((total, change) => {
      if (change.operation === 'mkdir') return total;
      if (change.operation === 'replace') return total + change.oldText.length + change.newText.length;
      return total + change.content.length;
    }, 0);
    if (totalChars > MAX_ACTION_CHARS) throw new Error('修改内容过长');
    return { reply, proposal: { title, summary, changes } };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { reply, proposal: null, error: `修改提案格式无效（${reason}），本次不会执行。` };
  }
}

export function extractWeChatCaptureDecision(text: string): {
  cleanedText: string;
  shouldCapture: boolean;
} {
  CAPTURE_PATTERN.lastIndex = 0;
  const shouldCapture = CAPTURE_PATTERN.test(text);
  CAPTURE_PATTERN.lastIndex = 0;
  return {
    cleanedText: text.replace(CAPTURE_PATTERN, '').trim(),
    shouldCapture,
  };
}

export function parseWeChatCollaborationCommand(text: string): WeChatCollaborationCommand | null {
  const normalized = text.trim().replace(/[。！!]+$/u, '').trim();
  if (/^(?:新对话|开始新对话)$/u.test(normalized)) return { kind: 'new' };
  if (/^(?:当前会话|会话状态)$/u.test(normalized)) return { kind: 'status' };
  if (/^(?:微信帮助|协作帮助|帮助)$/u.test(normalized)) return { kind: 'help' };
  if (/^(?:对话摘要|总结当前对话)$/u.test(normalized)) return { kind: 'summary' };
  if (/^(?:使用)?快速通道$/u.test(normalized)) return { kind: 'mode', mode: 'fast' };
  if (/^(?:使用)?深度通道$/u.test(normalized)) return { kind: 'mode', mode: 'deep' };
  if (
    /^(?:(?:请|麻烦)?(?:给我)?(?:发|发送|看|查看|生成)?(?:一份|一下)?(?:今天|今日)?的?|像之前一样的?)?管家简报$/u.test(normalized)
    || /^(?:今天|今日)的?简报$/u.test(normalized)
  ) return { kind: 'butler-brief' };
  if (/^(?:打开|创建|打开或创建)(?:今天|今日)的?(?:日记|日志)$/u.test(normalized) || /^\/today$/iu.test(normalized)) {
    return { kind: 'today' };
  }
  if (/^(?:取消|取消操作|取消执行|不要执行)$/u.test(normalized)) return { kind: 'cancel-action' };
  const confirm = normalized.match(/^确认执行\s+(QR-[A-Z0-9]{4,12})$/iu);
  if (confirm) return { kind: 'confirm-action', id: confirm[1].toUpperCase() };
  if (/^(?:确认|确认执行|执行)$/u.test(normalized)) return { kind: 'confirm-action' };
  return null;
}

export function classifyWeChatIntent(text: string): WeChatIntent {
  const trimmed = text.trim();
  const forcedChat = trimmed.match(/^(?:对话|提问|问一下)[：:]\s*([\s\S]+)$/u);
  if (forcedChat) return { kind: 'chat', text: forcedChat[1].trim(), forced: true };
  const forcedCapture = trimmed.match(/^(?:记录|保存|收录|记一下|存入收件箱)[：:]?\s*([\s\S]+)$/u);
  if (forcedCapture) return { kind: 'capture', text: forcedCapture[1].trim(), forced: true };
  return { kind: 'chat', text: trimmed, forced: false };
}

function buildWechatPrompt(request: string, attachmentPaths: string[], now: Date): string {
  const attachments = attachmentPaths.length
    ? `\n\n本条消息已经安全保存以下附件或原始记录，需要时可以只读查看：\n${attachmentPaths.map((path) => `- ${path}`).join('\n')}`
    : '';
  return `你正在通过“第二大脑”的微信协作入口回答用户。当前时间：${formatLocalTimestamp(now)}。

当前回合是手机端的预执行阶段。你与电脑端对话使用同一份插件自定义指令、Vault 根目录 AGENTS.md、模型和知识命令；本阶段只读，任何写入由插件在用户确认后执行。

回答要求：
1. 使用中文，先给结论，简洁但足以直接行动。
2. 不扫描全库，只读取回答当前问题必需的索引和笔记。
3. 当前消息和 Vault 旧记录冲突时，以当前消息为准并指出冲突。
4. 用户可以像在电脑端一样自然表达，不要求固定句式、英文指令或命令前缀。先理解意图，再决定是回答、检索、建议收录还是提出受控修改。
5. 如果用户只是提问或交流，正常回答，不要输出任何控制标记。
6. 如果消息主要是一段希望长期保留的想法、材料、待办或进展记录，在自然回应末尾追加且只追加一次 <wechat_capture/>。该标记不会展示给用户。拿不准是否要保存时先询问，不要标记。明确的提问、检索和修改请求不要标记。
7. 如果用户要求新建文件夹，或创建、追加、修改笔记，先只读核对目标，然后给出简短修改说明，并在回答末尾输出且只输出一个以下格式的标记：
<wechat_action>{"title":"修改标题","summary":"将要改什么以及原因","changes":[{"operation":"mkdir","path":"相对Vault文件夹路径"},{"operation":"create","path":"相对Vault路径.md","content":"完整内容"},{"operation":"append","path":"相对Vault路径.md","content":"要追加的内容"},{"operation":"replace","path":"相对Vault路径.md","oldText":"必须唯一匹配的原文","newText":"替换后的文本"}]}</wechat_action>
8. changes 只保留实际需要的操作；mkdir 只用于新建文件夹。现有笔记优先使用小范围 replace 或 append，不得整篇重写。不得触碰 .obsidian、.second-brain 和 010_收件箱/原始输入_raw。一次最多 8 个位置。
9. 不要要求用户输入编号或复制英文命令；插件会验证提案，用户只需回复“确认”或“取消”。

用户消息：
${request}${attachments}`;
}

export class WeChatActionExecutor {
  constructor(private plugin: SecondBrainPlugin) {}

  async prepare(proposal: WeChatActionProposal, request: string, now = new Date()): Promise<WeChatPendingFileAction> {
    const adapter = this.plugin.app.vault.adapter;
    const changes = proposal.changes.map((change) => ({
      ...change,
      path: change.operation === 'mkdir' ? normalizeFolderPath(change.path) : normalizeVaultPath(change.path),
    })) as WeChatActionChange[];
    const paths = [...new Set(changes.map((change) => change.path))];
    const folderPaths = new Set(
      changes.filter((change) => change.operation === 'mkdir').map((change) => change.path),
    );
    const baselines: WeChatActionBaseline[] = [];
    for (const path of paths) {
      const exists = await adapter.exists(path);
      const content = exists && !folderPaths.has(path) ? await adapter.read(path) : '';
      baselines.push({ path, exists, sha256: sha256(content) });
    }
    for (const change of changes) {
      const baseline = baselines.find((item) => item.path === change.path)!;
      if (change.operation === 'mkdir') {
        if (baseline.exists) throw new Error(`目标文件夹已存在：${change.path}`);
        const parent = change.path.split('/').slice(0, -1).join('/');
        if (parent && !(await adapter.exists(parent))) {
          throw new Error(`父文件夹不存在：${parent}`);
        }
        continue;
      }
      if (change.operation === 'create' && baseline.exists) {
        throw new Error(`目标已存在，不能新建：${change.path}`);
      }
      if (change.operation !== 'create' && !baseline.exists) {
        throw new Error(`目标不存在，不能${change.operation === 'append' ? '追加' : '替换'}：${change.path}`);
      }
      if (change.operation === 'replace') {
        const content = await adapter.read(change.path);
        if (countOccurrences(content, change.oldText) !== 1) {
          throw new Error(`替换原文必须唯一匹配：${change.path}`);
        }
      }
    }

    const id = `QR-${createHash('sha256').update(`${now.getTime()}-${randomUUID()}`).digest('hex').slice(0, 6).toUpperCase()}`;
    return {
      ...proposal,
      changes,
      kind: 'files',
      id,
      request: request.slice(0, 12_000),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ACTION_TTL_MS).toISOString(),
      baselines,
    };
  }

  async apply(action: WeChatPendingFileAction, now = new Date()): Promise<WeChatActionApplyResult> {
    return serializeVaultOperation(this.plugin.app, 'wechat-apply', () => this.applyPrepared(action, now));
  }

  private async applyPrepared(action: WeChatPendingFileAction, now: Date): Promise<WeChatActionApplyResult> {
    if (Date.parse(action.expiresAt) <= now.getTime()) throw new Error('修改提案已经过期，请重新提出要求。');
    const adapter = this.plugin.app.vault.adapter;
    const beforeByPath = new Map<string, string>();
    for (const baseline of action.baselines) {
      const exists = await adapter.exists(baseline.path);
      const content = exists ? await adapter.read(baseline.path) : '';
      if (exists !== baseline.exists || sha256(content) !== baseline.sha256) {
        throw new Error(`目标在确认前已发生变化，已停止执行：${baseline.path}`);
      }
      beforeByPath.set(baseline.path, content);
    }

    const snapshotPath = `.second-brain/snapshots/${actionStamp(now)}-wechat-${action.id.toLowerCase()}`;
    await this.ensureFolder(snapshotPath);
    let index = 0;
    for (const baseline of action.baselines) {
      index++;
      if (baseline.exists) {
        await adapter.write(`${snapshotPath}/before-${String(index).padStart(2, '0')}.md`, beforeByPath.get(baseline.path) ?? '');
      }
    }
    await adapter.write(`${snapshotPath}/manifest.json`, JSON.stringify({
      version: 1,
      action,
      backups: action.baselines.map((baseline, backupIndex) => ({
        path: baseline.path,
        existed: baseline.exists,
        backup: baseline.exists ? `before-${String(backupIndex + 1).padStart(2, '0')}.md` : null,
      })),
    }, null, 2));

    const written = new Map<string, OwnedTextChange>();
    const attempted: OwnedTextChange[] = [];
    const write = async (path: string, after: string) => {
      const baseline = action.baselines.find((item) => item.path === path)!;
      const previous = written.get(path);
      const before = previous ? previous.after : baseline.exists ? beforeByPath.get(path)! : null;
      attempted.push({ path, before, after });
      await writeTextIfUnchanged(this.plugin.app, path, before, after);
      written.set(path, { path, before: previous ? previous.before : before, after });
    };
    try {
      for (const change of action.changes) {
        if (change.operation === 'mkdir') {
          if (await adapter.exists(change.path)) throw new Error(`目标已存在：${change.path}`);
          await adapter.mkdir(change.path);
          continue;
        }
        if (change.operation === 'create') {
          await this.ensureFolder(change.path.split('/').slice(0, -1).join('/'));
          if (await adapter.exists(change.path)) throw new Error(`目标已存在：${change.path}`);
          await write(change.path, change.content);
          continue;
        }
        const current = await adapter.read(change.path);
        if (change.operation === 'append') {
          const separator = current.endsWith('\n') || !current ? '' : '\n';
          await write(change.path, `${current}${separator}${change.content}`);
          continue;
        }
        if (countOccurrences(current, change.oldText) !== 1) {
          throw new Error(`执行时替换原文不再唯一：${change.path}`);
        }
        await write(change.path, current.replace(change.oldText, change.newText));
      }
    } catch (error) {
      const rollbackErrors = await rollbackOwnedChanges(this.plugin.app, attempted);
      if (rollbackErrors.length) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`${reason}；自动回滚存在异常：${rollbackErrors.join('；')}`);
      }
      throw error;
    }

    return { changedPaths: action.baselines.map((item) => item.path), snapshotPath };
  }

  private async ensureFolder(path: string): Promise<void> {
    if (!path) return;
    const adapter = this.plugin.app.vault.adapter;
    let current = '';
    for (const segment of path.split('/').filter(Boolean)) {
      current = current ? `${current}/${segment}` : segment;
      if (!(await adapter.exists(current))) await adapter.mkdir(current);
    }
  }
}

export class WeChatCollaborationService {
  private agent: CodexSessionService | null = null;
  private readonly actionExecutor: WeChatActionExecutor;

  constructor(
    private plugin: SecondBrainPlugin,
    private stateStore: WeChatStateStore,
  ) {
    this.actionExecutor = new WeChatActionExecutor(plugin);
  }

  cleanup(): void {
    this.agent?.cleanup();
    this.agent = null;
  }

  async startNewConversation(now = new Date()): Promise<string> {
    this.cleanup();
    const previousPreferences = await this.loadPreferences();
    if (previousPreferences.conversationId) {
      const previous = await this.plugin.getConversationById(previousPreferences.conversationId);
      if (previous?.title === '微信会话') {
        await this.plugin.renameConversation(
          previous.id,
          `微信会话归档 ${formatLocalTimestamp(now).slice(0, 16).replace('T', ' ')}`,
        );
      }
    }
    const conversation = await this.plugin.createConversation(undefined, BACKEND_CODEX, {
      forceLegacyStorage: true,
    });
    const title = '微信会话';
    await this.plugin.renameConversation(conversation.id, title);
    await this.stateStore.saveConversationPreferences({ ...previousPreferences, conversationId: conversation.id });
    await this.stateStore.clearPendingAction();
    await this.plugin.ensureWeChatConversationTab(conversation.id);
    return `已新建微信对话：${title}`;
  }

  async setMode(mode: WeChatCollaborationMode): Promise<string> {
    const preferences = await this.loadPreferences();
    await this.stateStore.saveConversationPreferences({ ...preferences, mode });
    return `已切换到${mode === 'fast' ? '快速' : '深度'}通道。`;
  }

  async getStatusText(): Promise<string> {
    const preferences = await this.loadPreferences();
    const conversation = preferences.conversationId
      ? await this.plugin.getConversationById(preferences.conversationId)
      : null;
    const pending = await this.loadActivePendingAction();
    return [
      `当前通道：${preferences.mode === 'fast' ? '快速' : '深度'}`,
      `当前会话：${conversation?.title ?? '尚未建立'}`,
      `消息数量：${conversation?.messages.length ?? 0}`,
      `待确认操作：${pending ? `${pending.id} · ${pending.title}` : '无'}`,
    ].join('\n');
  }

  getHelpText(): string {
    return [
      '微信协作支持自然对话、检索第二大脑、智能收录和受控修改。直接说需求即可，不必记固定格式。',
      '',
      '可选快捷方式：对话：你的问题 / 记录：你的内容',
      '切换通道：快速通道 / 深度通道',
      '管理会话：新对话 / 当前会话 / 对话摘要',
      '常用入口：管家简报 / 打开今天的日记 / 整理近期日志 / 分析现状',
      '问库方式：直接说“根据我的笔记……”或“在第二大脑里查……”',
      '安全写入：确认 / 取消（QR 编号仅用于核对）',
      '收件箱：消化这批 / 查看分流 / 确认归位',
    ].join('\n');
  }

  async cancelPendingAction(): Promise<string> {
    const pending = await this.loadActivePendingAction();
    await this.stateStore.clearPendingAction();
    return pending ? `已取消 ${pending.id}，没有修改任何笔记。` : '当前没有待确认操作。';
  }

  async confirmPendingAction(id?: string, now = new Date()): Promise<string> {
    const pending = await this.loadActivePendingAction();
    if (!pending) throw new Error('没有待确认操作，或原提案已经过期。');
    if (id && pending.id !== id.toUpperCase()) throw new Error(`确认编号不一致。当前编号是 ${pending.id}。`);
    let reply: string;
    if (pending.kind === 'custom-instructions') {
      const current = this.plugin.settings.systemPrompt?.trim() ?? '';
      if (sha256(current) !== pending.baselineSha256) {
        throw new Error('自定义指令在确认前已发生变化，已停止执行。');
      }
      const previous = this.plugin.settings.systemPrompt;
      try {
        this.plugin.settings.systemPrompt = pending.content;
        await this.plugin.saveSettings();
        for (const view of this.plugin.getAllViews()) view.refreshCustomInstructionsButton();
      } catch (error) {
        this.plugin.settings.systemPrompt = previous;
        throw error;
      }
      reply = `已完成 ${pending.id}：自定义指令已${pending.content ? '更新' : '清空'}，从下一次提问开始生效。`;
    } else {
      const result = await this.actionExecutor.apply(pending, now);
      reply = [
        `已完成 ${pending.id}：${pending.title}`,
        `修改文件：${result.changedPaths.length}`,
        ...result.changedPaths.map((path) => `- ${path}`),
        `回滚点：${result.snapshotPath}`,
      ].join('\n');
    }
    await this.stateStore.clearPendingAction();
    return reply;
  }

  async openTodayNote(): Promise<string> {
    const path = await this.plugin.openTodayNote();
    if (!path) throw new Error('未能确定今日日记路径，请确认 Obsidian 核心插件“每日笔记”已启用。');
    return `已按电脑端相同的每日笔记配置打开或创建：\n${path}`;
  }

  async runChat(
    request: string,
    attachmentPaths: string[] = [],
    now = new Date(),
    options: WeChatRunChatOptions = {},
  ): Promise<WeChatChatResult> {
    const preferences = await this.loadPreferences();
    const conversation = await this.ensureConversation(preferences, now);
    const agent = this.getAgent();
    agent.setSessionId(conversation.sessionId);

    const textChunks: string[] = [];
    const errors: string[] = [];
    let usage: UsageInfo | undefined;
    let timedOut = false;
    const timeoutMs = preferences.mode === 'deep' ? 240_000 : 120_000;
    const timer = setTimeout(() => {
      timedOut = true;
      agent.cancel();
    }, timeoutMs);

    const commandResolution = resolveConversationCommand(request, this.plugin.settings.slashCommands);
    if (commandResolution?.blockedMessage) throw new Error(commandResolution.blockedMessage);
    let resolvedRequest = commandResolution?.prompt ?? request;
    const longTermMemory = await this.plugin.llmWikiService.buildContext(request);
    if (longTermMemory) resolvedRequest = `${resolvedRequest}\n\n${longTermMemory}`;

    try {
      let historySource = conversation.messages;
      if (options.excludeLatestInboundFromHistory) {
        let latestInboundIndex = -1;
        for (let index = conversation.messages.length - 1; index >= 0; index--) {
          if (conversation.messages[index].role === 'user') {
            latestInboundIndex = index;
            break;
          }
        }
        if (latestInboundIndex >= 0) historySource = conversation.messages.slice(0, latestInboundIndex);
      }
      const history = historySource.slice(-HISTORY_FALLBACK_MESSAGES);
      for await (const chunk of agent.query(
        buildWechatPrompt(resolvedRequest, attachmentPaths, now),
        undefined,
        history,
        {
          ...commandResolution?.queryOptions,
          performanceMode: preferences.mode,
          historySourcePath: historySourcePath(conversation.id),
          sandboxMode: 'read-only',
          additionalDeveloperInstructions: this.plugin.settings.wechatAdditionalInstructions,
        },
      )) {
        if (chunk.type === 'text' && chunk.content.trim()) textChunks.push(chunk.content.trim());
        if (chunk.type === 'error' || chunk.type === 'blocked') errors.push(chunk.content);
        if (chunk.type === 'usage') usage = chunk.usage;
      }
    } finally {
      clearTimeout(timer);
    }

    if (timedOut) throw new Error(`${preferences.mode === 'fast' ? '快速' : '深度'}通道响应超时，请稍后重试。`);
    const rawReply = textChunks.join('\n\n').trim();
    if (!rawReply) throw new Error(errors[0] || '模型没有返回可用内容。');

    const customInstructions = extractCustomInstructionsProposal(rawReply);
    const capture = extractWeChatCaptureDecision(customInstructions.cleanedText);
    const extracted = extractWeChatAction(capture.cleanedText);
    const replies: string[] = [normalizeVaultNoteLinks(extracted.reply || '已完成分析。', this.plugin.app)];
    let pendingAction: WeChatPendingAction | undefined;
    if (extracted.error) replies.push(extracted.error);
    if (customInstructions.proposal && extracted.proposal) {
      replies.push('本次同时包含笔记修改和自定义指令修改。为避免混合确认，本次不会生成操作，请拆成两次提出。');
    } else if (customInstructions.proposal) {
      try {
        pendingAction = this.prepareCustomInstructionsAction(customInstructions.proposal, request, now);
        await this.stateStore.savePendingAction(pendingAction);
        replies.push(...formatPendingActionReplies(pendingAction));
      } catch (error) {
        replies.push(`自定义指令提案未通过校验：${error instanceof Error ? error.message : String(error)}。没有修改设置。`);
      }
    } else if (extracted.proposal) {
      try {
        pendingAction = await this.actionExecutor.prepare(extracted.proposal, request, new Date());
        await this.stateStore.savePendingAction(pendingAction);
        replies.push(...formatPendingActionReplies(pendingAction));
      } catch (error) {
        replies.push(`修改提案未通过校验：${error instanceof Error ? error.message : String(error)}。没有修改任何笔记。`);
      }
    }

    await this.plugin.updateConversation(conversation.id, {
      sessionId: agent.getSessionId(),
      lastResponseAt: Date.now(),
      usage,
    });
    return {
      replies,
      mode: preferences.mode,
      captureRequested: capture.shouldCapture && !customInstructions.proposal && !extracted.proposal,
      pendingAction,
    };
  }

  async summarize(now = new Date(), options: WeChatRunChatOptions = {}): Promise<WeChatChatResult> {
    return this.runChat(
      '请总结当前微信会话：已确认事实、未解决问题、待确认操作和下一步。不要修改笔记。',
      [],
      now,
      options,
    );
  }

  private async ensureConversation(
    preferences: WeChatConversationPreferences,
    now: Date,
  ): Promise<Conversation> {
    if (preferences.conversationId) {
      const existing = await this.plugin.getConversationById(preferences.conversationId);
      if (existing) {
        if (existing.isNative) await this.plugin.persistConversationMessagesInPlugin(existing.id);
        if (existing.title !== '微信会话') await this.plugin.renameConversation(existing.id, '微信会话');
        await this.plugin.ensureWeChatConversationTab(existing.id);
        return existing;
      }
    }
    await this.startNewConversation(now);
    const next = await this.loadPreferences();
    const created = next.conversationId ? await this.plugin.getConversationById(next.conversationId) : null;
    if (!created) throw new Error('无法创建微信协作会话。');
    return created;
  }

  private getAgent(): CodexSessionService {
    if (!this.agent) this.agent = new CodexSessionService(this.plugin, this.plugin.mcpManager);
    return this.agent;
  }

  private async loadPreferences(): Promise<WeChatConversationPreferences> {
    return (await this.stateStore.loadConversationPreferences()) ?? {
      mode: this.plugin.settings.wechatDefaultPerformanceMode ?? 'fast',
    };
  }

  private async loadActivePendingAction(): Promise<WeChatPendingAction | null> {
    const pending = await this.stateStore.loadPendingAction();
    if (!pending) return null;
    if (Date.parse(pending.expiresAt) > Date.now()) return pending;
    await this.stateStore.clearPendingAction();
    return null;
  }

  private createMessage(role: ChatMessage['role'], content: string, now: Date): ChatMessage {
    return { id: `wechat-${randomUUID()}`, role, content, timestamp: now.getTime() };
  }

  async recordInbound(content: string, now = new Date()): Promise<void> {
    const preferences = await this.loadPreferences();
    const conversation = await this.ensureConversation(preferences, now);
    await this.plugin.updateConversation(conversation.id, {
      messages: [
        ...conversation.messages,
        this.createMessage('user', content, now),
      ],
    });
    await this.plugin.syncConversationViews(conversation.id);
  }

  async recordAssistant(content: string, now = new Date()): Promise<void> {
    const preferences = await this.loadPreferences();
    const conversation = await this.ensureConversation(preferences, now);
    await this.plugin.updateConversation(conversation.id, {
      messages: [
        ...conversation.messages,
        this.createMessage('assistant', content, now),
      ],
      lastResponseAt: now.getTime(),
    });
    await this.plugin.syncConversationViews(conversation.id);
  }

  private prepareCustomInstructionsAction(
    proposal: { operation: CustomInstructionsOperation; content: string },
    request: string,
    now: Date,
  ): WeChatPendingCustomInstructionsAction {
    const previousContent = this.plugin.settings.systemPrompt?.trim() ?? '';
    const nextContent = proposal.operation === 'append'
      ? appendMarkdownSnippet(previousContent, proposal.content)
      : proposal.operation === 'replace'
        ? proposal.content.trim()
        : '';
    if (nextContent.length > MAX_CUSTOM_INSTRUCTIONS_LENGTH) {
      throw new Error(`修改后超过 ${MAX_CUSTOM_INSTRUCTIONS_LENGTH.toLocaleString('zh-CN')} 字`);
    }
    if (nextContent === previousContent) throw new Error('修改前后内容相同');
    const id = `QR-${createHash('sha256').update(`${now.getTime()}-${randomUUID()}`).digest('hex').slice(0, 6).toUpperCase()}`;
    return {
      kind: 'custom-instructions',
      id,
      title: '更新插件自定义指令',
      summary: `将${proposal.operation === 'append' ? '追加' : proposal.operation === 'replace' ? '替换' : '清空'}插件自定义指令。`,
      request: request.slice(0, 12_000),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ACTION_TTL_MS).toISOString(),
      operation: proposal.operation,
      content: nextContent,
      previousContent,
      baselineSha256: sha256(previousContent),
    };
  }
}

export function formatPendingActionReplies(action: WeChatPendingAction): string[] {
  const scope = action.kind === 'files'
    ? `涉及 ${action.baselines.length} 个文件`
    : '涉及插件自定义指令';
  return [
    [
      `待确认操作 ${action.id}`,
      action.summary,
      `${scope}，有效期 30 分钟。`,
      '执行请回复：确认',
      '放弃请回复：取消',
    ].join('\n'),
  ];
}

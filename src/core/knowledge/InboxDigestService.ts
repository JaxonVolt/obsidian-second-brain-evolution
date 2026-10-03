/* eslint-disable simple-import-sort/imports */
import { spawn } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import * as readline from 'readline';
import type { App } from 'obsidian';

import type SecondBrainPlugin from '../../main';
import { getEnhancedPath, parseEnvironmentVariables } from '../../utils/env';
import { getVaultPath } from '../../utils/path';
import { buildCodexRuntimeProfile, getModelProviderRuntimeEnvironment } from '../model';
import {
  RAW_INBOX_DIR,
  formatLocalTimestamp,
  parseDailyRawInboxEntries,
  sourcePathToWikiTarget,
} from './InboxCaptureService';
import { SECOND_BRAIN_PATHS } from './SecondBrainInitializer';
import { ActionWorkbenchService } from './ActionWorkbenchService';
import { resolveDailyNote } from './DailyNotePath';
import { commitStagedWrites, serializeVaultOperation, stageVaultWrites } from './VaultMutation';

export type RoutingCategory =
  | 'daily'
  | 'reflection'
  | 'next-action'
  | 'project'
  | 'source'
  | 'permanent'
  | 'output'
  | 'archive'
  | 'retain'
  | 'inbox';

export interface RoutingProposal {
  id: string;
  sourcePath: string;
  category: RoutingCategory;
  title: string;
  content: string;
  rationale: string;
  confidence: number;
  selected: boolean;
  sourceSignature?: string;
}

interface CaptureSource {
  path: string;
  content: string;
  signature?: string;
}

interface RoutingLedger {
  version: 1;
  processedSources: Record<string, { processedAt: string; outputs: string[] }>;
}

export interface ApplyResult {
  created: string[];
  updated: string[];
  reused: string[];
  retained: string[];
  processedSources: string[];
  snapshotPath: string;
}

type RoutingChangeAction = 'create' | 'append' | 'reuse' | 'retain';

interface RoutingChange {
  action: RoutingChangeAction;
  path: string;
  before?: string;
}

export const ROUTING_CATEGORIES: ReadonlyArray<{ value: RoutingCategory; label: string }> = [
  { value: 'daily', label: '今日日记' },
  { value: 'reflection', label: '心智复盘' },
  { value: 'next-action', label: '下一步行动' },
  { value: 'project', label: '活跃项目' },
  { value: 'source', label: '来源资料' },
  { value: 'permanent', label: '永久笔记候选' },
  { value: 'output', label: '输出与作品' },
  { value: 'archive', label: '归档' },
  { value: 'retain', label: '仅留原始记录' },
  { value: 'inbox', label: '暂留收件箱' },
];

const LEDGER_PATH = '.second-brain/runtime/routing-ledger.json';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function clampConfidence(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return 0.5;
  return Math.max(0, Math.min(1, number));
}

function isRoutingCategory(value: unknown): value is RoutingCategory {
  return ROUTING_CATEGORIES.some((option) => option.value === value);
}

export function extractRoutingJson(text: string, sourcePaths: ReadonlySet<string>): RoutingProposal[] {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = (fenced ?? text).trim();
  const start = candidate.indexOf('[');
  const end = candidate.lastIndexOf(']');
  if (start < 0 || end <= start) {
    throw new Error('Codex 没有返回可识别的分流建议。');
  }

  const parsed: unknown = JSON.parse(candidate.slice(start, end + 1));
  if (!Array.isArray(parsed)) {
    throw new Error('分流建议格式不正确。');
  }

  const proposals: RoutingProposal[] = [];
  for (const [index, item] of parsed.entries()) {
    if (!isRecord(item)) continue;
    const sourcePath = typeof item.sourcePath === 'string' ? item.sourcePath.trim() : '';
    const category = isRoutingCategory(item.category) ? item.category : 'inbox';
    const title = typeof item.title === 'string' ? item.title.trim() : '';
    const content = typeof item.content === 'string' ? item.content.trim() : '';
    if (!sourcePaths.has(sourcePath) || !title || !content) continue;

    proposals.push({
      id: `${index}-${sourcePath}`,
      sourcePath,
      category,
      title,
      content,
      rationale: typeof item.rationale === 'string' ? item.rationale.trim() : '',
      confidence: clampConfidence(item.confidence),
      selected: category !== 'inbox',
    });
  }

  if (proposals.length === 0) {
    throw new Error('没有得到有效的分流建议。');
  }
  return proposals;
}

function sanitizeFileName(value: string): string {
  const cleaned = value
    .replace(/[\\/:*?"<>|#^[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  return cleaned.slice(0, 80) || '未命名';
}

export function hasMeaningfulSourceContent(value: string): boolean {
  const descriptiveText = value
    .replace(/\[\[[^\]]+\]\]/gu, ' ')
    .replace(/https?:\/\/\S+/giu, ' ')
    .replace(/(?:微信)?附件|图片|文件|链接|来源|待消化|素材/gu, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, '');
  return descriptiveText.length >= 12;
}

function dateStamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function snapshotStamp(date: Date): string {
  return formatLocalTimestamp(date).replace(/[-:T]/g, '').slice(0, 14);
}

export class InboxDigestService {
  constructor(private app: App, private plugin: SecondBrainPlugin) {}

  async analyze(maxSources = 15): Promise<RoutingProposal[]> {
    const sources = await this.loadPendingSources(maxSources);
    if (sources.length === 0) {
      return [];
    }

    const response = await this.askCodex(this.buildPrompt(sources));
    const signatures = new Map(sources.map((source) => [source.path, source.signature]));
    return extractRoutingJson(response, new Set(sources.map((source) => source.path)))
      .map((proposal) => ({ ...proposal, sourceSignature: signatures.get(proposal.sourcePath) }));
  }

  async apply(proposals: RoutingProposal[], now = new Date()): Promise<ApplyResult> {
    return serializeVaultOperation(this.app, 'inbox-digest', async () => {
      const verifySources = async () => {
        for (const proposal of proposals.filter((item) => item.selected && item.sourceSignature)) {
          const path = proposal.sourcePath.split('#')[0];
          const text = await this.app.vault.adapter.read(path);
          const content = proposal.sourcePath.includes('#')
            ? parseDailyRawInboxEntries(path, text).find((entry) => entry.sourcePath === proposal.sourcePath)?.content
            : text;
          if (content === undefined || createHash('sha256').update(content).digest('hex') !== proposal.sourceSignature) {
            throw new Error(`来源在分析后已变化，请重新生成建议：${proposal.sourcePath}`);
          }
        }
      };
      await verifySources();
      const staged = stageVaultWrites(this.app);
      const result = await new InboxDigestService(staged.app, this.plugin).applyPrepared(proposals, now);
      await verifySources();
      await commitStagedWrites(this.app, staged, result.snapshotPath);
      this.plugin.actionWorkbenchService?.invalidate();
      return result;
    });
  }

  private async applyPrepared(proposals: RoutingProposal[], now: Date): Promise<ApplyResult> {
    const selected = proposals.filter((proposal) => proposal.selected && proposal.category !== 'inbox');
    if (selected.length === 0) {
      throw new Error('请至少选择一条需要归位的建议。');
    }

    const adapter = this.app.vault.adapter;
    const snapshotPath = `.second-brain/snapshots/${snapshotStamp(now)}-inbox-routing-${randomUUID().slice(0, 8)}`;
    await this.ensureFolder(snapshotPath);

    const created: string[] = [];
    const updated: string[] = [];
    const reused: string[] = [];
    const retained: string[] = [];
    const outputsBySource = new Map<string, string[]>();
    const manifest: RoutingChange[] = [];

    for (const proposal of selected) {
      const output = await this.applyProposal(proposal, now, manifest);
      if (output.action === 'create') created.push(output.path);
      else if (output.action === 'append') updated.push(output.path);
      else if (output.action === 'reuse') reused.push(output.path);
      else retained.push(output.path);
      const sourceOutputs = outputsBySource.get(proposal.sourcePath) ?? [];
      sourceOutputs.push(output.path);
      outputsBySource.set(proposal.sourcePath, sourceOutputs);
    }

    await adapter.write(`${snapshotPath}/routing-manifest.json`, JSON.stringify({
      createdAt: formatLocalTimestamp(now),
      proposals: selected,
      changes: manifest,
    }, null, 2));

    const ledger = await this.loadLedger();
    const processedSources: string[] = [];
    const grouped = new Map<string, RoutingProposal[]>();
    for (const proposal of proposals) {
      const group = grouped.get(proposal.sourcePath) ?? [];
      group.push(proposal);
      grouped.set(proposal.sourcePath, group);
    }

    for (const [sourcePath, group] of grouped) {
      if (!group.every((proposal) => proposal.selected && proposal.category !== 'inbox')) continue;
      const outputs = outputsBySource.get(sourcePath) ?? [];
      ledger.processedSources[sourcePath] = {
        processedAt: formatLocalTimestamp(now),
        outputs,
      };
      processedSources.push(sourcePath);
    }
    await this.ensureFolder('.second-brain/runtime');
    await adapter.write(LEDGER_PATH, JSON.stringify(ledger, null, 2));

    return { created, updated, reused, retained, processedSources, snapshotPath };
  }

  private async loadPendingSources(maxSources: number): Promise<CaptureSource[]> {
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(RAW_INBOX_DIR))) return [];

    const ledger = await this.loadLedger();
    const files = (await this.listMarkdownFiles(RAW_INBOX_DIR))
      .filter((path) => !path.endsWith('/README.md'))
      .sort();
    const candidates: CaptureSource[] = [];
    for (const path of files) {
      const content = await adapter.read(path);
      if (!content.trim()) continue;
      const entries = parseDailyRawInboxEntries(path, content);
      if (entries.length > 0) {
        candidates.push(...entries.map((entry) => ({ path: entry.sourcePath, content: entry.content })));
      } else {
        candidates.push({ path, content });
      }
    }

    const sourceLimit = Math.max(1, Math.min(15, maxSources));
    const sources: CaptureSource[] = [];
    let totalLength = 0;
    for (const candidate of candidates) {
      if (sources.length >= sourceLimit) break;
      if (ledger.processedSources[candidate.path]) continue;
      const { path, content } = candidate;
      if (!content.trim()) continue;
      if (this.isRemoteControlCapture(content)) continue;
      if (totalLength + content.length > 20000 && sources.length > 0) break;
      const excerpt = content.slice(0, 8000);
      sources.push({ path, content: excerpt, signature: createHash('sha256').update(content).digest('hex') });
      totalLength += excerpt.length;
    }
    return sources;
  }

  private async listMarkdownFiles(folder: string): Promise<string[]> {
    const listing = await this.app.vault.adapter.list(folder);
    const files = listing.files.filter((path) => path.endsWith('.md'));
    for (const child of listing.folders) {
      files.push(...await this.listMarkdownFiles(child));
    }
    return files;
  }

  private isRemoteControlCapture(content: string): boolean {
    const body = content
      .replace(/^---[\s\S]*?---\s*/u, '')
      .replace(/^# 原始输入\s*/u, '')
      .trim()
      .replace(/[。！!]+$/u, '')
      .trim();
    return /^(?:重新)?消化(?:这批|收件箱)?$/u.test(body)
      || /^(?:确认归位|取消归位|放弃本批|查看分流|查看建议|当前建议)(?:\s+[A-Za-z0-9-]+)?$/u.test(body);
  }

  private async loadLedger(): Promise<RoutingLedger> {
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(LEDGER_PATH))) {
      return { version: 1, processedSources: {} };
    }
    try {
      const parsed: unknown = JSON.parse(await adapter.read(LEDGER_PATH));
      if (isRecord(parsed) && isRecord(parsed.processedSources)) {
        return { version: 1, processedSources: parsed.processedSources as RoutingLedger['processedSources'] };
      }
    } catch {
      // A malformed ledger should not make the inbox inaccessible.
    }
    return { version: 1, processedSources: {} };
  }

  private buildPrompt(sources: CaptureSource[]): string {
    const sourceText = sources.map((source) => `\n<source path="${source.path}">\n${source.content}\n</source>`).join('\n');
    return `你是个人第二大脑的收件箱分流器。只分析下面提供的原始输入，不读取文件、不调用工具、不修改任何内容。\n\n只根据输入中明确出现的目标、项目、领域和约束进行判断。不得推断用户的姓名、年龄、职业、单位、性格、健康状况或价值观，也不得把单次情绪固化为长期画像。\n\n你可以把一份混合输入拆成多条建议。category 只能是 daily、reflection、next-action、project、source、permanent、output、archive、retain、inbox。判断规则：\n- daily：当天事实或简短日记，值得附加到今日日记。\n- reflection：情绪、关系、心智复盘；不要将单次情绪固化为人格。\n- next-action：可以直接执行的单步动作。\n- project：需要多步完成且有明确结果。\n- source：主题明确，并且原文已经说明内容、保留用途或后续处理目标的外部资料。只有附件链接、网址或无法识别用途的素材不得归为 source。\n- permanent：跨事件可复用、条件清楚的稳定判断候选。\n- output：准备公开或交付的成品。\n- archive：已经结束且需要形成独立归档记录。\n- retain：不值得生成新笔记，但需要保留原始证据；单独出现且用途不明的图片、文件或链接优先使用 retain。\n- inbox：信息不足且仍需用户补充、稍后重新判断。\n\n严格只返回 JSON 数组，不要 Markdown，不要解释。每项字段：sourcePath、category、title、content、rationale、confidence。content 必须保留事实，不可编造；confidence 为 0 到 1。\n\n原始输入：${sourceText}`;
  }

  private async askCodex(prompt: string): Promise<string> {
    const codexPath = this.plugin.getResolvedCodexCliPath();
    const vaultPath = getVaultPath(this.app);
    if (!codexPath || !vaultPath) {
      throw new Error('未找到 Codex CLI，请先在插件设置中确认运行路径。');
    }

    const runtimeProfile = buildCodexRuntimeProfile(this.plugin.settings, 'fast');
    const customEnv = parseEnvironmentVariables(this.plugin.getActiveEnvironmentVariables());
    const providerEnv = getModelProviderRuntimeEnvironment(
      this.plugin.settings,
      this.app.secretStorage,
    );
    const env = {
      ...process.env,
      ...customEnv,
      ...providerEnv,
      PATH: getEnhancedPath(customEnv.PATH, codexPath),
    };
    const args = [
      ...runtimeProfile.rootArgs,
      '-s', 'read-only', '-C', vaultPath,
      'exec', '--model', runtimeProfile.model,
      ...runtimeProfile.execConfigArgs,
      '--skip-git-repo-check', '--json', '-',
    ];

    return new Promise<string>((resolve, reject) => {
      const child = spawn(codexPath, args, { cwd: vaultPath, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      const stdout = readline.createInterface({ input: child.stdout });
      const stderr: string[] = [];
      const messages: string[] = [];
      const timeout = window.setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error('分流分析超时，请减少本次收件箱数量后重试。'));
      }, 120000);

      child.stderr.on('data', (chunk) => stderr.push(String(chunk)));
      stdout.on('line', (line) => {
        try {
          const event: unknown = JSON.parse(line);
          if (!isRecord(event) || event.type !== 'item.completed' || !isRecord(event.item)) return;
          if (event.item.type === 'agent_message' && typeof event.item.text === 'string') {
            messages.push(event.item.text);
          }
        } catch {
          // Ignore non-JSON progress output.
        }
      });
      child.once('error', (error) => {
        window.clearTimeout(timeout);
        reject(error);
      });
      child.once('close', (code) => {
        window.clearTimeout(timeout);
        stdout.close();
        if (code !== 0) {
          reject(new Error(stderr.join('').trim() || `Codex 退出码：${code}`));
          return;
        }
        const response = messages.join('\n').trim();
        if (!response) {
          reject(new Error('Codex 没有返回分流结果。'));
          return;
        }
        resolve(response);
      });
      child.stdin.end(prompt);
    });
  }

  private async applyProposal(
    proposal: RoutingProposal,
    now: Date,
    manifest: RoutingChange[],
  ): Promise<{ action: RoutingChangeAction; path: string }> {
    const sourceTarget = sourcePathToWikiTarget(proposal.sourcePath);
    if (proposal.category === 'retain') {
      manifest.push({ action: 'retain', path: proposal.sourcePath });
      return { action: 'retain', path: proposal.sourcePath };
    }
    if (proposal.category === 'inbox') {
      throw new Error('暂留收件箱的内容不会执行归位。');
    }
    if (proposal.category === 'daily') {
      const { path, initial } = await resolveDailyNote(this.app, now);
      const key = createHash('sha256').update(`${proposal.sourcePath}\n${proposal.category}\n${proposal.content}`).digest('hex').slice(0, 24);
      const marker = `%% inbox-route:${key} %%`;
      const adapter = this.app.vault.adapter;
      const exists = await adapter.exists(path);
      const before = exists ? await adapter.read(path) : initial;
      if (before.includes(marker)) return { action: 'reuse', path };
      await this.ensureFolder(path.slice(0, path.lastIndexOf('/')));
      await adapter.write(path, `${before}\n\n## 收件箱归位\n\n${proposal.content}\n\n> 来源：[[${sourceTarget}]]\n${marker}\n`);
      manifest.push(exists ? { action: 'append', path, before } : { action: 'create', path });
      return { action: exists ? 'append' : 'create', path };
    }
    if (proposal.category === 'next-action') {
      const id = `A-inbox-${createHash('sha256').update(`${proposal.sourcePath}\n${proposal.content}`).digest('hex').slice(0, 20)}`;
      const service = new ActionWorkbenchService(this.app);
      const existing = await service.getAction(id);
      if (existing) return { action: 'reuse', path: existing.path };
      const action = await service.createAction({ id, title: proposal.content, status: 'inbox', sourcePath: proposal.sourcePath, note: proposal.rationale }, now);
      manifest.push({ action: 'create', path: action.path });
      return { action: 'create', path: action.path };
    }

    const title = sanitizeFileName(proposal.title);
    const folder = this.getDestinationFolder(proposal.category, title);
    await this.ensureFolder(folder);
    if (proposal.category === 'source' && !hasMeaningfulSourceContent(proposal.content)) {
      throw new Error(`“${proposal.title}”只有附件或链接，没有足够的摘要和用途。请选择“仅留原始记录”，或补充内容后再归为来源资料。`);
    }
    const sourcePath = sourceTarget;
    const note = proposal.category === 'source'
      ? `---\ntype: source\nstatus: pending\ncreated: ${formatLocalTimestamp(now)}\nsource_note: "[[${sourcePath}]]"\n---\n\n# ${title}\n\n- 原始记录：[[${sourcePath}]]\n- 获取日期：${dateStamp(now)}\n- 当前状态：待消化\n\n## 内容摘要\n\n${proposal.content}\n\n## 保留用途\n\n${proposal.rationale || '等待进一步说明。'}\n\n## 下一步\n\n- [ ] 阅读或核实后，决定归入领域、永久笔记、行动或删除。\n`
      : `---\ntype: ${proposal.category}\nstatus: active\ncreated: ${formatLocalTimestamp(now)}\nsource_note: "[[${sourcePath}]]"\n---\n\n# ${title}\n\n${proposal.content}\n\n## 分流依据\n\n${proposal.rationale || '由收件箱分流确认生成。'}\n`;
    const existingPath = await this.findEquivalentRoutedNote(folder, title, sourcePath, proposal.content);
    if (existingPath) {
      manifest.push({ action: 'reuse', path: existingPath });
      return { action: 'reuse', path: existingPath };
    }
    const path = await this.uniquePath(`${folder}/${title}.md`);
    await this.app.vault.adapter.write(path, note);
    manifest.push({ action: 'create', path });
    return { action: 'create', path };
  }

  private getDestinationFolder(
    category: Exclude<RoutingCategory, 'daily' | 'next-action' | 'retain' | 'inbox'>,
    title: string,
  ): string {
    switch (category) {
      case 'reflection': return SECOND_BRAIN_PATHS.reflections;
      case 'project': return `${SECOND_BRAIN_PATHS.activeProjects}/${title}`;
      case 'source': return SECOND_BRAIN_PATHS.sourceInbox;
      case 'permanent': return SECOND_BRAIN_PATHS.permanentNotes;
      case 'output': return SECOND_BRAIN_PATHS.outputs;
      case 'archive': return SECOND_BRAIN_PATHS.archive;
    }
  }

  private async appendToNote(
    path: string,
    addition: string,
    manifest: RoutingChange[],
  ): Promise<{ action: 'create' | 'append'; path: string }> {
    const adapter = this.app.vault.adapter;
    const exists = await adapter.exists(path);
    const before = exists ? await adapter.read(path) : '';
    await this.ensureFolder(path.slice(0, path.lastIndexOf('/')));
    await adapter.write(path, before + addition);
    manifest.push(exists ? { action: 'append', path, before } : { action: 'create', path });
    return { action: exists ? 'append' : 'create', path };
  }

  private async findEquivalentRoutedNote(
    folder: string,
    title: string,
    sourcePath: string,
    content: string,
  ): Promise<string | null> {
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(folder))) return null;
    const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const candidatePattern = new RegExp(`^${escapedTitle}(?: \\d+)?\\.md$`, 'u');
    const listing = await adapter.list(folder);
    const candidates = listing.files
      .filter((path) => candidatePattern.test(path.slice(path.lastIndexOf('/') + 1)))
      .sort((left, right) => left.localeCompare(right, 'zh-CN'));

    for (const path of candidates) {
      const existing = await adapter.read(path);
      if (isEquivalentRoutedNote(existing, title, sourcePath, content)) return path;
    }
    return null;
  }

  private async uniquePath(path: string): Promise<string> {
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(path))) return path;
    const base = path.replace(/\.md$/i, '');
    for (let index = 2; index < 1000; index++) {
      const candidate = `${base} ${index}.md`;
      if (!(await adapter.exists(candidate))) return candidate;
    }
    throw new Error(`无法为“${path}”生成唯一文件名。`);
  }

  private async ensureFolder(path: string): Promise<void> {
    const adapter = this.app.vault.adapter;
    const parts = path.split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!(await adapter.exists(current))) await adapter.mkdir(current);
    }
  }
}

export function isEquivalentRoutedNote(
  note: string,
  title: string,
  sourcePath: string,
  content: string,
): boolean {
  const normalized = note.replace(/\r\n/g, '\n');
  const frontmatter = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)/u)?.[1] ?? '';
  const sourceMatch = frontmatter.match(/^source_note:\s*["']?\[\[([^\]]+)\]\]["']?\s*$/mu)?.[1]?.trim();
  if (sourceMatch !== sourcePath.trim()) return false;

  const body = normalized.replace(/^---\n[\s\S]*?\n---\s*/u, '');
  const headingMatch = body.match(/^#\s+(.+?)\s*\n/u);
  if (headingMatch?.[1]?.trim() !== title.trim()) return false;
  const withoutHeading = body.slice(headingMatch[0].length);
  const routedContent = withoutHeading.split(/^##\s+分流依据\s*$/mu, 1)[0].trim();
  return routedContent === content.replace(/\r\n/g, '\n').trim();
}

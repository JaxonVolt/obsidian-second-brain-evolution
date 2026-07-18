/* eslint-disable simple-import-sort/imports */
import { spawn } from 'child_process';
import * as readline from 'readline';
import type { App } from 'obsidian';

import type SecondBrainPlugin from '../../main';
import { getEnhancedPath, parseEnvironmentVariables } from '../../utils/env';
import { getVaultPath } from '../../utils/path';
import { buildCodexRuntimeProfile, getModelProviderRuntimeEnvironment } from '../model';
import { RAW_INBOX_DIR, formatLocalTimestamp } from './InboxCaptureService';
import { SECOND_BRAIN_PATHS } from './SecondBrainInitializer';

export type RoutingCategory =
  | 'daily'
  | 'reflection'
  | 'next-action'
  | 'project'
  | 'source'
  | 'permanent'
  | 'output'
  | 'archive'
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
}

interface CaptureSource {
  path: string;
  content: string;
}

interface RoutingLedger {
  version: 1;
  processedSources: Record<string, { processedAt: string; outputs: string[] }>;
}

export interface ApplyResult {
  created: string[];
  updated: string[];
  processedSources: string[];
  snapshotPath: string;
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

function dateStamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function snapshotStamp(date: Date): string {
  return formatLocalTimestamp(date).replace(/[-:T]/g, '').slice(0, 14);
}

export class InboxDigestService {
  constructor(private app: App, private plugin: SecondBrainPlugin) {}

  async analyze(maxSources = 30): Promise<RoutingProposal[]> {
    const sources = await this.loadPendingSources(maxSources);
    if (sources.length === 0) {
      return [];
    }

    const response = await this.askCodex(this.buildPrompt(sources));
    return extractRoutingJson(response, new Set(sources.map((source) => source.path)));
  }

  async apply(proposals: RoutingProposal[], now = new Date()): Promise<ApplyResult> {
    const selected = proposals.filter((proposal) => proposal.selected && proposal.category !== 'inbox');
    if (selected.length === 0) {
      throw new Error('请至少选择一条需要归位的建议。');
    }

    const adapter = this.app.vault.adapter;
    const snapshotPath = `.second-brain/snapshots/${snapshotStamp(now)}-inbox-routing`;
    await this.ensureFolder(snapshotPath);

    const created: string[] = [];
    const updated: string[] = [];
    const outputsBySource = new Map<string, string[]>();
    const manifest: Array<{ action: 'create' | 'append'; path: string; before?: string }> = [];

    for (const proposal of selected) {
      const output = await this.applyProposal(proposal, now, manifest);
      (output.action === 'create' ? created : updated).push(output.path);
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

    return { created, updated, processedSources, snapshotPath };
  }

  private async loadPendingSources(maxSources: number): Promise<CaptureSource[]> {
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(RAW_INBOX_DIR))) return [];

    const ledger = await this.loadLedger();
    const listing = await adapter.list(RAW_INBOX_DIR);
    const files = listing.files
      .filter((path) => path.endsWith('.md') && !path.endsWith('/README.md'))
      .filter((path) => !ledger.processedSources[path])
      .sort()
      .slice(0, Math.max(1, Math.min(30, maxSources)));

    const sources: CaptureSource[] = [];
    let totalLength = 0;
    for (const path of files) {
      const content = await adapter.read(path);
      if (!content.trim()) continue;
      if (this.isRemoteControlCapture(content)) continue;
      if (totalLength + content.length > 60000 && sources.length > 0) break;
      sources.push({ path, content: content.slice(0, 12000) });
      totalLength += content.length;
    }
    return sources;
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
    return `你是个人第二大脑的收件箱分流器。只分析下面提供的原始输入，不读取文件、不调用工具、不修改任何内容。\n\n只根据输入中明确出现的目标、项目、领域和约束进行判断。不得推断用户的姓名、年龄、职业、单位、性格、健康状况或价值观，也不得把单次情绪固化为长期画像。\n\n你可以把一份混合输入拆成多条建议。category 只能是 daily、reflection、next-action、project、source、permanent、output、archive、inbox。判断规则：\n- daily：当天事实或简短日记，值得附加到今日日记。\n- reflection：情绪、关系、心智复盘；不要将单次情绪固化为人格。\n- next-action：可以直接执行的单步动作。\n- project：需要多步完成且有明确结果。\n- source：外部资料或待消化素材。\n- permanent：跨事件可复用、条件清楚的稳定判断候选。\n- output：准备公开或交付的成品。\n- archive：已经结束且只需留存。\n- inbox：信息不足、价值不明或暂不应归位。\n\n严格只返回 JSON 数组，不要 Markdown，不要解释。每项字段：sourcePath、category、title、content、rationale、confidence。content 必须保留事实，不可编造；confidence 为 0 到 1。\n\n原始输入：${sourceText}`;
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
    manifest: Array<{ action: 'create' | 'append'; path: string; before?: string }>,
  ): Promise<{ action: 'create' | 'append'; path: string }> {
    if (proposal.category === 'daily') {
      const path = `${SECOND_BRAIN_PATHS.dailyNotes}/${dateStamp(now)}.md`;
      return this.appendToNote(path, `\n\n## 收件箱归位\n\n${proposal.content}\n\n> 来源：[[${proposal.sourcePath.replace(/\.md$/i, '')}]]\n`, manifest);
    }
    if (proposal.category === 'next-action') {
      const path = SECOND_BRAIN_PATHS.nextActions;
      return this.appendToNote(path, `\n- [ ] ${proposal.content.replace(/\r?\n/g, ' ')}  ^inbox-${Date.now()}\n`, manifest);
    }

    const title = sanitizeFileName(proposal.title);
    const folder = this.getDestinationFolder(proposal.category, title);
    const path = await this.uniquePath(`${folder}/${title}.md`);
    await this.ensureFolder(folder);
    const note = `---\ntype: ${proposal.category}\nstatus: active\ncreated: ${formatLocalTimestamp(now)}\nsource_note: "[[${proposal.sourcePath.replace(/\.md$/i, '')}]]"\n---\n\n# ${title}\n\n${proposal.content}\n\n## 分流依据\n\n${proposal.rationale || '由收件箱分流确认生成。'}\n`;
    await this.app.vault.adapter.write(path, note);
    manifest.push({ action: 'create', path });
    return { action: 'create', path };
  }

  private getDestinationFolder(category: Exclude<RoutingCategory, 'daily' | 'next-action'>, title: string): string {
    switch (category) {
      case 'reflection': return SECOND_BRAIN_PATHS.reflections;
      case 'project': return `${SECOND_BRAIN_PATHS.activeProjects}/${title}`;
      case 'source': return SECOND_BRAIN_PATHS.sourceInbox;
      case 'permanent': return SECOND_BRAIN_PATHS.permanentNotes;
      case 'output': return SECOND_BRAIN_PATHS.outputs;
      case 'archive': return SECOND_BRAIN_PATHS.archive;
      case 'inbox': return RAW_INBOX_DIR;
    }
  }

  private async appendToNote(
    path: string,
    addition: string,
    manifest: Array<{ action: 'create' | 'append'; path: string; before?: string }>,
  ): Promise<{ action: 'create' | 'append'; path: string }> {
    const adapter = this.app.vault.adapter;
    const exists = await adapter.exists(path);
    const before = exists ? await adapter.read(path) : '';
    await this.ensureFolder(path.slice(0, path.lastIndexOf('/')));
    await adapter.write(path, before + addition);
    manifest.push(exists ? { action: 'append', path, before } : { action: 'create', path });
    return { action: exists ? 'append' : 'create', path };
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

import { type ChildProcess,spawn } from 'child_process';
import { promises as fs } from 'fs';
import { type App, requestUrl } from 'obsidian';
import * as path from 'path';

import { type ClaudianSettings } from '../types';
import { parseDailyRawInboxEntries,RAW_INBOX_DIR } from './InboxCaptureService';
import { buildRetrievalContext, type RetrievalEvidence } from './RetrievalContext';
import { relevantExcerpt, retrievalTokens, VaultSearchIndex,type VaultSearchResult } from './VaultSearchIndex';

const API_BASE = 'http://127.0.0.1:19828/api/v1';
const CLIP_BASE = 'http://127.0.0.1:19827';
const API_TOKEN_SECRET_ID = 'second-brain-llm-wiki-api-token';
const STARTUP_TIMEOUT_MS = 45_000;
const VAULT_MEMORY_FOLDER = '500_永久笔记与知识资产/';
const LOCAL_MEMORY_LIMIT = 4;
const RAW_INBOX_RESULT_LIMIT = 5;
const RAW_INBOX_CONTEXT_LIMIT = 10_000;
const INITIAL_WIKI_INDEX = `# 知识库索引

本文件由 LLM Wiki 自动维护，用于记录已生成的知识页面。

## 概览

- [[overview|知识库概览]]

## 资料来源

尚未生成来源摘要。
`;
const INITIAL_WIKI_OVERVIEW = `# 知识库概览

知识库尚未完成首次资料处理。本页面将在资料成功导入后由 LLM Wiki 更新。
`;
const INITIAL_WIKI_LOG = `# Wiki Log
`;
const RAW_QUERY_STOP_TOKENS = new Set([
  '微信', '原始', '输入', '记录', '消息', '内容', '附件', '图片', '文件', '链接',
  '之前', '以前', '发过', '发的', '说过', '提到', '查找', '搜索', '根据',
]);

export interface LlmWikiSearchResult {
  path: string;
  title: string;
  snippet: string;
  score: number;
  content?: string;
}

export interface LlmWikiStatus {
  connected: boolean;
  detail: string;
  projectPath: string;
}

type SettingsProvider = () => ClaudianSettings;
type CodexPathProvider = () => string | null;

export function isAbsoluteWikiPath(value: string): boolean {
  return Boolean(value.trim()) && (/^[A-Za-z]:[\\/]/u.test(value) || path.posix.isAbsolute(value));
}

async function writeFileIfMissing(filePath: string, content: string): Promise<void> {
  try {
    await fs.writeFile(filePath, content, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

export async function ensureLlmWikiProjectScaffold(projectPath: string): Promise<void> {
  const rawSourcesPath = path.join(projectPath, 'raw', 'sources');
  const wikiPath = path.join(projectPath, 'wiki');
  await Promise.all([
    fs.mkdir(rawSourcesPath, { recursive: true }),
    fs.mkdir(wikiPath, { recursive: true }),
  ]);
  await Promise.all([
    writeFileIfMissing(path.join(wikiPath, 'index.md'), INITIAL_WIKI_INDEX),
    writeFileIfMissing(path.join(wikiPath, 'overview.md'), INITIAL_WIKI_OVERVIEW),
    writeFileIfMissing(path.join(wikiPath, 'log.md'), INITIAL_WIKI_LOG),
  ]);
}

function stripFrontmatter(value: string): string {
  return value.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/u, '');
}

function localMemoryStage(content: string): 'established' | 'hypothesis' | 'inactive' {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/u)?.[1] ?? '';
  if (/type:\s*experience-hypothesis/iu.test(frontmatter)
    && /status:\s*(?:converted|dismissed|invalidated)/iu.test(frontmatter)) return 'inactive';
  return /(?:knowledge_stage|status):\s*(?:hypothesis|observing)/iu.test(frontmatter)
    ? 'hypothesis'
    : 'established';
}

export function shouldSearchRawInbox(query: string): boolean {
  const compact = query.replace(/\s+/gu, '');
  if (!compact) return false;
  return /(?:微信|原始(?:输入|记录)|收件箱).{0,18}(?:发|说|记|提到|查|找|搜索|图片|附件|文件|链接|内容|消息)/u.test(compact)
    || /(?:之前|以前|过去).{0,12}(?:微信|发过|说过|记录|图片|附件|文件|链接)/u.test(compact)
    || /(?:查|找|搜索|根据).{0,12}(?:微信|原始(?:输入|记录)|收件箱)/u.test(compact);
}

export function needsPersonalMemory(query: string): boolean {
  return /(?:我|之前|以前|上次|记得|记忆|记录|日志|笔记|计划|项目|进度|收件箱|微信|个人|vault|obsidian)/iu.test(query);
}

export function resolveWikiEvidencePath(projectPath: string, resultPath: string): string | null {
  if (!isAbsoluteWikiPath(projectPath) || !resultPath) return null;
  const paths = /^[A-Za-z]:[\\/]/u.test(projectPath) ? path.win32 : path.posix;
  const root = paths.resolve(projectPath);
  const normalized = resultPath.replace(/\\/gu, '/');
  if (normalized.split('/').includes('..')) return null;
  // Search page paths are Wiki-relative; asset paths may already include raw/ or wiki/.
  if (paths === path.posix && path.win32.isAbsolute(normalized) && !path.posix.isAbsolute(normalized)) return null;
  const scopedPath = paths.isAbsolute(normalized) || /^(?:wiki|raw)\//u.test(normalized)
    ? normalized : `wiki/${normalized}`;
  const fullPath = paths.resolve(root, scopedPath);
  const relative = paths.relative(root, fullPath);
  if (!relative || relative === '..' || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative)) return null;
  return fullPath.replace(/\\/gu, '/');
}

export class LlmWikiService {
  private child: ChildProcess | null = null;
  private status: LlmWikiStatus;
  private readonly retrievalIndex: VaultSearchIndex;
  lastRetrievalDiagnostics: { durationMs: number; fileReads: number; contextChars: number; wikiSearched: boolean } | null = null;
  private contextSearch: Promise<LlmWikiSearchResult[]> | null = null;
  private searchRetryAfter = 0;

  invalidate(path: string): void { this.retrievalIndex.invalidate(path); }

  constructor(
    private readonly app: App,
    private readonly settingsProvider: SettingsProvider,
    private readonly codexPathProvider: CodexPathProvider,
  ) {
    this.retrievalIndex = new VaultSearchIndex(app);
    this.status = {
      connected: false,
      detail: '长期记忆库尚未连接。',
      projectPath: settingsProvider().llmWikiProjectPath,
    };
  }

  getStatus(): LlmWikiStatus {
    return { ...this.status };
  }

  async start(): Promise<LlmWikiStatus> {
    const settings = this.settingsProvider();
    if (!settings.llmWikiEnabled) {
      this.status = {
        connected: false,
        detail: '长期记忆库已关闭。',
        projectPath: settings.llmWikiProjectPath,
      };
      return this.getStatus();
    }

    try {
      this.validatePaths(settings);
    } catch (error) {
      return this.markDisconnected(
        error instanceof Error ? error.message : '长期知识库路径无效。',
        settings.llmWikiProjectPath,
      );
    }

    if (await this.isHealthy()) {
      if (!(await this.isAuthorized())) {
        this.status = {
          connected: false,
          detail: '检测到另一个长期记忆进程，但鉴权不一致。请先关闭该进程后重试。',
          projectPath: settings.llmWikiProjectPath,
        };
        return this.getStatus();
      }
      await ensureLlmWikiProjectScaffold(settings.llmWikiProjectPath);
      await this.selectProject(settings.llmWikiProjectPath);
      return this.markConnected(settings.llmWikiProjectPath);
    }

    try {
      const executable = await fs.stat(settings.llmWikiExecutablePath);
      if (!executable.isFile()) {
        return this.markDisconnected(
          `便携程序路径不是文件：${settings.llmWikiExecutablePath}`,
          settings.llmWikiProjectPath,
        );
      }
    } catch {
      return this.markDisconnected(
        `未找到长期知识库便携程序：${settings.llmWikiExecutablePath}`,
        settings.llmWikiProjectPath,
      );
    }
    await ensureLlmWikiProjectScaffold(settings.llmWikiProjectPath);

    const token = this.ensureApiToken();
    const codexPath = this.codexPathProvider();
    const executableDir = path.dirname(settings.llmWikiExecutablePath);
    const codexDir = codexPath ? path.dirname(codexPath) : '';
    const processPath = [codexDir, process.env.PATH ?? ''].filter(Boolean).join(path.delimiter);

    this.child = spawn(settings.llmWikiExecutablePath, [], {
      cwd: executableDir,
      env: {
        ...process.env,
        PATH: processPath,
        LLM_WIKI_API_TOKEN: token,
        LLM_WIKI_PROJECT: settings.llmWikiProjectPath,
        LLM_WIKI_PROJECT_PATH: settings.llmWikiProjectPath,
        LLM_WIKI_AGENT_WORKSPACE: settings.llmWikiProjectPath,
      },
      windowsHide: true,
      stdio: 'ignore',
    });
    let startupFailure = '';
    this.child.once('error', (error) => {
      startupFailure = `长期知识库启动失败：${error.message}`;
      this.child = null;
      this.markDisconnected(startupFailure, settings.llmWikiProjectPath);
    });
    this.child.once('exit', (code, signal) => {
      this.child = null;
      if (!this.status.connected && code !== 0) {
        startupFailure = code === null
          ? `长期知识库启动后异常退出（信号：${signal ?? '未知'}）。`
          : `长期知识库启动后异常退出（代码：${code}）。`;
      }
      this.status = {
        connected: false,
        detail: startupFailure || '长期知识库进程已停止，个人功能仍可正常使用。',
        projectPath: settings.llmWikiProjectPath,
      };
    });

    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await this.isHealthy() && await this.isAuthorized()) {
        await this.selectProject(settings.llmWikiProjectPath);
        return this.markConnected(settings.llmWikiProjectPath);
      }
      if (startupFailure) return this.getStatus();
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    return this.markDisconnected(
      '便携程序已启动，但长期知识库接口在45秒内未就绪。请关闭残留进程后重试，并检查防火墙是否拦截本机接口。',
      settings.llmWikiProjectPath,
    );
  }

  async stop(): Promise<void> {
    if (this.child && !this.child.killed) {
      this.child.kill();
    }
    this.child = null;
    this.status.connected = false;
    this.status.detail = '长期记忆库已停止。';
  }

  async refreshStatus(): Promise<LlmWikiStatus> {
    const settings = this.settingsProvider();
    if (await this.isHealthy() && await this.isAuthorized()) {
      await this.selectProject(settings.llmWikiProjectPath);
      return this.markConnected(settings.llmWikiProjectPath);
    }
    this.status = {
      connected: false,
      detail: '长期记忆库未运行，已切换为个人记录模式。',
      projectPath: settings.llmWikiProjectPath,
    };
    return this.getStatus();
  }

  async search(query: string, topK = 6): Promise<LlmWikiSearchResult[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    if (!(await this.isHealthy())) throw new Error('LLM Wiki local API is unavailable');

    const token = this.ensureApiToken();
    const projectPath = this.settingsProvider().llmWikiProjectPath.replace(/\\/gu, '/');
    const response = await requestUrl({
      url: `${API_BASE}/projects/${encodeURIComponent(projectPath)}/search`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'X-LLM-Wiki-Token': token,
      },
      body: JSON.stringify({
        query: trimmed,
        topK: Math.max(1, Math.min(topK, 12)),
        includeContent: true,
      }),
      throw: false,
    });
    if (response.status < 200 || response.status >= 300) throw new Error(`LLM Wiki search returned HTTP ${response.status}`);

    const payload = response.json as { results?: LlmWikiSearchResult[] };
    const results = Array.isArray(payload.results) ? payload.results.slice(0, Math.max(1, Math.min(topK, 12))) : [];
    for (const result of results) {
      if (result.content || typeof result.path !== 'string') continue;
      const absolutePath = resolveWikiEvidencePath(projectPath, result.path);
      if (!absolutePath || !/\.md$/iu.test(absolutePath)) continue;
      try {
        const realPath = await fs.realpath(absolutePath);
        const realRoot = await fs.realpath(projectPath);
        if (!resolveWikiEvidencePath(realRoot, realPath)) continue;
        const stat = await fs.stat(realPath);
        if (!stat.isFile() || stat.size > 1_000_000) continue;
        result.content = (await fs.readFile(realPath, 'utf8')).slice(0, 1_000_000);
      } catch {
        // Missing or unreadable source pages retain the API-provided snippet.
      }
    }
    return results;
  }

  async buildContext(query: string): Promise<string> {
    const started = Date.now();
    const settings = this.settingsProvider();
    if (/^(?:你好|您好|谢谢|好的|收到|再见|hi|hello)[!！。\s]*$/iu.test(query.trim())
      || /^(?:翻译|计算|translate\b|calculate\b)/iu.test(query.trim())) return '';
    const [local, raw] = await Promise.all([
      this.buildLocalVaultEvidence(query),
      this.buildRawInboxContext(query),
    ]);
    const evidence = [...local.evidence, ...raw.evidence];
    const notice = local.search && (local.search.candidateFiles > local.search.searchedFiles || local.search.skippedFiles > 0)
      ? '检索范围：已按标题、路径、标签和章节筛选候选，尚未读取所有正文。如证据不足，先在相关目录内做关键词全文搜索，再扩大范围；不得把片段当作完整清单。'
      : '';
    const finish = (wikiSearched: boolean, wikiNotice = '') => {
      const context = buildRetrievalContext(evidence, [evidence.length ? notice : '', wikiNotice].filter(Boolean).join('\n'));
      this.lastRetrievalDiagnostics = { durationMs: Date.now() - started,
        fileReads: (local.search?.fileReads ?? 0) + raw.fileReads, contextChars: context.length, wikiSearched };
      return context;
    };
    if (!settings.llmWikiEnabled || !settings.llmWikiAutoRetrieve) return finish(false);
    if (this.contextSearch || Date.now() < this.searchRetryAfter) {
      return finish(false, 'LLM Wiki本次检索暂未执行：上次请求尚未结束或处于故障退避期。本地证据仍可用，但不得声称已查遍Wiki或Wiki没有相关资料。');
    }

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const timeout = new Promise<LlmWikiSearchResult[]>((resolve) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        this.searchRetryAfter = Date.now() + 30_000;
        resolve([]);
      }, 1_200);
    });
    let results: LlmWikiSearchResult[] = [];
    try {
      const pending = this.search(query, settings.llmWikiTopK);
      this.contextSearch = pending;
      void pending.finally(() => {
        if (this.contextSearch === pending) this.contextSearch = null;
      }).catch(() => undefined);
      results = await Promise.race([pending, timeout]);
    } catch {
      this.searchRetryAfter = Date.now() + 30_000;
      return finish(true, 'LLM Wiki检索未完成：服务不可用或请求失败。本地证据仍可用，这不代表Wiki没有相关资料。');
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
    if (timedOut) return finish(true, 'LLM Wiki检索超时，已保留本地证据。未取得Wiki结果不等于Wiki没有相关资料。');
    const wikiEvidence: RetrievalEvidence[] = [];
    for (const item of results.slice(0, Math.min(6, settings.llmWikiTopK))) {
      const absolutePath = resolveWikiEvidencePath(settings.llmWikiProjectPath, item.path);
      if (!absolutePath) continue;
      wikiEvidence.push({ kind: 'memory', path: absolutePath,
        attributes: { title: item.title, source_system: 'llm-wiki', project_path: settings.llmWikiProjectPath },
        text: relevantExcerpt(item.content || item.snippet || '', retrievalTokens(query)).text });
    }
    // Interleave both sources so a large local result cannot consume the whole context budget.
    const localEvidence = evidence.splice(0);
    for (let index = 0; index < Math.max(localEvidence.length, wikiEvidence.length); index += 1) {
      if (localEvidence[index]) evidence.push(localEvidence[index]);
      if (wikiEvidence[index]) evidence.push(wikiEvidence[index]);
    }
    return finish(true);
  }

  private async buildRawInboxContext(query: string): Promise<{ evidence: RetrievalEvidence[]; fileReads: number }> {
    const empty = { evidence: [], fileReads: 0 };
    if (!shouldSearchRawInbox(query)) return empty;
    const vault = this.app?.vault;
    if (!vault) return empty;
    const queryTokens = retrievalTokens(query)
      .filter((token) => !RAW_QUERY_STOP_TOKENS.has(token));
    const candidates: Array<{
      sourcePath: string;
      content: string;
      score: number;
      created: string;
      mtime: number;
    }> = [];

    const search = await this.retrievalIndex.search(query, (file) => file.path.startsWith(`${RAW_INBOX_DIR}/`) && !file.path.endsWith('/README.md'));
    for (const { file, content } of search.hits) {
      const entries = parseDailyRawInboxEntries(file.path, content);
      const records = entries.length > 0
        ? entries.map((entry) => ({
          sourcePath: entry.sourcePath,
          content: entry.content,
          created: entry.created,
        }))
        : [{
          sourcePath: file.path,
          content: stripFrontmatter(content).replace(/^# 原始输入\s*/u, '').trim(),
          created: '',
        }];
      for (const record of records) {
        const normalized = record.content.toLowerCase();
        let score = queryTokens.length === 0 ? 1 : 0;
        for (const token of queryTokens) {
          if (normalized.includes(token)) score += Math.max(1, token.length);
        }
        const dateToken = query.match(/20\d{2}-\d{2}(?:-\d{2})?/u)?.[0];
        if (dateToken && !record.sourcePath.includes(dateToken) && !record.created.includes(dateToken)) continue;
        if (dateToken) score += 8;
        if (score <= 0 || !record.content.trim()) continue;
        candidates.push({
          ...record,
          score,
          mtime: file.stat.mtime,
        });
      }
    }

    const selected = candidates
      .sort((left, right) => right.score - left.score
        || right.created.localeCompare(left.created)
        || right.mtime - left.mtime)
      .slice(0, RAW_INBOX_RESULT_LIMIT);
    if (selected.length === 0) return { evidence: [], fileReads: search.fileReads };

    let used = 0;
    const records: RetrievalEvidence[] = [];
    for (const item of selected) {
      const remaining = RAW_INBOX_CONTEXT_LIMIT - used;
      if (remaining <= 0) break;
      const excerpt = item.content.slice(0, Math.min(2_500, remaining));
      used += excerpt.length;
      records.push({ kind: 'raw-inbox-record', path: item.sourcePath, text: excerpt,
        attributes: item.created ? { created: item.created } : {} });
    }
    return { evidence: records, fileReads: search.fileReads };
  }

  private async buildLocalVaultEvidence(query: string): Promise<{ evidence: RetrievalEvidence[]; search?: VaultSearchResult }> {
    const tokens = retrievalTokens(query);
    const vault = this.app?.vault;
    if (!vault || tokens.length === 0) return { evidence: [] };
    const personal = needsPersonalMemory(query);
    const search = await this.retrievalIndex.search(query, (file) => {
      if (file.path.startsWith(`${RAW_INBOX_DIR}/`)) return false;
      if (/^(?:300_复盘与日志|300_复盘与日志|020_行动系统)\//u.test(file.path) && !personal) return false;
      return true;
    }, /(?:图|pdf|照片|截图|接线|附件)/iu.test(query));
    const evidence: RetrievalEvidence[] = search.assets.map((file) => ({ kind: 'asset', path: file.path,
      text: '相关原始图件候选，仅路径命中，尚未解析图中内容。按需要使用看图/文档工具核实。' }));
    for (const item of search.hits) {
      if (evidence.filter((entry) => entry.kind === 'vault-memory').length >= LOCAL_MEMORY_LIMIT) break;
      const stage = item.file.path.startsWith(VAULT_MEMORY_FOLDER) ? localMemoryStage(item.content) : 'record';
      if (stage === 'inactive') continue;
      const excerpt = relevantExcerpt(item.content, tokens);
      evidence.push({ kind: 'vault-memory', path: item.file.path, text: excerpt.text,
        attributes: { title: item.file.basename, stage, line: String(excerpt.line),
          modified: new Date(item.file.stat.mtime).toISOString(),
          status: item.content.match(/^status:\s*([^\r\n]+)/mu)?.[1] ?? '未标明' } });
    }
    return { evidence, search };
  }

  private async isHealthy(): Promise<boolean> {
    try {
      const response = await requestUrl({
        url: `${API_BASE}/health`,
        method: 'GET',
        throw: false,
      });
      return response.status >= 200 && response.status < 300;
    } catch {
      return false;
    }
  }

  private async isAuthorized(): Promise<boolean> {
    try {
      const token = this.ensureApiToken();
      const response = await requestUrl({
        url: `${API_BASE}/projects`,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'X-LLM-Wiki-Token': token,
        },
        throw: false,
      });
      return response.status >= 200 && response.status < 300;
    } catch {
      return false;
    }
  }

  private async selectProject(projectPath: string): Promise<void> {
    const normalized = projectPath.replace(/\\/gu, '/');
    await requestUrl({
      url: `${CLIP_BASE}/projects`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projects: [{ name: '第二大脑长期记忆', path: normalized }],
      }),
      throw: false,
    });
    await requestUrl({
      url: `${CLIP_BASE}/project`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: normalized }),
      throw: false,
    });
  }

  private ensureApiToken(): string {
    const existing = this.app.secretStorage.getSecret(API_TOKEN_SECRET_ID);
    if (existing) return existing;
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const token = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
    this.app.secretStorage.setSecret(API_TOKEN_SECRET_ID, token);
    return token;
  }

  private validatePaths(settings: ClaudianSettings): void {
    const paths = [
      settings.llmWikiExecutablePath,
      settings.llmWikiProjectPath,
    ];
    if (paths.some((value) => !isAbsoluteWikiPath(value))) {
      throw new Error('请填写LLM Wiki程序和知识项目的绝对路径。');
    }
  }

  private markConnected(projectPath: string): LlmWikiStatus {
    this.status = {
      connected: true,
      detail: '长期记忆库已连接。',
      projectPath,
    };
    return this.getStatus();
  }

  private markDisconnected(detail: string, projectPath: string): LlmWikiStatus {
    this.status = {
      connected: false,
      detail,
      projectPath,
    };
    return this.getStatus();
  }
}

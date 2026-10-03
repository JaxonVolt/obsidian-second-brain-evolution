import type { App, TFile } from 'obsidian';

const MAX_READS = 16;
const MAX_CACHED_FILES = 128;
const MAX_FILE_BYTES = 1_000_000;
const STOP_WORDS = new Set(['什么', '怎么', '如何', '这个', '那个', '事情', '问题', '可以', '需要', '还是', '已经',
  '我的', '我们', '你们', '一下', '一个', '一种', '是否', '以后', '现在', '进行', '关于', '查找', '搜索',
  '查一', '查一下', '帮我', '中的', '每个', '几个', '连接', '都连', '连接了', '内容', '资料', '笔记', '记录']);
const Segmenter = (Intl as typeof Intl & { Segmenter?: new(locale: string, options: { granularity: string }) => {
  segment(text: string): Iterable<{ segment: string; isWordLike: boolean }>;
} }).Segmenter;
const segmenter = Segmenter ? new Segmenter('zh', { granularity: 'word' }) : null;

export function retrievalTokens(query: string): string[] {
  const text = query.toLowerCase();
  const tokens = new Set<string>();
  for (const part of segmenter?.segment(text) ?? []) {
    if (part.isWordLike && part.segment.length >= 2 && !STOP_WORDS.has(part.segment)) tokens.add(part.segment);
  }
  for (const match of text.matchAll(/[a-z0-9][a-z0-9+.#-]{1,30}/gu)) tokens.add(match[0]);
  for (const phrase of text.match(/[\p{Script=Han}]{2,}/gu) ?? []) {
    if (phrase.length <= 8 && !STOP_WORDS.has(phrase)) tokens.add(phrase);
    for (let i = 0; i < phrase.length - 1; i++) {
      const token = phrase.slice(i, i + 2);
      if (!STOP_WORDS.has(token)) tokens.add(token);
    }
  }
  // Search aliases only: they do not establish electrical equivalence.
  if (/馈线/u.test(text)) tokens.add('集电线路');
  if (/集电线路/u.test(text)) tokens.add('馈线');
  return [...tokens].slice(0, 64);
}

function weight(token: string): number { return Math.min(8, token.length * token.length / 2); }

export function textScore(text: string, tokens: string[]): number {
  const lower = text.toLowerCase();
  return tokens.reduce((score, token) => score + (lower.includes(token) ? weight(token) : 0), 0);
}

interface IndexEntry {
  fingerprint: string;
  metadata: unknown;
  title: string;
  directory: string;
  searchable: string;
}

export interface VaultSearchHit {
  file: TFile;
  content: string;
  score: number;
  metadataScore: number;
}

export interface VaultSearchResult {
  hits: VaultSearchHit[];
  assets: TFile[];
  searchedFiles: number;
  candidateFiles: number;
  fileReads: number;
  skippedFiles: number;
  durationMs: number;
}

/** Uses Obsidian's existing metadata index; only shortlisted bodies are read. */
export class VaultSearchIndex {
  private entries = new Map<string, IndexEntry>();
  private bodies = new Map<string, { fingerprint: string; content: string }>();
  private pending = new Map<string, Promise<string>>();

  constructor(private app: App) {}

  invalidate(filePath: string): void {
    this.entries.delete(filePath);
    this.bodies.delete(filePath);
  }

  private fingerprint(file: TFile): string { return `${file.stat.mtime}:${file.stat.size}`; }

  private entry(file: TFile): IndexEntry {
    const fingerprint = this.fingerprint(file);
    const metadata = this.app.metadataCache?.getFileCache?.(file);
    const previous = this.entries.get(file.path);
    if (previous?.fingerprint === fingerprint && previous.metadata === metadata) return previous;
    const aliases = metadata?.frontmatter?.aliases ?? [];
    const tags = metadata?.frontmatter?.tags ?? [];
    const list = (value: unknown): string => Array.isArray(value)
      ? value.filter((item) => typeof item === 'string').join(' ') : typeof value === 'string' ? value : '';
    const entry = {
      fingerprint, metadata, title: file.basename.toLowerCase(),
      directory: file.path.slice(0, file.path.lastIndexOf('/')).toLowerCase(),
      searchable: [list(aliases), list(tags), ...(metadata?.headings ?? []).map((item) => item.heading)].join(' ').toLowerCase(),
    };
    this.entries.set(file.path, entry);
    return entry;
  }

  async read(file: TFile): Promise<string> {
    const fingerprint = this.fingerprint(file);
    const previous = this.bodies.get(file.path);
    if (previous?.fingerprint === fingerprint) return previous.content;
    const key = `${file.path}:${fingerprint}`;
    const pending = this.pending.get(key);
    if (pending) return pending;
    const read = this.app.vault.cachedRead(file).then((content) => {
      if (this.fingerprint(file) !== fingerprint) throw new Error('Source changed during retrieval');
      this.bodies.delete(file.path);
      this.bodies.set(file.path, { fingerprint, content });
      while (this.bodies.size > MAX_CACHED_FILES) this.bodies.delete(this.bodies.keys().next().value!);
      return content;
    }).finally(() => { this.pending.delete(key); });
    this.pending.set(key, read);
    return read;
  }

  async search(query: string, eligible: (file: TFile) => boolean, includeAssets = false): Promise<VaultSearchResult> {
    const started = Date.now();
    const tokens = retrievalTokens(query);
    const allFiles = this.app.vault?.getMarkdownFiles?.() ?? [];
    const livePaths = new Set(allFiles.map((file) => file.path));
    for (const filePath of this.entries.keys()) if (!livePaths.has(filePath)) this.invalidate(filePath);
    const date = query.match(/20\d{2}-\d{2}(?:-\d{2})?/u)?.[0];
    const candidates = allFiles.filter((file) => !file.path.startsWith('.') && eligible(file)).map((file) => {
      const entry = this.entry(file);
      const titleScore = textScore(entry.title, tokens);
      const metadataScore = titleScore * 5 + textScore(entry.searchable, tokens) * 3
        + textScore(entry.directory, tokens) * 0.8;
      const body = this.bodies.get(file.path);
      const cachedScore = body?.fingerprint === entry.fingerprint ? textScore(body.content, tokens) : 0;
      const dateBoost = date && (file.path.includes(date) || entry.searchable.includes(date)) ? 50 : 0;
      return { file, metadataScore, score: metadataScore + cachedScore + dateBoost };
    }).sort((a, b) => b.score - a.score || b.file.stat.mtime - a.file.stat.mtime || a.file.path.localeCompare(b.file.path));
    const matched = candidates.filter((item) => item.score > 0);
    const shortlist = (matched.length ? matched : candidates).slice(0, MAX_READS);
    let fileReads = 0;
    let skippedFiles = 0;
    const hits: VaultSearchHit[] = [];
    // Small batches keep disk latency low without flooding the Vault adapter.
    for (let offset = 0; offset < shortlist.length; offset += 4) {
      await Promise.all(shortlist.slice(offset, offset + 4).map(async (candidate) => {
        const { file, metadataScore } = candidate;
        if (file.stat.size > MAX_FILE_BYTES) { skippedFiles++; return; }
        try {
          if (this.bodies.get(file.path)?.fingerprint !== this.fingerprint(file)) fileReads++;
          const content = await this.read(file);
          if (date && !file.path.includes(date) && !content.includes(date)) return;
          const bodyScore = textScore(content, tokens);
          if (bodyScore < 3 && metadataScore < 8) return;
          hits.push({ file, content, metadataScore, score: metadataScore + bodyScore * 2 });
        } catch { skippedFiles++; }
      }));
    }
    hits.sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path));
    const sourceFolders = hits.slice(0, 4).map((hit) => hit.file.path.slice(0, hit.file.path.lastIndexOf('/') + 1)).filter(Boolean);
    const linkedAssets = new Map<string, number>();
    for (const [rank, hit] of hits.slice(0, 4).entries()) {
      for (const link of hit.content.matchAll(/!?\[\[([^\]|#]+)(?:[^\]]*)\]\]/gu)) {
        const target = link[1].replace(/\\/gu, '/').trim();
        if (/\.(?:pdf|png|jpe?g|webp)$/iu.test(target)) linkedAssets.set(target, Math.max(linkedAssets.get(target) ?? 0, 120 - rank * 20));
      }
    }
    const assets = includeAssets ? (this.app.vault?.getFiles?.() ?? [])
      .filter((file) => !file.path.startsWith('.') && /\.(?:pdf|png|jpe?g|webp)$/iu.test(file.path))
      .map((file) => ({ file, score: textScore(file.basename, tokens) * 5 + textScore(file.path, tokens)
        + (linkedAssets.get(file.path) ?? linkedAssets.get(file.path.split('/').pop()!) ?? 0)
        + (sourceFolders.some((folder) => file.path.startsWith(folder)) ? 40 : 0) }))
      .filter((item) => item.score >= 8)
      .sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path))
      .slice(0, 4).map((item) => item.file) : [];
    return { hits, assets, searchedFiles: shortlist.length, candidateFiles: candidates.length,
      fileReads, skippedFiles, durationMs: Date.now() - started };
  }
}

export function relevantExcerpt(content: string, tokens: string[], limit = 1800): { text: string; line: number } {
  const lines = content.split(/\r?\n/u);
  const frontmatterEnd = lines[0] === '---' ? lines.indexOf('---', 1) : -1;
  let bestLine = Math.max(0, frontmatterEnd + 1);
  let bestScore = 0;
  for (let i = bestLine; i < lines.length; i++) {
    const score = textScore(lines.slice(i, i + 6).join('\n'), tokens);
    if (score > bestScore) { bestScore = score; bestLine = i; }
  }
  const start = Math.max(frontmatterEnd + 1, bestLine - 2, 0);
  return { text: lines.slice(start).join('\n').slice(0, limit).trimEnd(), line: start + 1 };
}

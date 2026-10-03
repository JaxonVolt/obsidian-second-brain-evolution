import type { App } from 'obsidian';

import { SECOND_BRAIN_PATHS } from './SecondBrainInitializer';
import { serializeVaultOperation, writeTextIfUnchanged } from './VaultMutation';

export const RAW_INBOX_DIR = SECOND_BRAIN_PATHS.rawInbox;

const RAW_ENTRY_START = '%% second-brain:raw-entry:start ';
const RAW_ENTRY_END = '%% second-brain:raw-entry:end %%';
const LEGACY_RAW_ENTRY_START = '<!-- second-brain:raw-entry:start ';

export interface InboxCaptureOptions {
  source?: string;
  metadata?: Record<string, string | number | boolean | undefined>;
}

export interface RawInboxEntry {
  sourcePath: string;
  filePath: string;
  blockId: string;
  created: string;
  source: string;
  metadata: Record<string, string | number | boolean>;
  content: string;
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0');
}

export function formatLocalTimestamp(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function formatCaptureFileName(date: Date): string {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}.md`;
}

export function formatDailyCapturePath(date: Date): string {
  const year = String(date.getFullYear());
  const month = pad(date.getMonth() + 1);
  const day = `${year}-${month}-${pad(date.getDate())}`;
  return `${RAW_INBOX_DIR}/${year}/${month}/${day}.md`;
}

function formatEntryBlockId(date: Date): string {
  return `raw-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}`;
}

function sourceLabel(source: string): string {
  if (source === 'wechat-ilink') return '微信';
  if (source === 'second-brain-plugin') return '插件';
  return source || '未标明来源';
}

function dailyHeader(date: Date): string {
  const timestamp = formatLocalTimestamp(date);
  const day = timestamp.slice(0, 10);
  return `---\ntype: inbox-capture-day\nstatus: active\ndate: ${day}\ncreated: ${timestamp}\n---\n\n# ${day} 原始输入\n`;
}

function cleanMetadata(metadata: InboxCaptureOptions['metadata']): Record<string, string | number | boolean> {
  return Object.fromEntries(
    Object.entries(metadata ?? {})
      .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined),
  );
}

function renderEntry(
  content: string,
  blockId: string,
  created: string,
  source: string,
  metadata: Record<string, string | number | boolean>,
): string {
  const marker = JSON.stringify({ id: blockId, created, source, metadata });
  const time = created.slice(11, 19);
  return [
    `${RAW_ENTRY_START}${marker} %%`,
    `## ${time} · ${sourceLabel(source)}`,
    '',
    content,
    '',
    `^${blockId}`,
    RAW_ENTRY_END,
  ].join('\n');
}

function appendEntry(before: string, entry: string): string {
  if (!before) return `${entry}\n`;
  const separator = before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  return `${before}${separator}${entry}\n`;
}

function uniqueBlockId(content: string, base: string): string {
  if (!content.includes(`^${base}`)) return base;
  for (let suffix = 2; suffix < 1000; suffix++) {
    const candidate = `${base}-${suffix}`;
    if (!content.includes(`^${candidate}`)) return candidate;
  }
  throw new Error('无法为原始输入生成唯一消息编号。');
}

export function parseDailyRawInboxEntries(filePath: string, content: string): RawInboxEntry[] {
  if (!content.includes(RAW_ENTRY_START) && !content.includes(LEGACY_RAW_ENTRY_START)) return [];
  const entries: RawInboxEntry[] = [];
  const pattern = /(?:%% second-brain:raw-entry:start (\{[^\r\n]*\}) %%|<!-- second-brain:raw-entry:start (\{[^\r\n]*\}) -->)\r?\n([\s\S]*?)\r?\n(?:%% second-brain:raw-entry:end %%|<!-- second-brain:raw-entry:end -->)/gu;
  for (const match of content.matchAll(pattern)) {
    let descriptor: unknown;
    try {
      descriptor = JSON.parse(match[1] ?? match[2]);
    } catch {
      continue;
    }
    if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) continue;
    const raw = descriptor as Record<string, unknown>;
    const blockId = typeof raw.id === 'string' ? raw.id.trim() : '';
    if (!/^[A-Za-z0-9-]+$/u.test(blockId)) continue;
    const block = match[3];
    const blockMatch = block.match(/\r?\n\^([A-Za-z0-9-]+)\s*$/u);
    if (!blockMatch || blockMatch[1] !== blockId) continue;
    const entryContent = block
      .slice(0, blockMatch.index)
      .replace(/^##[^\r\n]*\r?\n(?:\r?\n)?/u, '')
      .trim();
    const metadata = raw.metadata && typeof raw.metadata === 'object' && !Array.isArray(raw.metadata)
      ? Object.fromEntries(Object.entries(raw.metadata as Record<string, unknown>)
        .filter((entry): entry is [string, string | number | boolean] => (
          typeof entry[1] === 'string' || typeof entry[1] === 'number' || typeof entry[1] === 'boolean'
        )))
      : {};
    entries.push({
      sourcePath: `${filePath}#^${blockId}`,
      filePath,
      blockId,
      created: typeof raw.created === 'string' ? raw.created : '',
      source: typeof raw.source === 'string' ? raw.source : '',
      metadata,
      content: entryContent,
    });
  }
  return entries;
}

export function sourcePathToWikiTarget(sourcePath: string): string {
  const anchorIndex = sourcePath.indexOf('#');
  const filePath = anchorIndex >= 0 ? sourcePath.slice(0, anchorIndex) : sourcePath;
  const anchor = anchorIndex >= 0 ? sourcePath.slice(anchorIndex) : '';
  return `${filePath.replace(/\.md$/iu, '')}${anchor}`;
}

export class InboxCaptureService {
  constructor(private app: App) {}

  async capture(content: string, now = new Date(), options: InboxCaptureOptions = {}): Promise<string> {
    const text = content.trim();
    if (!text) throw new Error('没有可保存的内容。');

    return serializeVaultOperation(this.app, `capture:${formatDailyCapturePath(now)}`, () => this.captureEntry(text, now, options));
  }

  private async captureEntry(content: string, now: Date, options: InboxCaptureOptions): Promise<string> {
    const adapter = this.app.vault.adapter;
    const path = formatDailyCapturePath(now);
    await this.ensureFolder(path.slice(0, path.lastIndexOf('/')));
    const exists = await adapter.exists(path);
    const before = exists ? await adapter.read(path) : dailyHeader(now);
    const messageId = options.metadata?.wechat_message_id;
    if (messageId) {
      const previous = parseDailyRawInboxEntries(path, before).find((entry) => entry.metadata.wechat_message_id === messageId);
      if (previous) return previous.sourcePath;
    }
    const blockId = uniqueBlockId(before, formatEntryBlockId(now));
    const created = formatLocalTimestamp(now);
    const source = options.source ?? 'second-brain-plugin';
    const entry = renderEntry(content, blockId, created, source, cleanMetadata(options.metadata));
    await writeTextIfUnchanged(this.app, path, exists ? before : null, appendEntry(before, entry));
    return `${path}#^${blockId}`;
  }

  private async ensureFolder(path: string): Promise<void> {
    const adapter = this.app.vault.adapter;
    let current = '';
    for (const segment of path.split('/').filter(Boolean)) {
      current = current ? `${current}/${segment}` : segment;
      if (!(await adapter.exists(current))) await adapter.mkdir(current);
    }
  }
}

import type { App } from 'obsidian';

export const RAW_INBOX_DIR = '010_收件箱/原始输入_raw';

export interface InboxCaptureOptions {
  source?: string;
  metadata?: Record<string, string | number | boolean | undefined>;
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

function yamlValue(value: string | number | boolean): string {
  if (typeof value !== 'string') return String(value);
  return JSON.stringify(value);
}

export class InboxCaptureService {
  constructor(private app: App) {}

  async capture(content: string, now = new Date(), options: InboxCaptureOptions = {}): Promise<string> {
    const text = content.trim();
    if (!text) {
      throw new Error('没有可保存的内容。');
    }

    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(RAW_INBOX_DIR))) {
      await adapter.mkdir(RAW_INBOX_DIR);
    }

    const fileName = formatCaptureFileName(now);
    const dot = fileName.lastIndexOf('.');
    const stem = fileName.slice(0, dot);
    let path = `${RAW_INBOX_DIR}/${fileName}`;
    for (let suffix = 2; await adapter.exists(path); suffix++) {
      path = `${RAW_INBOX_DIR}/${stem}-${suffix}.md`;
    }
    const timestamp = formatLocalTimestamp(now);
    const metadata = Object.entries(options.metadata ?? {})
      .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
      .map(([key, value]) => `${key}: ${yamlValue(value)}`)
      .join('\n');
    const note = `---\ntype: inbox-capture\nstatus: unprocessed\ncreated: ${timestamp}\nsource: ${yamlValue(options.source ?? 'second-brain-plugin')}${metadata ? `\n${metadata}` : ''}\n---\n\n# 原始输入\n\n${text}\n`;
    await adapter.write(path, note);
    return path;
  }
}

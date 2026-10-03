import { Solar } from 'lunar-javascript';
import type { App, TFile } from 'obsidian';

export const DAILY_INFO_START = '> [!info] 今日信息';

const DAILY_INFO_PATTERN = /^> \[!info\] 今日信息(?:\r?\n>.*)+/m;

const CUSTOMS: Record<string, string> = {
  元旦节: '辞旧迎新',
  春节: '拜年、团圆',
  元宵节: '赏灯、吃元宵',
  清明: '祭扫、踏青',
  端午节: '赛龙舟、吃粽子',
  七夕节: '祈巧',
  中元节: '祭祖',
  中秋节: '赏月、团圆',
  重阳节: '登高、敬老',
  腊八节: '喝腊八粥',
  除夕: '守岁、吃年夜饭',
  冬至: '团聚、吃饺子或汤圆',
  建军节: '致敬军人',
  国庆节: '庆祝、出行错峰',
};

export interface DailyInfoSettings {
  enabled: boolean;
}

export interface UpcomingEvent {
  days: number;
  name: string;
}

function twoDigits(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

export function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function getEventsForSolar(solar: ReturnType<typeof Solar.fromYmd>): string[] {
  const lunar = solar.getLunar();
  return unique([
    ...solar.getFestivals(),
    ...lunar.getFestivals(),
    lunar.getJieQi(),
  ]);
}

export function findUpcomingEvent(date: Date, maxDays = 30): UpcomingEvent | null {
  const solar = Solar.fromYmd(date.getFullYear(), date.getMonth() + 1, date.getDate());
  for (let days = 1; days <= maxDays; days++) {
    const events = getEventsForSolar(solar.next(days));
    if (events.length > 0) return { days, name: events[0] };
  }
  return null;
}

function getCustoms(events: string[]): string {
  for (const event of events) {
    if (CUSTOMS[event]) return CUSTOMS[event];
  }
  return events.length > 0 ? `关注${events[0]}` : '今日无特别习俗';
}

function summarize(items: string[], limit = 3): string {
  const values = unique(items).slice(0, limit);
  return values.length > 0 ? values.join('、') : '无特别事项';
}

export function buildDailyInfoBlock(date: Date): string {
  const solar = Solar.fromYmd(date.getFullYear(), date.getMonth() + 1, date.getDate());
  const lunar = solar.getLunar();
  const events = getEventsForSolar(solar);
  const upcoming = findUpcomingEvent(date);
  const eventSuffix = events.length > 0 ? `（${events.join('、')}）` : '';
  const upcomingText = upcoming
    ? `${upcoming.name}（${upcoming.days}天后）`
    : '30天内暂无';

  return [
    DAILY_INFO_START,
    `> **日期**：${date.getMonth() + 1}月${date.getDate()}日 · 星期${solar.getWeekInChinese()} · 农历${lunar.getMonthInChinese()}月${lunar.getDayInChinese()}`,
    `> **习俗**：${getCustoms(events)}${eventSuffix} · **下个节日/节气**：${upcomingText}`,
    `> **宜**：${summarize(lunar.getDayYi())} · **忌**：${summarize(lunar.getDayJi())}`,
  ].join('\n');
}

export function upsertDailyInfo(content: string, block: string): string {
  if (DAILY_INFO_PATTERN.test(content)) {
    return content.replace(DAILY_INFO_PATTERN, block);
  }

  const heading = /^# .+$/m.exec(content);
  if (heading?.index !== undefined) {
    const insertAt = heading.index + heading[0].length;
    const before = content.slice(0, insertAt);
    const after = content.slice(insertAt).replace(/^\r?\n+/, '');
    return `${before}\n\n${block}\n\n${after}`;
  }

  const frontmatter = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(content);
  if (frontmatter) {
    const before = content.slice(0, frontmatter[0].length).replace(/\r?\n$/, '');
    const after = content.slice(frontmatter[0].length).replace(/^\r?\n+/, '');
    return `${before}\n\n${block}\n\n${after}`;
  }

  return `${block}\n\n${content}`;
}

export function isDailyNoteCandidate(
  filePath: string,
  basename: string,
  date: Date,
  frontmatterType?: string
): boolean {
  if (basename !== localDateKey(date)) return false;
  const normalizedPath = filePath.replace(/\\/g, '/');
  return frontmatterType === 'daily' || /\/310_[^/]*(每日|日记)/.test(normalizedPath);
}

export function selectPreferredDailyNotePath(paths: string[], date: Date): string | null {
  const dateKey = localDateKey(date);
  const monthKey = dateKey.slice(0, 7);
  const normalized = paths.map((path) => path.replace(/\\/g, '/'));
  return normalized.find((path) => path.endsWith(`/${monthKey}/${dateKey}.md`))
    ?? normalized.find((path) => path.endsWith(`/${dateKey}.md`))
    ?? null;
}

export class DailyNoteInfoService {
  constructor(
    private app: App,
    private getSettings: () => DailyInfoSettings
  ) {}

  async ensureForFile(file: TFile, date = new Date()): Promise<boolean> {
    const settings = this.getSettings();
    if (!settings.enabled) return false;
    const frontmatterType = this.app.metadataCache.getFileCache(file)?.frontmatter?.type;
    if (!isDailyNoteCandidate(file.path, file.basename, date, frontmatterType)) return false;

    const block = buildDailyInfoBlock(date);
    let changed = false;
    await this.app.vault.process(file, (content) => {
      const next = upsertDailyInfo(content, block);
      changed = next !== content;
      return next;
    });
    return changed;
  }

  async ensureTodayInfo(date = new Date()): Promise<boolean> {
    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile && await this.ensureForFile(activeFile, date)) return true;

    const candidates = this.app.vault.getMarkdownFiles().filter((file) => {
      const frontmatterType = this.app.metadataCache.getFileCache(file)?.frontmatter?.type;
      return isDailyNoteCandidate(file.path, file.basename, date, frontmatterType);
    });
    const preferredPath = selectPreferredDailyNotePath(candidates.map((file) => file.path), date);
    const todayFile = candidates.find((file) => file.path.replace(/\\/g, '/') === preferredPath);
    return todayFile ? this.ensureForFile(todayFile, date) : false;
  }

  findTodayFile(date = new Date()): TFile | null {
    const activeFile = this.app.workspace.getActiveFile();
    const candidates = this.app.vault.getMarkdownFiles().filter((file) => {
      const frontmatterType = this.app.metadataCache.getFileCache(file)?.frontmatter?.type;
      return isDailyNoteCandidate(file.path, file.basename, date, frontmatterType);
    });
    const preferredPath = selectPreferredDailyNotePath(candidates.map((file) => file.path), date);
    if (activeFile && activeFile.path.replace(/\\/g, '/') === preferredPath) return activeFile;
    return candidates.find((file) => file.path.replace(/\\/g, '/') === preferredPath) ?? null;
  }
}

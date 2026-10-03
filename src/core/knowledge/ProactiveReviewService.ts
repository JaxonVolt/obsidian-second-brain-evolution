import type { App, TFile } from 'obsidian';

const REVIEW_STATE_PATH = '.second-brain/runtime/review-state.json';
const ACTION_ROOT = '020_行动系统';
const NEXT_ACTIONS_PATH = `${ACTION_ROOT}/下一步行动.md`;
const WAITING_PATH = `${ACTION_ROOT}/等待与委托.md`;
const DECISIONS_PATH = `${ACTION_ROOT}/决策记录.md`;
const ACTIVE_PROJECTS_PREFIX = `${ACTION_ROOT}/活跃项目/`;

export type ReviewKind =
  | 'project-overdue'
  | 'project-action-disconnected'
  | 'project-no-next-action'
  | 'project-stale'
  | 'today-carryover'
  | 'weekly-stale'
  | 'waiting-overdue'
  | 'waiting-missing-date'
  | 'decision-review-due'
  | 'decision-missing-review-date';

export type ReviewSeverity = 'high' | 'medium' | 'low';
export type ReviewItemStatus = 'active' | 'snoozed' | 'resolved' | 'dismissed';
export type ReviewFeedbackReason = 'outdated' | 'incorrect' | 'not-needed' | 'duplicate';

export interface ProactiveReviewSettings {
  enabled: boolean;
  projectStaleDays: number;
  weeklyActionDays: number;
  maxVisible: number;
  startupNotice: boolean;
}

export interface ReviewItem {
  id: string;
  kind: ReviewKind;
  severity: ReviewSeverity;
  title: string;
  reason: string;
  evidence: string;
  sourcePath: string;
  sourceLine?: number;
  taskText?: string;
  canComplete: boolean;
  firstSeenAt: string;
}

interface ReviewCandidate extends Omit<ReviewItem, 'firstSeenAt'> {
  sourceSignature: string;
  eligible: boolean;
}

interface ReviewStateRecord {
  firstSeenAt: string;
  lastSeenAt: string;
  status: ReviewItemStatus;
  sourceSignature: string;
  snoozedUntil?: string;
  feedbackReason?: ReviewFeedbackReason;
}

interface ReviewStateFile {
  version: 1;
  lastScanDate?: string;
  records: Record<string, ReviewStateRecord>;
}

export interface ReviewScanResult {
  items: ReviewItem[];
  totalDetected: number;
  viewportItems: number;
  newCount: number;
  scannedAt: string;
}

export interface DecisionDraft {
  title: string;
  background: string;
  rationale: string;
  expectedResult: string;
  decisionDate: string;
  reviewDate: string;
}

interface ParsedTask {
  text: string;
  section: string;
  line: number;
}

interface ParsedFrontmatter {
  body: string;
  fields: Record<string, string>;
}

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const match = value.trim().replace(/^['"]|['"]$/g, '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function daysBetween(earlier: Date, later: Date): number {
  return Math.floor((startOfDay(later).getTime() - startOfDay(earlier).getTime()) / 86_400_000);
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function normalizeText(value: string): string {
  return value
    .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1')
    .replace(/[`*_~#>]/g, '')
    .replace(/[，。；：、！？,.!?;:()[\]（）\s]/g, '')
    .trim()
    .toLowerCase();
}

function parseFrontmatter(content: string): ParsedFrontmatter {
  if (!content.startsWith('---')) return { body: content, fields: {} };
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { body: content, fields: {} };

  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z0-9_-]+):\s*(.*?)\s*$/);
    if (field) fields[field[1]] = field[2].replace(/^['"]|['"]$/g, '');
  }
  return { body: content.slice(match[0].length), fields };
}

function parseUncheckedTasks(content: string): ParsedTask[] {
  const tasks: ParsedTask[] = [];
  let section = '';
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const heading = lines[index].match(/^#{2,6}\s+(.+?)\s*$/);
    if (heading) {
      section = heading[1].trim();
      continue;
    }
    const task = lines[index].match(/^\s*[-*]\s+\[\s\]\s+(.+?)\s*$/);
    if (task) tasks.push({ text: task[1].trim(), section, line: index + 1 });
  }
  return tasks;
}

function extractSection(content: string, headingPattern: RegExp): string {
  const lines = content.split(/\r?\n/);
  let capture = false;
  let level = 0;
  const collected: string[] = [];
  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (heading) {
      if (capture && heading[1].length <= level) break;
      if (!capture && headingPattern.test(heading[2].trim())) {
        capture = true;
        level = heading[1].length;
        continue;
      }
    }
    if (capture) collected.push(line);
  }
  return collected.join('\n');
}

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim());
}

function isTableDivider(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function fileModifiedAt(file: TFile, frontmatterDate?: Date | null): Date {
  const modified = new Date(file.stat.mtime);
  if (!frontmatterDate || frontmatterDate.getTime() <= modified.getTime()) return modified;
  return frontmatterDate;
}

function severityRank(severity: ReviewSeverity): number {
  return severity === 'high' ? 0 : severity === 'medium' ? 1 : 2;
}

export class ProactiveReviewService {
  private state: ReviewStateFile | null = null;

  constructor(
    private app: App,
    private getSettings: () => ProactiveReviewSettings,
  ) {}

  isRelevantPath(path: string): boolean {
    return path === NEXT_ACTIONS_PATH
      || path === WAITING_PATH
      || path === DECISIONS_PATH
      || (path.startsWith(ACTIVE_PROJECTS_PREFIX) && path.endsWith('.md'));
  }

  async shouldRunDaily(now = new Date()): Promise<boolean> {
    const state = await this.loadState();
    return state.lastScanDate !== localDateKey(now);
  }

  async scan(now = new Date()): Promise<ReviewScanResult> {
    const settings = this.getSettings();
    const state = await this.loadState();
    const candidates: ReviewCandidate[] = [];

    const markdownFiles = this.app.vault.getMarkdownFiles();
    const byPath = new Map(markdownFiles.map((file) => [file.path, file]));

    const nextActions = byPath.get(NEXT_ACTIONS_PATH);
    let nextActionsContent = '';
    if (nextActions) {
      nextActionsContent = await this.app.vault.cachedRead(nextActions);
      candidates.push(...this.detectActionTasks(nextActionsContent, now));
    }

    const waiting = byPath.get(WAITING_PATH);
    if (waiting) {
      const content = await this.app.vault.cachedRead(waiting);
      candidates.push(...this.detectWaitingItems(content, now));
    }

    const decisions = byPath.get(DECISIONS_PATH);
    if (decisions) {
      const content = await this.app.vault.cachedRead(decisions);
      candidates.push(...this.detectDecisions(content, now));
    }

    for (const file of markdownFiles) {
      if (!file.path.startsWith(ACTIVE_PROJECTS_PREFIX) || !file.path.endsWith('.md')) continue;
      const content = await this.app.vault.cachedRead(file);
      candidates.push(...this.detectProject(file, content, nextActionsContent, now, settings.projectStaleDays));
    }

    const nowIso = now.toISOString();
    let newCount = 0;
    const visible: ReviewItem[] = [];
    for (const candidate of candidates) {
      const existing = state.records[candidate.id];
      let record = existing;
      if (!record || record.sourceSignature !== candidate.sourceSignature) {
        record = {
          firstSeenAt: nowIso,
          lastSeenAt: nowIso,
          status: 'active',
          sourceSignature: candidate.sourceSignature,
        };
        state.records[candidate.id] = record;
        if (candidate.eligible) newCount++;
      } else {
        record.lastSeenAt = nowIso;
      }

      if (!candidate.eligible) continue;
      if (record.status === 'dismissed' || record.status === 'resolved') continue;
      if (record.status === 'snoozed') {
        const until = record.snoozedUntil ? new Date(record.snoozedUntil) : null;
        if (until && until.getTime() > now.getTime()) continue;
        record.status = 'active';
        delete record.snoozedUntil;
      }

      visible.push({ ...candidate, firstSeenAt: record.firstSeenAt });
    }

    state.lastScanDate = localDateKey(now);
    await this.saveState();

    visible.sort((left, right) => {
      const severity = severityRank(left.severity) - severityRank(right.severity);
      if (severity !== 0) return severity;
      return left.firstSeenAt.localeCompare(right.firstSeenAt);
    });

    return {
      items: visible,
      totalDetected: visible.length,
      viewportItems: Math.max(1, Math.min(10, settings.maxVisible)),
      newCount,
      scannedAt: nowIso,
    };
  }

  async snooze(itemId: string, days: number, now = new Date()): Promise<void> {
    const state = await this.loadState();
    const record = state.records[itemId];
    if (!record) return;
    const until = new Date(now);
    until.setDate(until.getDate() + Math.max(1, days));
    record.status = 'snoozed';
    record.snoozedUntil = until.toISOString();
    await this.saveState();
  }

  async resolve(itemId: string): Promise<void> {
    await this.setStatus(itemId, 'resolved');
  }

  async dismiss(itemId: string, reason: ReviewFeedbackReason = 'not-needed'): Promise<void> {
    const state = await this.loadState();
    const record = state.records[itemId];
    if (!record) return;
    record.status = 'dismissed';
    record.feedbackReason = reason;
    delete record.snoozedUntil;
    await this.saveState();
  }

  async restore(itemId: string): Promise<void> {
    const state = await this.loadState();
    const record = state.records[itemId];
    if (!record || record.status !== 'dismissed') return;
    record.status = 'active';
    delete record.feedbackReason;
    delete record.snoozedUntil;
    await this.saveState();
  }

  async completeTask(item: ReviewItem): Promise<boolean> {
    if (!item.canComplete || !item.taskText) return false;
    const file = this.app.vault.getAbstractFileByPath(item.sourcePath);
    if (!file || !('extension' in file) || file.extension !== 'md') return false;

    const content = await this.app.vault.read(file as TFile);
    const lines = content.split(/\r?\n/);
    const expectedIndex = item.sourceLine ? item.sourceLine - 1 : -1;
    const matchesTask = (line: string) => {
      const match = line.match(/^(\s*[-*]\s+)\[\s\](\s+)(.+?)\s*$/);
      return match && normalizeText(match[3]) === normalizeText(item.taskText ?? '');
    };

    const index = expectedIndex >= 0 && expectedIndex < lines.length && matchesTask(lines[expectedIndex])
      ? expectedIndex
      : lines.findIndex(matchesTask);
    if (index < 0) return false;

    lines[index] = lines[index].replace(/\[\s\]/, '[x]');
    await this.app.vault.modify(file as TFile, lines.join(content.includes('\r\n') ? '\r\n' : '\n'));
    await this.resolve(item.id);
    return true;
  }

  async createDecision(draft: DecisionDraft, now = new Date()): Promise<string> {
    const title = draft.title.trim();
    if (!title) throw new Error('请填写决策内容。');
    if (!parseDate(draft.decisionDate)) throw new Error('做出日期格式应为 YYYY-MM-DD。');
    if (!parseDate(draft.reviewDate)) throw new Error('复盘日期格式应为 YYYY-MM-DD。');

    let file = this.app.vault.getAbstractFileByPath(DECISIONS_PATH);
    let content: string;
    if (file && 'extension' in file && file.extension === 'md') {
      content = await this.app.vault.read(file as TFile);
    } else {
      content = [
        '---',
        'type: decision-log',
        'status: active',
        `created: "${localDateKey(now)}"`,
        `updated: "${localDateKey(now)}"`,
        '---',
        '',
        '# 决策记录',
        '',
        '这里记录重要选择，避免事后只记得情绪，不记得当时的依据。',
        '',
        '## 决策事项',
        '',
        '## 决策模板',
        '',
        '- 决策：',
        '- 背景：',
        '- 判断依据：',
        '- 预期结果：',
        '- 复盘日期：',
        '- 实际结果：',
        '',
      ].join('\n');
      file = await this.app.vault.create(DECISIONS_PATH, content);
    }

    const datePrefix = draft.decisionDate.replace(/-/g, '');
    const existingIds = [...content.matchAll(new RegExp(`D-${datePrefix}-(\\d{3})`, 'g'))]
      .map((match) => Number(match[1]))
      .filter(Number.isFinite);
    const sequence = String((existingIds.length > 0 ? Math.max(...existingIds) : 0) + 1).padStart(3, '0');
    const decisionId = `D-${datePrefix}-${sequence}`;
    const block = [
      `### ${decisionId} ${title}`,
      `- 做出日期：${draft.decisionDate}`,
      '- 当前状态：有效',
      `- 复盘日期：${draft.reviewDate}`,
      `- 背景：${draft.background.trim() || '待补充'}`,
      `- 判断依据：${draft.rationale.trim() || '待补充'}`,
      `- 预期结果：${draft.expectedResult.trim() || '待补充'}`,
      '- 实际结果：待复盘',
    ].join('\n');

    const sectionMatch = content.match(/^##\s+决策事项\s*$/m);
    if (sectionMatch?.index !== undefined) {
      const sectionStart = sectionMatch.index + sectionMatch[0].length;
      const remaining = content.slice(sectionStart);
      const nextSection = remaining.search(/\r?\n##\s+/);
      const insertAt = nextSection >= 0 ? sectionStart + nextSection : content.length;
      content = `${content.slice(0, insertAt).trimEnd()}\n\n${block}\n${content.slice(insertAt)}`;
    } else {
      const templateIndex = content.search(/^##\s+决策模板\s*$/m);
      const insertAt = templateIndex >= 0 ? templateIndex : content.length;
      content = `${content.slice(0, insertAt).trimEnd()}\n\n## 决策事项\n\n${block}\n\n${content.slice(insertAt)}`;
    }
    content = content.replace(
      /^(updated:\s*)["']?\d{4}-\d{2}-\d{2}["']?\s*$/m,
      `$1"${localDateKey(now)}"`,
    );
    await this.app.vault.modify(file as TFile, content);
    return decisionId;
  }

  private async setStatus(itemId: string, status: ReviewItemStatus): Promise<void> {
    const state = await this.loadState();
    const record = state.records[itemId];
    if (!record) return;
    record.status = status;
    delete record.feedbackReason;
    delete record.snoozedUntil;
    await this.saveState();
  }

  private detectActionTasks(content: string, now: Date): ReviewCandidate[] {
    return parseUncheckedTasks(content).flatMap((task) => {
      const section = task.section.trim();
      if (section !== '今天' && section !== '本周') return [];
      const kind: ReviewKind = section === '今天' ? 'today-carryover' : 'weekly-stale';
      const id = this.candidateId(kind, NEXT_ACTIONS_PATH, task.text);
      const existing = this.state?.records[id];
      const firstSeen = existing ? new Date(existing.firstSeenAt) : now;
      const age = Math.max(0, daysBetween(firstSeen, now));
      const threshold = section === '今天' ? 1 : Math.max(1, this.getSettings().weeklyActionDays);
      const eligible = age >= threshold;
      const reason = section === '今天'
        ? `这项“今天”任务已跨过 ${age} 天仍未完成。`
        : `这项“本周”任务已连续 ${age} 天未完成。`;
      return [{
        id,
        kind,
        severity: section === '今天' ? 'high' : 'medium',
        title: task.text,
        reason,
        evidence: `来源于“${section}”，首次跟踪于 ${localDateKey(firstSeen)}。`,
        sourcePath: NEXT_ACTIONS_PATH,
        sourceLine: task.line,
        taskText: task.text,
        canComplete: true,
        sourceSignature: stableHash(`${section}|${normalizeText(task.text)}`),
        eligible,
      }];
    });
  }

  private detectWaitingItems(content: string, now: Date): ReviewCandidate[] {
    const body = content.split(/\r?\n##\s+已解除\b/)[0];
    const lines = body.split(/\r?\n/);
    const candidates: ReviewCandidate[] = [];
    for (let index = 0; index < lines.length; index++) {
      if (!lines[index].trim().startsWith('|')) continue;
      const cells = splitTableRow(lines[index]);
      if (cells.length < 4 || cells[0] === '事项' || isTableDivider(cells) || !cells[0]) continue;
      const followUp = parseDate(cells[3]);
      const overdue = followUp ? daysBetween(followUp, now) >= 0 : false;
      const kind: ReviewKind = followUp ? 'waiting-overdue' : 'waiting-missing-date';
      const identity = `${cells[0]}|${cells[1]}|${cells[2]}`;
      candidates.push({
        id: this.candidateId(kind, WAITING_PATH, identity),
        kind,
        severity: followUp ? 'high' : 'low',
        title: cells[0],
        reason: followUp
          ? `下次跟进日期 ${localDateKey(followUp)} 已到。`
          : '这项等待事项没有下次跟进日期。',
        evidence: `对方或条件：${cells[1] || '未填写'}；记录日期：${cells[2] || '未填写'}。`,
        sourcePath: WAITING_PATH,
        sourceLine: index + 1,
        canComplete: false,
        sourceSignature: stableHash(cells.join('|')),
        eligible: overdue || !followUp,
      });
    }
    return candidates;
  }

  private detectDecisions(content: string, now: Date): ReviewCandidate[] {
    const body = content.split(/\r?\n##\s+决策模板\b/)[0];
    const lines = body.split(/\r?\n/);
    const candidates: ReviewCandidate[] = [];
    for (let index = 0; index < lines.length; index++) {
      if (!lines[index].trim().startsWith('|')) continue;
      const cells = splitTableRow(lines[index]);
      if (cells.length < 5 || cells[0] === '日期' || isTableDivider(cells) || !cells[1]) continue;
      const reviewDate = parseDate(cells[4]);
      const kind: ReviewKind = reviewDate ? 'decision-review-due' : 'decision-missing-review-date';
      const eligible = reviewDate ? daysBetween(reviewDate, now) >= 0 : true;
      candidates.push({
        id: this.candidateId(kind, DECISIONS_PATH, `${cells[0]}|${cells[1]}`),
        kind,
        severity: reviewDate ? 'high' : 'low',
        title: cells[1],
        reason: reviewDate
          ? `这项决策已到 ${localDateKey(reviewDate)} 的复盘时间。`
          : '这项决策尚未设置复盘日期。',
        evidence: `做出日期：${cells[0] || '未填写'}；当时依据：${cells[3] || '未填写'}。`,
        sourcePath: DECISIONS_PATH,
        sourceLine: index + 1,
        canComplete: false,
        sourceSignature: stableHash(cells.join('|')),
        eligible,
      });
    }

    const structured = [...content.matchAll(
      /^###\s+(D-\d{8}-\d{3})\s+(.+?)\s*$([\s\S]*?)(?=^###\s+D-\d{8}-\d{3}\s+|^##\s+|(?![\s\S]))/gm,
    )];
    for (const match of structured) {
      const decisionId = match[1];
      const title = match[2].trim();
      const block = match[3];
      const field = (label: string) => {
        const value = block.match(new RegExp(`^-\\s*${label}[：:]\\s*(.*?)\\s*$`, 'm'));
        return value?.[1]?.trim() ?? '';
      };
      const status = field('当前状态');
      if (/^(?:完成|已完成|撤销|已撤销|结束|已结束)$/.test(status)) continue;
      const reviewDate = parseDate(field('复盘日期'));
      const kind: ReviewKind = reviewDate ? 'decision-review-due' : 'decision-missing-review-date';
      const startLine = content.slice(0, match.index).split(/\r?\n/).length;
      candidates.push({
        id: this.candidateId(kind, DECISIONS_PATH, decisionId),
        kind,
        severity: reviewDate ? 'high' : 'low',
        title,
        reason: reviewDate
          ? `这项决策已到 ${localDateKey(reviewDate)} 的复盘时间。`
          : '这项决策尚未设置复盘日期。',
        evidence: `做出日期：${field('做出日期') || '未填写'}；当时依据：${field('判断依据') || '未填写'}。`,
        sourcePath: DECISIONS_PATH,
        sourceLine: startLine,
        canComplete: false,
        sourceSignature: stableHash(`${decisionId}|${block}`),
        eligible: reviewDate ? daysBetween(reviewDate, now) >= 0 : true,
      });
    }
    return candidates;
  }

  private detectProject(
    file: TFile,
    content: string,
    nextActionsContent: string,
    now: Date,
    staleDays: number,
  ): ReviewCandidate[] {
    const parsed = parseFrontmatter(content);
    if (parsed.fields.type !== 'project' || parsed.fields.status !== 'active') return [];

    const projectName = file.basename;
    const candidates: ReviewCandidate[] = [];
    const nextSection = extractSection(parsed.body, /^(?:当前)?下一步$/);
    const nextTasks = parseUncheckedTasks(`## 下一步\n${nextSection}`);
    if (nextTasks.length === 0) {
      candidates.push({
        id: this.candidateId('project-no-next-action', file.path, projectName),
        kind: 'project-no-next-action',
        severity: 'high',
        title: projectName,
        reason: '活跃项目没有可以直接开始的未完成下一步。',
        evidence: '项目状态为 active，但“下一步”中没有未完成任务。',
        sourcePath: file.path,
        canComplete: false,
        sourceSignature: stableHash(nextSection),
        eligible: true,
      });
    } else if (!this.hasActionConnection(projectName, nextTasks, nextActionsContent)) {
      candidates.push({
        id: this.candidateId('project-action-disconnected', file.path, projectName),
        kind: 'project-action-disconnected',
        severity: 'medium',
        title: projectName,
        reason: '项目内部有下一步，但没有进入全局“下一步行动”清单。',
        evidence: `项目中的下一步：${nextTasks[0].text}`,
        sourcePath: file.path,
        canComplete: false,
        sourceSignature: stableHash(`${nextTasks.map((task) => task.text).join('|')}|${nextActionsContent}`),
        eligible: true,
      });
    }

    const deadline = parseDate(parsed.fields.deadline);
    if (deadline && daysBetween(deadline, now) > 0) {
      candidates.push({
        id: this.candidateId('project-overdue', file.path, projectName),
        kind: 'project-overdue',
        severity: 'high',
        title: projectName,
        reason: `项目截止日期 ${localDateKey(deadline)} 已过去 ${daysBetween(deadline, now)} 天。`,
        evidence: '项目仍处于 active，需要完成、延期或重新界定范围。',
        sourcePath: file.path,
        canComplete: false,
        sourceSignature: stableHash(`${deadline.getTime()}|${file.stat.mtime}|${parsed.fields.status}`),
        eligible: true,
      });
    }

    const modifiedAt = fileModifiedAt(file, parseDate(parsed.fields.updated));
    const inactiveDays = Math.max(0, daysBetween(modifiedAt, now));
    if (inactiveDays >= Math.max(1, staleDays)) {
      candidates.push({
        id: this.candidateId('project-stale', file.path, projectName),
        kind: 'project-stale',
        severity: 'medium',
        title: projectName,
        reason: `项目已 ${inactiveDays} 天没有实质更新。`,
        evidence: `最近更新时间：${localDateKey(modifiedAt)}；停滞阈值：${Math.max(1, staleDays)} 天。`,
        sourcePath: file.path,
        canComplete: false,
        sourceSignature: stableHash(`${file.stat.mtime}|${parsed.fields.updated}|${parsed.fields.status}`),
        eligible: true,
      });
    }

    return candidates;
  }

  private hasActionConnection(projectName: string, tasks: ParsedTask[], nextActionsContent: string): boolean {
    const normalizedActions = normalizeText(nextActionsContent);
    if (!normalizedActions) return false;
    if (normalizedActions.includes(normalizeText(projectName))) return true;

    for (const task of tasks) {
      const normalizedTask = normalizeText(task.text);
      if (normalizedTask.length >= 6 && normalizedActions.includes(normalizedTask)) return true;

      const latinTerms = task.text.match(/[A-Za-z][A-Za-z0-9-]{1,}/g) ?? [];
      const sharedLatinTerms = latinTerms.filter((term) => (
        new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(nextActionsContent)
      ));
      if (sharedLatinTerms.length >= 2) return true;

      const cjk = task.text.replace(/[^\u3400-\u9fff]/g, '');
      for (let index = 0; index <= cjk.length - 5; index++) {
        if (normalizedActions.includes(cjk.slice(index, index + 5))) return true;
      }
    }
    return false;
  }

  private candidateId(kind: ReviewKind, path: string, identity: string): string {
    return `review-${stableHash(`${kind}|${path}|${normalizeText(identity)}`)}`;
  }

  private async loadState(): Promise<ReviewStateFile> {
    if (this.state) return this.state;
    try {
      if (await this.app.vault.adapter.exists(REVIEW_STATE_PATH)) {
        const parsed = JSON.parse(await this.app.vault.adapter.read(REVIEW_STATE_PATH)) as Partial<ReviewStateFile>;
        this.state = {
          version: 1,
          lastScanDate: parsed.lastScanDate,
          records: parsed.records && typeof parsed.records === 'object' ? parsed.records : {},
        };
        return this.state;
      }
    } catch {
      // Invalid runtime state is replaced; knowledge notes are never affected.
    }
    this.state = { version: 1, records: {} };
    return this.state;
  }

  private async saveState(): Promise<void> {
    if (!this.state) return;
    const runtimeDir = REVIEW_STATE_PATH.slice(0, REVIEW_STATE_PATH.lastIndexOf('/'));
    if (!(await this.app.vault.adapter.exists(runtimeDir))) {
      await this.app.vault.adapter.mkdir(runtimeDir);
    }
    await this.app.vault.adapter.write(REVIEW_STATE_PATH, JSON.stringify(this.state, null, 2));
  }
}

import type { App, TFile } from 'obsidian';

import { serializeVaultOperation, writeTextIfUnchanged } from './VaultMutation';

const ACTION_ROOT = '020_行动系统';
const ACTIVE_ROOT = `${ACTION_ROOT}/行动记录/进行中`;
const ARCHIVE_ROOT = `${ACTION_ROOT}/行动记录/归档`;
const LEDGER_PATH = `${ACTION_ROOT}/行动台账.md`;
const STATE_PATH = '.second-brain/runtime/action-workbench-state.json';
const LEGACY_NEXT_ACTIONS = `${ACTION_ROOT}/下一步行动.md`;
const LEGACY_WAITING = `${ACTION_ROOT}/等待与委托.md`;
const LEGACY_PROJECTS_PREFIX = `${ACTION_ROOT}/活跃项目/`;

export function isActionRecordPath(path: string): boolean {
  const normalized = path.replace(/\\/gu, '/');
  return normalized.startsWith(`${ACTION_ROOT}/行动记录/`) && normalized.endsWith('.md');
}

export type WorkbenchActionStatus = 'inbox' | 'today' | 'planned' | 'waiting' | 'completed' | 'cancelled';
export type WorkbenchActionPriority = 'none' | 'high' | 'medium' | 'low';
export type WorkbenchActionType = 'one-off' | 'recurring' | 'maintenance';
export type WorkbenchRecurrence = '' | 'daily' | 'weekdays' | 'weekly' | 'monthly'
  | 'interval-days' | 'interval-weeks' | 'after-completion-days';
export type WorkbenchActionDecision = '' | 'continue' | 'waiting-condition' | 'superseded' | 'not-needed' | 'completed';

export interface ActionStatusDecisionInput {
  decision: Exclude<WorkbenchActionDecision, ''>;
  conclusion: string;
  reason: string;
  evidence?: string;
  reopenCondition?: string;
  effectiveDate?: string;
}

export interface WorkbenchCompletionEntry {
  completedAt: string;
  note: string;
}

export interface WorkbenchAction {
  id: string;
  title: string;
  status: WorkbenchActionStatus;
  priority: WorkbenchActionPriority;
  dueDate: string;
  reminderAt: string;
  project: string;
  note: string;
  sourcePath: string;
  actionType: WorkbenchActionType;
  recurrence: WorkbenchRecurrence;
  recurrenceDays: string;
  recurrenceInterval: number;
  startDate: string;
  endDate: string;
  preferredTime: string;
  nextDueDate: string;
  lastCompletedAt: string;
  completionCount: number;
  completionLog: WorkbenchCompletionEntry[];
  decision: WorkbenchActionDecision;
  currentConclusion: string;
  decisionReason: string;
  decisionEvidence: string;
  reopenCondition: string;
  decisionEffectiveDate: string;
  decisionUpdatedAt: string;
  decisionHistory: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string;
  previousStatus: WorkbenchActionStatus;
  path: string;
}

export interface ActionCreateInput {
  id?: string;
  title: string;
  status?: WorkbenchActionStatus;
  priority?: WorkbenchActionPriority;
  dueDate?: string;
  reminderAt?: string;
  project?: string;
  note?: string;
  sourcePath?: string;
  actionType?: WorkbenchActionType;
  recurrence?: WorkbenchRecurrence;
  recurrenceDays?: string;
  recurrenceInterval?: number;
  startDate?: string;
  endDate?: string;
  preferredTime?: string;
  nextDueDate?: string;
  decision?: WorkbenchActionDecision;
  currentConclusion?: string;
  decisionReason?: string;
  decisionEvidence?: string;
  reopenCondition?: string;
  decisionEffectiveDate?: string;
  decisionUpdatedAt?: string;
  decisionHistory?: string;
}

export interface ActionBrief {
  today: WorkbenchAction[];
  overdue: WorkbenchAction[];
  upcoming: WorkbenchAction[];
  waiting: WorkbenchAction[];
}

interface WorkbenchState {
  version: 1;
  migratedAt?: string;
}

const STATUS_ORDER: Record<WorkbenchActionStatus, number> = {
  today: 0,
  inbox: 1,
  planned: 2,
  waiting: 3,
  completed: 4,
  cancelled: 5,
};

const PRIORITY_ORDER: Record<WorkbenchActionPriority, number> = {
  high: 0,
  medium: 1,
  low: 2,
  none: 3,
};

const DECISION_LABELS: Record<WorkbenchActionDecision, string> = {
  '': '',
  continue: '继续执行',
  'waiting-condition': '等待条件',
  superseded: '原计划已被替代',
  'not-needed': '当前不再需要',
  completed: '已完成',
};

export function actionDecisionLabel(decision: WorkbenchActionDecision): string {
  return DECISION_LABELS[decision];
}

function localDateKey(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function localTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${localDateKey(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function parseLocalDate(value: string): Date | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

function addDays(value: Date, days: number): Date {
  const date = new Date(value.getFullYear(), value.getMonth(), value.getDate());
  date.setDate(date.getDate() + days);
  return date;
}

function daysBetween(left: Date, right: Date): number {
  const leftUtc = Date.UTC(left.getFullYear(), left.getMonth(), left.getDate());
  const rightUtc = Date.UTC(right.getFullYear(), right.getMonth(), right.getDate());
  return Math.floor((rightUtc - leftUtc) / 864e5);
}

function positiveInteger(value: string, fallback = 0): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeRecurrenceDays(value: string): number[] {
  return [...new Set(value.split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item >= 1 && item <= 31))]
    .sort((left, right) => left - right);
}

function isoWeekday(date: Date): number {
  return date.getDay() === 0 ? 7 : date.getDay();
}

function parseCompletionLog(content: string): WorkbenchCompletionEntry[] {
  const section = content.match(/^##\s+执行记录\s*$\n([\s\S]*?)(?=^##\s+|(?![\s\S]))/mu)?.[1] ?? '';
  const entries: WorkbenchCompletionEntry[] = [];
  for (const line of section.split(/\r?\n/u)) {
    const match = line.match(/^-\s+([^|]+?)(?:\s+\|\s+(.*))?$/u);
    if (!match) continue;
    if (match[1].trim() === '暂无') continue;
    entries.push({ completedAt: match[1].trim(), note: match[2]?.trim() ?? '' });
  }
  return entries;
}

function sectionContent(content: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return content.match(new RegExp(`^##\\s+${escaped}\\s*$\\n([\\s\\S]*?)(?=^##\\s+|(?![\\s\\S]))`, 'mu'))?.[1]?.trim() ?? '';
}

export function isLongTermAction(action: Pick<WorkbenchAction, 'actionType'>): boolean {
  return action.actionType === 'recurring' || action.actionType === 'maintenance';
}

export function recurrenceLabel(action: Pick<WorkbenchAction, 'recurrence' | 'recurrenceDays' | 'recurrenceInterval'>): string {
  const weekdays = ['一', '二', '三', '四', '五', '六', '日'];
  if (action.recurrence === 'daily') return '每天';
  if (action.recurrence === 'weekdays') return '工作日';
  if (action.recurrence === 'weekly') {
    const days = normalizeRecurrenceDays(action.recurrenceDays).filter((day) => day <= 7);
    return days.length ? `每周${days.map((day) => weekdays[day - 1]).join('、')}` : '每周';
  }
  if (action.recurrence === 'monthly') {
    const days = normalizeRecurrenceDays(action.recurrenceDays);
    return days.length ? `每月 ${days.join('、')} 日` : '每月';
  }
  if (action.recurrence === 'interval-days') return `每隔 ${Math.max(1, action.recurrenceInterval)} 天`;
  if (action.recurrence === 'interval-weeks') return `每隔 ${Math.max(1, action.recurrenceInterval)} 周`;
  if (action.recurrence === 'after-completion-days') return `完成后 ${Math.max(1, action.recurrenceInterval)} 天复查`;
  return '未设置周期';
}

export function isLongTermCompletedOn(action: WorkbenchAction, date = new Date()): boolean {
  return Boolean(action.lastCompletedAt) && action.lastCompletedAt.slice(0, 10) === localDateKey(date);
}

export function isOneOffScheduledOn(action: WorkbenchAction, date = new Date()): boolean {
  if (isLongTermAction(action) || ['waiting', 'completed', 'cancelled'].includes(action.status)) return false;
  const key = localDateKey(date);
  const end = action.endDate || action.startDate;
  return action.status === 'today' || action.dueDate === key
    || Boolean(action.startDate && key >= action.startDate && key <= end);
}

export function isLongTermScheduledOn(action: WorkbenchAction, date = new Date()): boolean {
  if (!isLongTermAction(action) || ['waiting', 'completed', 'cancelled'].includes(action.status)) return false;
  const key = localDateKey(date);
  if (action.startDate && key < action.startDate) return false;
  if (action.endDate && key > action.endDate) return false;
  if (action.actionType === 'maintenance' && action.nextDueDate) return key >= action.nextDueDate;
  if (action.recurrence === 'daily') return true;
  if (action.recurrence === 'weekdays') return isoWeekday(date) <= 5;
  if (action.recurrence === 'weekly') return normalizeRecurrenceDays(action.recurrenceDays).includes(isoWeekday(date));
  if (action.recurrence === 'monthly') return normalizeRecurrenceDays(action.recurrenceDays).includes(date.getDate());
  const anchor = parseLocalDate(action.startDate || action.createdAt.slice(0, 10));
  if (!anchor || date < anchor) return false;
  const elapsed = daysBetween(anchor, date);
  if (action.recurrence === 'interval-days') return elapsed % Math.max(1, action.recurrenceInterval) === 0;
  if (action.recurrence === 'interval-weeks') return elapsed % (7 * Math.max(1, action.recurrenceInterval)) === 0;
  if (action.recurrence === 'after-completion-days') {
    const due = parseLocalDate(action.nextDueDate || action.startDate);
    return Boolean(due && key >= localDateKey(due));
  }
  return false;
}

function nextScheduledDate(action: WorkbenchAction, after: Date): string {
  if (action.actionType === 'maintenance' && action.recurrence === 'after-completion-days') {
    return localDateKey(addDays(after, Math.max(1, action.recurrenceInterval)));
  }
  for (let offset = 1; offset <= 370; offset++) {
    const candidate = addDays(after, offset);
    if (isLongTermScheduledOn({ ...action, nextDueDate: '' }, candidate)) return localDateKey(candidate);
  }
  return '';
}

function yamlString(value: string): string {
  return JSON.stringify(value.replace(/\r?\n/gu, ' ').trim());
}

function normalizeTitle(value: string): string {
  return value
    .replace(/<!--.*?-->/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function normalizeDecisionText(value: string | undefined): string {
  return (value ?? '').replace(/\s+/gu, ' ').trim();
}

function comparableTitle(value: string): string {
  return normalizeTitle(value)
    .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/gu, '$1')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function titleSimilarity(left: string, right: string): number {
  const leftText = comparableTitle(left);
  const rightText = comparableTitle(right);
  if (leftText === rightText) return 1;
  if (leftText.length < 2 || rightText.length < 2) return 0;
  const counts = new Map<string, number>();
  for (let index = 0; index < leftText.length - 1; index++) {
    const pair = leftText.slice(index, index + 2);
    counts.set(pair, (counts.get(pair) ?? 0) + 1);
  }
  let overlap = 0;
  for (let index = 0; index < rightText.length - 1; index++) {
    const pair = rightText.slice(index, index + 2);
    const count = counts.get(pair) ?? 0;
    if (count > 0) {
      overlap++;
      counts.set(pair, count - 1);
    }
  }
  return (2 * overlap) / (leftText.length + rightText.length - 2);
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/gu, '-');
}

function parseYamlValue(raw: string | undefined): string {
  if (!raw) return '';
  const value = raw.trim();
  if (!value) return '';
  if (value.startsWith('"')) {
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === 'string' ? parsed : String(parsed ?? '');
    } catch {
      return value.replace(/^"|"$/gu, '');
    }
  }
  return value.replace(/^'|'$/gu, '');
}

function frontmatterValue(content: string, key: string): string {
  const frontmatter = content.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/u)?.[1] ?? '';
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.*?)\\s*$`, 'mu'));
  return parseYamlValue(match?.[1]);
}

export function parseActionRecord(path: string, content: string): WorkbenchAction | null {
  if (frontmatterValue(content, 'type') !== 'action') return null;
  const id = frontmatterValue(content, 'id');
  const status = frontmatterValue(content, 'status') as WorkbenchActionStatus;
  const priority = frontmatterValue(content, 'priority') as WorkbenchActionPriority;
  const title = content.match(/^#\s+(.+?)\s*$/mu)?.[1]?.trim() ?? '';
  if (!id || !title || !(status in STATUS_ORDER)) return null;
  const actionTypeValue = frontmatterValue(content, 'action_type') as WorkbenchActionType;
  const actionType: WorkbenchActionType = ['recurring', 'maintenance'].includes(actionTypeValue)
    ? actionTypeValue
    : 'one-off';
  const recurrenceValue = frontmatterValue(content, 'recurrence') as WorkbenchRecurrence;
  const recurrence: WorkbenchRecurrence = [
    'daily', 'weekdays', 'weekly', 'monthly', 'interval-days', 'interval-weeks', 'after-completion-days',
  ].includes(recurrenceValue) ? recurrenceValue : '';
  const decisionValue = frontmatterValue(content, 'decision') as WorkbenchActionDecision;
  const decision: WorkbenchActionDecision = [
    'continue', 'waiting-condition', 'superseded', 'not-needed', 'completed',
  ].includes(decisionValue) ? decisionValue : '';
  const completionLog = parseCompletionLog(content);
  return {
    id,
    title,
    status,
    priority: priority in PRIORITY_ORDER ? priority : 'none',
    dueDate: frontmatterValue(content, 'due'),
    reminderAt: frontmatterValue(content, 'reminder'),
    project: frontmatterValue(content, 'project'),
    note: sectionContent(content, '备注'),
    sourcePath: frontmatterValue(content, 'source'),
    actionType,
    recurrence,
    recurrenceDays: frontmatterValue(content, 'recurrence_days'),
    recurrenceInterval: positiveInteger(frontmatterValue(content, 'recurrence_interval')),
    startDate: frontmatterValue(content, 'start'),
    endDate: frontmatterValue(content, 'end'),
    preferredTime: frontmatterValue(content, 'preferred_time'),
    nextDueDate: frontmatterValue(content, 'next_due'),
    lastCompletedAt: frontmatterValue(content, 'last_completed') || completionLog.at(-1)?.completedAt || '',
    completionCount: positiveInteger(frontmatterValue(content, 'completion_count'), completionLog.length),
    completionLog,
    decision,
    currentConclusion: frontmatterValue(content, 'decision_conclusion'),
    decisionReason: frontmatterValue(content, 'decision_reason'),
    decisionEvidence: frontmatterValue(content, 'decision_evidence'),
    reopenCondition: frontmatterValue(content, 'reopen_condition'),
    decisionEffectiveDate: frontmatterValue(content, 'decision_effective'),
    decisionUpdatedAt: frontmatterValue(content, 'decision_updated'),
    decisionHistory: sectionContent(content, '状态变更记录'),
    createdAt: frontmatterValue(content, 'created'),
    updatedAt: frontmatterValue(content, 'updated'),
    completedAt: frontmatterValue(content, 'completed'),
    previousStatus: (frontmatterValue(content, 'previous_status') as WorkbenchActionStatus) || 'planned',
    path,
  };
}

function actionContent(action: WorkbenchAction): string {
  const lines = [
    '---',
    'type: action',
    `id: ${yamlString(action.id)}`,
    `status: ${action.status}`,
    `priority: ${action.priority}`,
    `due: ${yamlString(action.dueDate)}`,
    `reminder: ${yamlString(action.reminderAt)}`,
    `project: ${yamlString(action.project)}`,
    `source: ${yamlString(action.sourcePath)}`,
    `action_type: ${action.actionType}`,
    `recurrence: ${yamlString(action.recurrence)}`,
    `recurrence_days: ${yamlString(action.recurrenceDays)}`,
    `recurrence_interval: ${action.recurrenceInterval}`,
    `start: ${yamlString(action.startDate)}`,
    `end: ${yamlString(action.endDate)}`,
    `preferred_time: ${yamlString(action.preferredTime)}`,
    `next_due: ${yamlString(action.nextDueDate)}`,
    `last_completed: ${yamlString(action.lastCompletedAt)}`,
    `completion_count: ${action.completionCount}`,
    `decision: ${yamlString(action.decision)}`,
    `decision_conclusion: ${yamlString(action.currentConclusion)}`,
    `decision_reason: ${yamlString(action.decisionReason)}`,
    `decision_evidence: ${yamlString(action.decisionEvidence)}`,
    `reopen_condition: ${yamlString(action.reopenCondition)}`,
    `decision_effective: ${yamlString(action.decisionEffectiveDate)}`,
    `decision_updated: ${yamlString(action.decisionUpdatedAt)}`,
    `previous_status: ${action.previousStatus}`,
    `created: ${yamlString(action.createdAt)}`,
    `updated: ${yamlString(action.updatedAt)}`,
    `completed: ${yamlString(action.completedAt)}`,
    '---',
    '',
    `# ${action.title}`,
    '',
    '## 备注',
    '',
    action.note,
    '',
  ];
  if (action.decision) {
    lines.push(
      '## 当前状态结论',
      '',
      `- 处理方式：${actionDecisionLabel(action.decision)}`,
      `- 当前结论：${action.currentConclusion}`,
      `- 变化原因：${action.decisionReason}`,
      `- 依据：${action.decisionEvidence || '未填写'}`,
      `- 重新激活条件：${action.reopenCondition || '无'}`,
      `- 生效日期：${action.decisionEffectiveDate}`,
      '',
    );
  }
  if (action.decisionHistory) lines.push('## 状态变更记录', '', action.decisionHistory, '');
  if (isLongTermAction(action)) {
    lines.push('## 执行记录', '');
    if (action.completionLog.length === 0) lines.push('- 暂无');
    else for (const entry of action.completionLog) {
      lines.push(`- ${entry.completedAt}${entry.note ? ` | ${entry.note}` : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function actionSort(left: WorkbenchAction, right: WorkbenchAction): number {
  return STATUS_ORDER[left.status] - STATUS_ORDER[right.status]
    || PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority]
    || (left.dueDate || '9999-99-99').localeCompare(right.dueDate || '9999-99-99')
    || left.createdAt.localeCompare(right.createdAt);
}

function patchActionContent(before: string, previous: WorkbenchAction, next: WorkbenchAction): string {
  const oldGenerated = actionContent(previous);
  const generated = actionContent(next);
  const newline = before.includes('\r\n') ? '\r\n' : '\n';
  let result = before.replace(/\r\n/gu, '\n');
  const fields = (text: string) => text.match(/^---\n([\s\S]*?)\n---/u)?.[1].split('\n') ?? [];
  const oldFields = new Map(fields(oldGenerated).map((line) => [line.split(':')[0], line]));
  for (const line of fields(generated)) {
    const key = line.split(':')[0];
    if (oldFields.get(key) === line) continue;
    result = result.replace(/^---\n([\s\S]*?)\n---/u, (_all, body: string) => {
      const pattern = new RegExp(`^${key}:[^\\n]*(?:\\n[ \\t]+[^\\n]*)*`, 'mu');
      const updated = pattern.test(body) ? body.replace(pattern, () => line) : `${body}\n${line}`;
      return `---\n${updated}\n---`;
    });
  }
  if (previous.title !== next.title) result = result.replace(/^#\s+.+$/mu, () => `# ${next.title}`);
  for (const heading of ['备注', '当前状态结论', '状态变更记录', '执行记录']) {
    const pattern = new RegExp(`^## ${heading}\\n[\\s\\S]*?(?=^## |$(?![\\s\\S]))`, 'mu');
    const oldSection = oldGenerated.match(pattern)?.[0] ?? '';
    const section = generated.match(pattern)?.[0] ?? '';
    if (oldSection === section) continue;
    if (pattern.test(result)) result = result.replace(pattern, () => section);
    else if (section) result = `${result.trimEnd()}\n\n${section}`;
  }
  return newline === '\r\n' ? result.replace(/\n/gu, '\r\n') : result;
}

interface ActionCacheEntry { fingerprint: string; record: WorkbenchAction | null }
const actionCaches = new WeakMap<object, Map<string, ActionCacheEntry>>();

export class ActionWorkbenchService {
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private app: App) {}

  handleVaultChange(path: string): void {
    if (this.disposed || !isActionRecordPath(path)) return;
    this.invalidate(path);
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshViews().catch((error) => console.warn('Action views refresh failed', error));
    }, 350);
  }

  dispose(): void {
    this.disposed = true;
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
  }

  async refreshViews(now = new Date()): Promise<void> {
    if (!this.disposed) await this.refreshLedger(now);
  }

  invalidate(path?: string): void {
    if (path) actionCaches.get(this.app.vault)?.delete(path);
    else actionCaches.delete(this.app.vault);
  }

  private async readRecord(file: TFile): Promise<WorkbenchAction | null> {
    let cache = actionCaches.get(this.app.vault);
    if (!cache) actionCaches.set(this.app.vault, cache = new Map());
    const fingerprint = `${file.stat?.mtime}:${file.stat?.size}`;
    const previous = cache.get(file.path);
    if (previous?.fingerprint === fingerprint) return previous.record ? structuredClone(previous.record) : null;
    const record = parseActionRecord(file.path, await this.app.vault.cachedRead(file));
    cache.set(file.path, { fingerprint, record });
    return record ? structuredClone(record) : null;
  }

  async initialize(now = new Date()): Promise<{ imported: number }> {
    return serializeVaultOperation(this.app, 'action-initialize', () => this.initializeRecords(now));
  }

  private async initializeRecords(now: Date): Promise<{ imported: number }> {
    await this.ensureFolder(ACTIVE_ROOT);
    await this.ensureFolder(ARCHIVE_ROOT);
    const state = await this.loadState();
    let imported = 0;
    if (!state.migratedAt) {
      imported = await this.importLegacy(now);
      state.migratedAt = now.toISOString();
      await this.saveState(state);
    }
    await this.refreshLedger(now);
    return { imported };
  }

  async listActions(): Promise<WorkbenchAction[]> {
    const files = this.app.vault.getMarkdownFiles().filter((file) => (
      file.path.startsWith(`${ACTIVE_ROOT}/`) || file.path.startsWith(`${ARCHIVE_ROOT}/`)
    ));
    const paths = new Set(files.map((file) => file.path));
    for (const path of actionCaches.get(this.app.vault)?.keys() ?? []) {
      if (!paths.has(path)) this.invalidate(path);
    }
    const actions: WorkbenchAction[] = [];
    for (const file of files) {
      const record = await this.readRecord(file);
      if (record) actions.push(record);
    }
    return actions.sort(actionSort);
  }

  async getAction(id: string): Promise<WorkbenchAction | null> {
    for (const [path, entry] of actionCaches.get(this.app.vault) ?? []) {
      if (entry.record?.id !== id) continue;
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file && 'extension' in file) return this.readRecord(file as TFile);
      this.invalidate(path);
    }
    return (await this.listActions()).find((action) => action.id === id) ?? null;
  }

  async createAction(input: ActionCreateInput, now = new Date()): Promise<WorkbenchAction> {
    return serializeVaultOperation(this.app, 'action-create', () => this.createActionRecord(input, now));
  }

  private async createActionRecord(input: ActionCreateInput, now: Date): Promise<WorkbenchAction> {
    const title = normalizeTitle(input.title);
    if (!title) throw new Error('行动内容不能为空。');
    const id = input.id?.trim() || await this.nextId(now);
    const timestamp = localTimestamp(now);
    const status = input.status ?? 'inbox';
    const action: WorkbenchAction = {
      id,
      title,
      status,
      priority: input.priority ?? 'none',
      dueDate: input.dueDate?.trim() ?? '',
      reminderAt: input.reminderAt?.trim() ?? '',
      project: input.project?.trim() ?? '',
      note: input.note?.trim() ?? '',
      sourcePath: input.sourcePath?.trim() ?? '',
      actionType: input.actionType ?? 'one-off',
      recurrence: input.recurrence ?? '',
      recurrenceDays: input.recurrenceDays?.trim() ?? '',
      recurrenceInterval: Math.max(0, Math.round(input.recurrenceInterval ?? 0)),
      startDate: input.startDate?.trim() ?? '',
      endDate: input.endDate?.trim() ?? '',
      preferredTime: input.preferredTime?.trim() ?? '',
      nextDueDate: input.nextDueDate?.trim() ?? '',
      lastCompletedAt: '',
      completionCount: 0,
      completionLog: [],
      decision: input.decision ?? '',
      currentConclusion: input.currentConclusion?.trim() ?? '',
      decisionReason: input.decisionReason?.trim() ?? '',
      decisionEvidence: input.decisionEvidence?.trim() ?? '',
      reopenCondition: input.reopenCondition?.trim() ?? '',
      decisionEffectiveDate: input.decisionEffectiveDate?.trim() ?? '',
      decisionUpdatedAt: input.decisionUpdatedAt?.trim() ?? '',
      decisionHistory: input.decisionHistory?.trim() ?? '',
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: status === 'completed' ? timestamp : '',
      previousStatus: status === 'completed' || status === 'cancelled' ? 'planned' : status,
      path: '',
    };
    if (isLongTermAction(action)) {
      action.status = ['completed', 'cancelled'].includes(action.status) ? 'planned' : action.status;
      action.startDate ||= localDateKey(now);
      action.recurrence ||= action.actionType === 'maintenance' ? 'after-completion-days' : 'daily';
      if (['interval-days', 'interval-weeks', 'after-completion-days'].includes(action.recurrence)) {
        action.recurrenceInterval = Math.max(1, action.recurrenceInterval || 1);
      }
      if (action.actionType === 'maintenance') action.nextDueDate ||= action.startDate;
    }
    action.path = this.pathFor(action, now);
    await this.ensureFolder(action.path.split('/').slice(0, -1).join('/'));
    if (await this.app.vault.adapter.exists(action.path)) throw new Error(`行动编号已存在：${action.id}`);
    await this.app.vault.create(action.path, actionContent(action));
    await this.refreshLedger(now);
    return action;
  }

  async updateAction(id: string, changes: Partial<Omit<WorkbenchAction, 'id' | 'path' | 'createdAt'>>, now = new Date()): Promise<WorkbenchAction> {
    return serializeVaultOperation(this.app, `action:${id}`, () => this.updateActionRecord(id, changes, now));
  }

  private async updateActionRecord(id: string, changes: Partial<Omit<WorkbenchAction, 'id' | 'path' | 'createdAt'>>, now: Date): Promise<WorkbenchAction> {
    const location = await this.requireAction(id);
    const before = await this.app.vault.adapter.read(location.path);
    const current = parseActionRecord(location.path, before);
    if (!current) throw new Error('行动记录已变化，请重新打开。');
    const next: WorkbenchAction = {
      ...current,
      ...changes,
      title: changes.title === undefined ? current.title : normalizeTitle(changes.title),
      updatedAt: localTimestamp(now),
    };
    if (!next.title) throw new Error('行动内容不能为空。');
    if (next.status === 'completed' && current.status !== 'completed') {
      next.previousStatus = current.status;
      next.completedAt = localTimestamp(now);
    } else if (next.status === 'cancelled' && current.status !== 'cancelled') {
      next.previousStatus = current.status;
      next.completedAt = localTimestamp(now);
    } else if (!['completed', 'cancelled'].includes(next.status)) {
      next.completedAt = '';
    }
    const nextPath = this.pathFor(next, now);
    await this.ensureFolder(nextPath.split('/').slice(0, -1).join('/'));
    const file = this.app.vault.getAbstractFileByPath(current.path);
    const after = patchActionContent(before, current, { ...next, path: nextPath });
    if (file && 'extension' in file && file.extension === 'md') {
      await writeTextIfUnchanged(this.app, current.path, before, after);
      if (nextPath !== current.path) {
        try { await this.app.fileManager.renameFile(file as TFile, nextPath); } catch (error) {
          await writeTextIfUnchanged(this.app, current.path, after, before);
          throw error;
        }
      }
    } else {
      await writeTextIfUnchanged(this.app, nextPath, nextPath === current.path ? before : null, after);
      if (nextPath !== current.path && await this.app.vault.adapter.exists(current.path)) {
        if (await this.app.vault.adapter.read(current.path) !== before) throw new Error('原行动已变化，保留两个文件以便核对。');
        await this.app.vault.adapter.remove(current.path);
      }
    }
    this.invalidate(current.path);
    this.invalidate(nextPath);
    next.path = nextPath;
    await this.refreshLedger(now);
    return next;
  }

  async recordStatusDecision(id: string, input: ActionStatusDecisionInput, now = new Date()): Promise<WorkbenchAction> {
    const current = await this.requireAction(id);
    const conclusion = normalizeDecisionText(input.conclusion);
    const reason = normalizeDecisionText(input.reason);
    const evidence = normalizeDecisionText(input.evidence);
    const reopenCondition = normalizeDecisionText(input.reopenCondition);
    const effectiveDate = normalizeDecisionText(input.effectiveDate) || localDateKey(now);
    if (!conclusion) throw new Error('请填写当前结论。');
    if (!reason) throw new Error('请填写变化原因。');
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(effectiveDate)) throw new Error('生效日期格式应为 YYYY-MM-DD。');
    if (input.decision === 'waiting-condition' && !reopenCondition) throw new Error('等待条件不能为空。');

    const updatedAt = localTimestamp(now);
    const entry = [
      `### ${updatedAt}`,
      '',
      `- 处理方式：${actionDecisionLabel(input.decision)}`,
      `- 当前结论：${conclusion}`,
      `- 变化原因：${reason}`,
      `- 依据：${evidence || '未填写'}`,
      `- 重新激活条件：${reopenCondition || '无'}`,
      `- 生效日期：${effectiveDate}`,
    ].join('\n');
    const decisionHistory = [current.decisionHistory.trim(), entry].filter(Boolean).join('\n\n');

    let status = current.status;
    if (input.decision === 'waiting-condition') status = 'waiting';
    else if (input.decision === 'superseded' || input.decision === 'not-needed') status = 'cancelled';
    else if (input.decision === 'completed') status = 'completed';
    else if (input.decision === 'continue' && ['waiting', 'completed', 'cancelled'].includes(status)) {
      status = current.previousStatus || 'planned';
    }
    const inactive = ['waiting-condition', 'superseded', 'not-needed', 'completed'].includes(input.decision);
    return this.updateAction(id, {
      status,
      priority: inactive ? 'none' : current.priority,
      dueDate: inactive ? '' : current.dueDate,
      reminderAt: inactive ? '' : current.reminderAt,
      decision: input.decision,
      currentConclusion: conclusion,
      decisionReason: reason,
      decisionEvidence: evidence,
      reopenCondition,
      decisionEffectiveDate: effectiveDate,
      decisionUpdatedAt: updatedAt,
      decisionHistory,
    }, now);
  }

  async completeAction(id: string, now = new Date()): Promise<WorkbenchAction> {
    const current = await this.requireAction(id);
    if (isLongTermAction(current)) return this.completeLongTermOccurrence(id, now);
    return this.updateAction(id, { status: 'completed' }, now);
  }

  async completeLongTermOccurrence(id: string, now = new Date(), note = ''): Promise<WorkbenchAction> {
    const current = await this.requireAction(id);
    if (!isLongTermAction(current)) return this.updateAction(id, { status: 'completed' }, now);
    if (['completed', 'cancelled'].includes(current.status)) throw new Error('这项长期行动已经结束。');
    if (isLongTermCompletedOn(current, now)) return current;
    const completedAt = localTimestamp(now);
    return this.updateAction(id, {
      lastCompletedAt: completedAt,
      completionCount: current.completionCount + 1,
      completionLog: [...current.completionLog, { completedAt, note: note.trim() }],
      nextDueDate: nextScheduledDate(current, now),
    }, now);
  }

  async undoLongTermOccurrence(id: string, now = new Date()): Promise<WorkbenchAction> {
    const current = await this.requireAction(id);
    if (!isLongTermAction(current)) return this.restoreAction(id, now);
    if (!isLongTermCompletedOn(current, now)) return current;
    const currentKey = localDateKey(now);
    const log = [...current.completionLog];
    const index = log.map((entry) => entry.completedAt.slice(0, 10)).lastIndexOf(currentKey);
    if (index >= 0) log.splice(index, 1);
    const previous = log.at(-1)?.completedAt ?? '';
    const nextDueDate = current.actionType === 'maintenance'
      ? (previous
        ? localDateKey(addDays(parseLocalDate(previous.slice(0, 10)) ?? now, Math.max(1, current.recurrenceInterval)))
        : current.startDate)
      : (isLongTermScheduledOn({ ...current, nextDueDate: '' }, now) ? currentKey : current.nextDueDate);
    return this.updateAction(id, {
      lastCompletedAt: previous,
      completionCount: Math.max(0, current.completionCount - 1),
      completionLog: log,
      nextDueDate,
    }, now);
  }

  async finishLongTermAction(id: string, now = new Date()): Promise<WorkbenchAction> {
    const current = await this.requireAction(id);
    if (!isLongTermAction(current)) return this.updateAction(id, { status: 'completed' }, now);
    return this.updateAction(id, { status: 'completed' }, now);
  }

  async cancelAction(id: string, now = new Date()): Promise<WorkbenchAction> {
    return this.updateAction(id, { status: 'cancelled' }, now);
  }

  async restoreAction(id: string, now = new Date()): Promise<WorkbenchAction> {
    const current = await this.requireAction(id);
    const status = ['completed', 'cancelled'].includes(current.status)
      ? current.previousStatus || 'planned'
      : current.status;
    return this.updateAction(id, { status, completedAt: '' }, now);
  }

  async getBrief(now = new Date(), upcomingDays = 7): Promise<ActionBrief> {
    const today = localDateKey(now);
    const upcomingLimit = new Date(now);
    upcomingLimit.setDate(upcomingLimit.getDate() + Math.max(1, upcomingDays));
    const limit = localDateKey(upcomingLimit);
    const active = (await this.listActions()).filter((action) => !['completed', 'cancelled'].includes(action.status));
    const oneOff = active.filter((action) => !isLongTermAction(action) && action.status !== 'waiting');
    const longTermDue = active.filter((action) => isLongTermScheduledOn(action, now) && !isLongTermCompletedOn(action, now));
    return {
      today: [...oneOff.filter((action) => isOneOffScheduledOn(action, now)), ...longTermDue]
        .sort(actionSort),
      overdue: [
        ...oneOff.filter((action) => action.dueDate && action.dueDate < today),
        ...active.filter((action) => action.status !== 'waiting' && action.actionType === 'maintenance'
          && action.nextDueDate && action.nextDueDate < today && !isLongTermCompletedOn(action, now)),
      ].sort(actionSort),
      upcoming: oneOff.filter((action) => {
        const date = action.startDate || action.dueDate;
        return date && date > today && date <= limit;
      }),
      waiting: active.filter((action) => action.status === 'waiting'),
    };
  }

  async getLongTermDue(now = new Date()): Promise<WorkbenchAction[]> {
    return (await this.listActions())
      .filter((action) => isLongTermScheduledOn(action, now) && !isLongTermCompletedOn(action, now))
      .sort(actionSort);
  }

  private async importLegacy(now: Date): Promise<number> {
    const candidates: ActionCreateInput[] = [];
    const files = this.app.vault.getMarkdownFiles().filter((file) => (
      file.path === LEGACY_NEXT_ACTIONS
      || file.path === LEGACY_WAITING
      || file.path.startsWith(LEGACY_PROJECTS_PREFIX)
    ));
    for (const file of files) {
      const content = await this.app.vault.cachedRead(file);
      const lines = content.replace(/\r\n/gu, '\n').split('\n');
      let section = '';
      for (const line of lines) {
        const heading = line.match(/^#{2,6}\s+(.+?)\s*$/u);
        if (heading) {
          section = heading[1].trim();
          continue;
        }
        const task = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.+?)\s*$/u);
        if (!task) continue;
        const title = normalizeTitle(task[2]);
        if (!title) continue;
        const completed = task[1].toLowerCase() === 'x';
        const status: WorkbenchActionStatus = completed
          ? 'completed'
          : section === '今天'
            ? 'today'
            : /等待|之后/u.test(section)
              ? 'waiting'
              : 'planned';
        candidates.push({
          id: line.match(/<!--\s*sb-action:(A-\d{8}-\d{3})\s*-->/iu)?.[1],
          title,
          status,
          project: file.path.startsWith(LEGACY_PROJECTS_PREFIX) ? file.basename : '',
          sourcePath: file.path,
        });
      }
      if (file.path === LEGACY_WAITING) {
        for (const line of lines) {
          if (!line.trim().startsWith('|')) continue;
          const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
          if (cells.length < 4 || !cells[0] || cells[0] === '事项' || /^[-: ]+$/u.test(cells[0])) continue;
          candidates.push({
            id: line.match(/<!--\s*sb-action:(A-\d{8}-\d{3})\s*-->/iu)?.[1],
            title: normalizeTitle(cells[0]),
            status: 'waiting',
            note: `对方或条件：${cells[1]}；记录日期：${cells[2]}`,
            dueDate: /^\d{4}-\d{2}-\d{2}$/u.test(cells[3]) ? cells[3] : '',
            sourcePath: file.path,
          });
        }
      }
    }
    const merged: ActionCreateInput[] = [];
    for (const candidate of candidates) {
      const exactKey = comparableTitle(candidate.title).toLocaleLowerCase();
      const duplicate = merged.find((existing) => {
        const existingKey = comparableTitle(existing.title).toLocaleLowerCase();
        if (exactKey === existingKey) return true;
        const crossesProjectBoundary = Boolean(existing.project) !== Boolean(candidate.project);
        return crossesProjectBoundary
          && existing.status === candidate.status
          && titleSimilarity(existing.title, candidate.title) >= 0.55;
      });
      if (!duplicate) {
        merged.push({ ...candidate });
        continue;
      }
      duplicate.project ||= candidate.project;
      duplicate.id ||= candidate.id;
      if (comparableTitle(candidate.title).length > comparableTitle(duplicate.title).length) {
        duplicate.title = candidate.title;
        duplicate.sourcePath = candidate.sourcePath;
        duplicate.note = candidate.note || duplicate.note;
        duplicate.dueDate = candidate.dueDate || duplicate.dueDate;
      }
    }
    const usedIds = new Set(merged.map((candidate) => candidate.id).filter((id): id is string => Boolean(id)));
    const migrationPrefix = `A-${localDateKey(now).replace(/-/gu, '')}-`;
    let migrationSequence = 500;
    let imported = 0;
    for (const candidate of merged) {
      if (!candidate.id) {
        while (usedIds.has(`${migrationPrefix}${String(migrationSequence).padStart(3, '0')}`)) migrationSequence++;
        candidate.id = `${migrationPrefix}${String(migrationSequence).padStart(3, '0')}`;
        usedIds.add(candidate.id);
        migrationSequence++;
      }
      await this.createAction(candidate, now);
      imported++;
    }
    return imported;
  }

  private async requireAction(id: string): Promise<WorkbenchAction> {
    const action = await this.getAction(id);
    if (!action) throw new Error(`没有找到行动：${id}`);
    return action;
  }

  private pathFor(action: WorkbenchAction, now: Date): string {
    const fileName = `${safeId(action.id)}.md`;
    if (action.status !== 'completed' && action.status !== 'cancelled') return `${ACTIVE_ROOT}/${fileName}`;
    const month = (action.completedAt || localTimestamp(now)).slice(0, 7);
    return `${ARCHIVE_ROOT}/${month}/${fileName}`;
  }

  private async nextId(now: Date): Promise<string> {
    const prefix = `A-${localDateKey(now).replace(/-/gu, '')}-`;
    const ids = (await this.listActions()).map((action) => action.id);
    const max = ids
      .filter((id) => id.startsWith(prefix))
      .map((id) => Number(id.slice(prefix.length)))
      .filter(Number.isFinite)
      .reduce((value, item) => Math.max(value, item), 0);
    return `${prefix}${String(max + 1).padStart(3, '0')}`;
  }

  private async refreshLedger(now: Date): Promise<void> {
    return serializeVaultOperation(this.app, 'action-ledger', () => this.writeLedger(now));
  }

  private async writeLedger(now: Date): Promise<void> {
    const actions = await this.listActions();
    const active = actions.filter((action) => !['completed', 'cancelled'].includes(action.status));
    const oneOff = active.filter((action) => !isLongTermAction(action));
    const longTerm = active.filter(isLongTermAction);
    const sections: Array<{ title: string; status: WorkbenchActionStatus }> = [
      { title: '今天', status: 'today' },
      { title: '收集箱', status: 'inbox' },
      { title: '计划中', status: 'planned' },
      { title: '等待中', status: 'waiting' },
    ];
    const lines = [
      '---',
      'type: action-ledger',
      'status: active',
      `updated: ${localDateKey(now)}`,
      '---',
      '',
      '# 行动台账',
      '',
      '> [!info] 自动生成',
      '> 本页是行动工作台的纸面视图。请在“行动工作台”中新增、勾选、延期和修改事项。',
      '',
    ];
    lines.push('## 长期行动', '');
    if (longTerm.length === 0) lines.push('- 无');
    for (const action of longTerm) {
      const details = [
        recurrenceLabel(action),
        action.preferredTime ? `时间：${action.preferredTime}` : '',
        action.priority !== 'none' ? `优先级：${action.priority}` : '',
        action.decision ? `现状：${actionDecisionLabel(action.decision)}` : '',
        action.nextDueDate ? `下次：${action.nextDueDate}` : '',
        `已完成 ${action.completionCount} 次`,
      ].filter(Boolean).join('；');
      const checked = isLongTermCompletedOn(action, now) ? 'x' : ' ';
      lines.push(`- [${checked}] [[${action.path.replace(/\.md$/u, '')}|${action.title}]]（${details}）`);
    }
    lines.push('');
    for (const section of sections) {
      lines.push(`## ${section.title}`, '');
      const items = oneOff.filter((action) => action.status === section.status);
      if (items.length === 0) lines.push('- 无');
      for (const action of items) {
        const details = [
          action.priority !== 'none' ? `优先级：${action.priority}` : '',
          action.startDate ? `日程：${action.startDate}${action.endDate ? ` 至 ${action.endDate}` : ''}` : '',
          action.dueDate ? `截止：${action.dueDate}` : '',
          action.project ? `项目：${action.project}` : '',
          action.decision ? `现状：${actionDecisionLabel(action.decision)}` : '',
        ].filter(Boolean).join('；');
        lines.push(`- [ ] [[${action.path.replace(/\.md$/u, '')}|${action.title}]]${details ? `（${details}）` : ''}`);
      }
      lines.push('');
    }
    lines.push('## 最近完成', '');
    const completed = actions
      .filter((action) => action.status === 'completed')
      .sort((left, right) => right.completedAt.localeCompare(left.completedAt))
      .slice(0, 20);
    if (completed.length === 0) lines.push('- 无');
    for (const action of completed) {
      lines.push(`- [x] [[${action.path.replace(/\.md$/u, '')}|${action.title}]]（${action.completedAt.slice(0, 10)}）`);
    }
    lines.push('');
    const content = lines.join('\n');
    const before = await this.app.vault.adapter.exists(LEDGER_PATH) ? await this.app.vault.adapter.read(LEDGER_PATH) : null;
    if (before !== content) await writeTextIfUnchanged(this.app, LEDGER_PATH, before, content);
    const waitingBefore = await this.app.vault.adapter.exists(LEGACY_WAITING)
      ? await this.app.vault.adapter.read(LEGACY_WAITING) : null;
    // Only replace an explicitly managed view; legacy handwritten notes stay untouched.
    if (waitingBefore?.includes('<!-- second-brain:waiting-view -->')) {
      const waiting = active.filter((action) => action.status === 'waiting');
      const waitingLines = [
        '---', 'type: action-waiting-view', `updated: ${localDateKey(now)}`, '---', '',
        '# 等待与委托', '', '<!-- second-brain:waiting-view -->', '',
        '> 本页由行动记录自动生成；状态、等待条件和后续动作请在对应行动中维护。', '',
      ];
      if (!waiting.length) waitingLines.push('- 无');
      for (const action of waiting) {
        waitingLines.push(`## [[${action.path.replace(/\.md$/u, '')}|${action.title}]]`, '',
          action.currentConclusion || '当前状态：等待中。', '',
          `- 恢复条件：${action.reopenCondition || '尚未记录，请在行动中补充。'}`, '');
      }
      const waitingContent = waitingLines.join('\n');
      if (waitingBefore !== waitingContent) {
        await writeTextIfUnchanged(this.app, LEGACY_WAITING, waitingBefore, waitingContent);
      }
    }
  }

  private async loadState(): Promise<WorkbenchState> {
    if (!(await this.app.vault.adapter.exists(STATE_PATH))) return { version: 1 };
    try {
      const parsed = JSON.parse(await this.app.vault.adapter.read(STATE_PATH)) as Partial<WorkbenchState>;
      return { version: 1, migratedAt: parsed.migratedAt };
    } catch {
      return { version: 1 };
    }
  }

  private async saveState(state: WorkbenchState): Promise<void> {
    await this.ensureFolder(STATE_PATH.split('/').slice(0, -1).join('/'));
    await this.app.vault.adapter.write(STATE_PATH, JSON.stringify(state, null, 2));
  }

  private async ensureFolder(path: string): Promise<void> {
    const normalized = path.replace(/\\/gu, '/').replace(/\/{2,}/gu, '/').replace(/^\/|\/$/gu, '');
    if (!normalized) return;
    const parts = normalized.split('/');
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!(await this.app.vault.adapter.exists(current))) await this.app.vault.adapter.mkdir(current);
    }
  }
}

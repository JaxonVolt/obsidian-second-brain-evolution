import { type EventRef, Modal, Notice, setIcon } from 'obsidian';

import {
  actionDecisionLabel,
  type ActionStatusDecisionInput,
  type ActionWorkbenchService,
  isActionRecordPath,
  isLongTermAction,
  isLongTermCompletedOn,
  isLongTermScheduledOn,
  isOneOffScheduledOn,
  recurrenceLabel,
  type WorkbenchAction,
  type WorkbenchActionDecision,
  type WorkbenchActionPriority,
  type WorkbenchActionStatus,
  type WorkbenchActionType,
  type WorkbenchRecurrence,
} from '../../core/knowledge/ActionWorkbenchService';
import type SecondBrainPlugin from '../../main';
import { confirm } from '../../shared/modals/ConfirmModal';

const BUILTIN_VIEWS = [
  { id: 'today', label: '今天', icon: 'sun' },
  { id: 'long-term', label: '长期行动', icon: 'repeat-2' },
  { id: 'inbox', label: '收集箱', icon: 'inbox' },
  { id: 'planned', label: '计划中', icon: 'list-todo' },
  { id: 'all', label: '全部行动', icon: 'list-checks' },
  { id: 'scheduled', label: '计划日程', icon: 'calendar-clock' },
  { id: 'waiting', label: '等待事项', icon: 'hourglass' },
  { id: 'projects', label: '项目', icon: 'folder-kanban' },
  { id: 'completed', label: '已完成', icon: 'archive' },
] as const;

const STATUS_LABELS: Record<WorkbenchActionStatus, string> = {
  inbox: '待整理',
  today: '今天',
  planned: '计划中',
  waiting: '等待中',
  completed: '已完成',
  cancelled: '已取消',
};

const PRIORITY_LABELS: Record<WorkbenchActionPriority, string> = {
  none: '未定优先级',
  high: '高',
  medium: '普通',
  low: '低',
};

const CREATE_STATUS_LABELS: Partial<Record<WorkbenchActionStatus, string>> = {
  inbox: '待整理',
  today: '今天',
  planned: '计划中',
  waiting: '等待中',
};

const DECISION_LABELS: Record<Exclude<WorkbenchActionDecision, ''>, string> = {
  continue: '继续执行',
  'waiting-condition': '改为等待条件',
  superseded: '原计划已被替代',
  'not-needed': '当前不再需要',
  completed: '已完成',
};

interface ActionStatusDecisionValues extends ActionStatusDecisionInput {
  decision: Exclude<WorkbenchActionDecision, ''>;
  evidence: string;
  reopenCondition: string;
  effectiveDate: string;
}

interface ActionFormValues {
  title: string;
  status: WorkbenchActionStatus;
  priority: WorkbenchActionPriority;
  dueDate: string;
  reminderAt: string;
  project: string;
  actionType: WorkbenchActionType;
  recurrence: WorkbenchRecurrence;
  recurrenceDays: string;
  recurrenceInterval: number;
  startDate: string;
  endDate: string;
  preferredTime: string;
  nextDueDate: string;
  note: string;
}

const ACTION_TYPE_LABELS: Record<WorkbenchActionType, string> = {
  'one-off': '一次性行动',
  recurring: '周期行动',
  maintenance: '持续维护',
};

const RECURRENCE_LABELS: Record<WorkbenchRecurrence, string> = {
  '': '请选择周期',
  daily: '每天',
  weekdays: '工作日（周一至周五）',
  weekly: '每周指定日期',
  monthly: '每月指定日期',
  'interval-days': '每隔几天',
  'interval-weeks': '每隔几周',
  'after-completion-days': '本次完成后几天复查',
};

type SaveHandler = () => Promise<void>;

function todayKey(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function isActive(action: WorkbenchAction): boolean {
  return !['completed', 'cancelled'].includes(action.status);
}

export class ActionWorkbenchModal extends Modal {
  private bodyEl: HTMLElement | null = null;
  private activeView: string;
  private searchText = '';
  private undoActionId = '';
  private refreshTimer: number | null = null;
  private eventRefs: EventRef[] = [];
  private initialized = false;
  private renderVersion = 0;
  private actions: WorkbenchAction[] = [];
  private shellEl: HTMLElement | null = null;

  constructor(
    app: ConstructorParameters<typeof Modal>[0],
    private plugin: SecondBrainPlugin,
    private service: ActionWorkbenchService,
    initialView?: string,
  ) {
    super(app);
    this.activeView = initialView || plugin.settings.actionWorkbenchDefaultView || 'today';
  }

  onOpen(): void {
    this.modalEl.addClass('second-brain-workbench-modal');
    this.titleEl.setText('行动工作台');
    this.bodyEl = this.contentEl.createDiv({ cls: 'second-brain-workbench-body' });
    this.eventRefs.push(
      this.app.vault.on('create', (file) => this.scheduleRefresh(file.path)),
      this.app.vault.on('modify', (file) => this.scheduleRefresh(file.path)),
      this.app.vault.on('delete', (file) => this.scheduleRefresh(file.path)),
      this.app.vault.on('rename', (file, oldPath) => this.scheduleRefresh(file.path, oldPath)),
    );
    void this.render();
  }

  onClose(): void {
    this.renderVersion++;
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    for (const eventRef of this.eventRefs) this.app.vault.offref(eventRef);
    this.eventRefs = [];
    this.bodyEl = null;
    this.shellEl = null;
    this.contentEl.empty();
  }

  private async render(): Promise<void> {
    if (!this.bodyEl) return;
    const version = ++this.renderVersion;
    this.bodyEl.empty();
    const loading = this.bodyEl.createDiv({ cls: 'second-brain-workbench-loading' });
    setIcon(loading.createSpan(), 'loader-circle');
    loading.createSpan({ text: '正在读取行动…' });
    try {
      if (!this.initialized) {
        await this.service.initialize();
        this.initialized = true;
      }
      const actions = await this.service.listActions();
      if (!this.bodyEl || version !== this.renderVersion) return;
      this.actions = actions;
      this.bodyEl.empty();
      this.renderHeader(actions);
      const shell = this.bodyEl.createDiv({ cls: 'second-brain-workbench-shell' });
      this.shellEl = shell;
      this.renderNavigation(shell, actions);
      this.renderMain(shell, actions);
      this.renderUndo();
    } catch (error) {
      if (!this.bodyEl || version !== this.renderVersion) return;
      this.bodyEl.empty();
      this.bodyEl.createDiv({ cls: 'second-brain-workbench-error', text: `行动工作台加载失败：${error instanceof Error ? error.message : String(error)}` });
    }
  }

  private renderHeader(actions: WorkbenchAction[]): void {
    if (!this.bodyEl) return;
    const header = this.bodyEl.createDiv({ cls: 'second-brain-workbench-header' });
    const summary = header.createDiv({ cls: 'second-brain-workbench-summary' });
    summary.createEl('strong', { text: '你的行动，由你安排' });
    const open = actions.filter(isActive);
    summary.createSpan({ text: `${open.length} 项未完成 · ${open.filter((action) => action.status === 'today').length} 项安排在今天` });

    const tools = header.createDiv({ cls: 'second-brain-workbench-header-tools' });
    const search = tools.createEl('input', { type: 'search', value: this.searchText, placeholder: '搜索行动' });
    search.addEventListener('input', () => {
      this.searchText = search.value;
      if (this.shellEl) {
        this.shellEl.empty();
        this.renderNavigation(this.shellEl, this.actions);
        this.renderMain(this.shellEl, this.actions);
      }
    });
    const create = tools.createEl('button', {
      cls: 'mod-cta second-brain-workbench-create',
      attr: { 'aria-label': '新建行动或日程' },
    });
    setIcon(create.createSpan(), 'plus');
    create.createSpan({ text: '新建行动' });
    create.addEventListener('click', () => this.openCreateModal());
    const layout = tools.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': '自定义工作台' } });
    setIcon(layout, 'sliders-horizontal');
    layout.addEventListener('click', () => {
      new ActionWorkbenchLayoutModal(this.app, this.plugin, async () => this.render()).open();
    });
  }

  private renderNavigation(parent: HTMLElement, actions: WorkbenchAction[]): void {
    const nav = parent.createDiv({ cls: 'second-brain-workbench-nav' });
    const order = this.plugin.settings.actionWorkbenchViewOrder;
    const hidden = new Set(this.plugin.settings.actionWorkbenchHiddenViews);
    const custom = this.plugin.settings.actionWorkbenchCustomViews;
    const definitions = [
      ...BUILTIN_VIEWS,
      ...custom.map((view) => ({ id: view.id, label: view.name, icon: 'filter' as const })),
    ];
    for (const id of order) {
      const definition = definitions.find((item) => item.id === id);
      if (!definition || hidden.has(id)) continue;
      const button = nav.createEl('button', { cls: this.activeView === id ? 'is-active' : '' });
      setIcon(button.createSpan(), definition.icon);
      button.createSpan({ text: definition.label });
      button.createSpan({ cls: 'second-brain-workbench-nav-count', text: String(this.filterActions(actions, id).length) });
      button.addEventListener('click', () => {
        this.activeView = id;
        void this.render();
      });
    }
  }

  private renderMain(parent: HTMLElement, actions: WorkbenchAction[]): void {
    const main = parent.createDiv({ cls: 'second-brain-workbench-main' });
    const filtered = this.filterActions(actions, this.activeView);
    if (filtered.length === 0) {
      const empty = main.createDiv({ cls: 'second-brain-workbench-empty' });
      setIcon(empty.createSpan(), 'circle-check');
      empty.createEl('strong', { text: '这个视图当前没有事项' });
      empty.createSpan({ text: '暂时没有需要处理的行动。' });
      return;
    }
    const list = main.createDiv({
      cls: `second-brain-workbench-list${this.plugin.settings.actionWorkbenchCompactMode ? ' is-compact' : ''}`,
    });
    if (this.activeView === 'today') this.renderTodayGroups(list, filtered);
    else if (this.activeView === 'projects') this.renderProjectGroups(list, filtered);
    else for (const action of filtered) this.renderActionRow(list, action);
  }

  private renderTodayGroups(parent: HTMLElement, actions: WorkbenchAction[]): void {
    const groups = [
      { label: '今日常规行动', actions: actions.filter((action) => !isLongTermAction(action)) },
      { label: '今日长期行动', actions: actions.filter(isLongTermAction) },
    ];
    for (const group of groups) {
      if (group.actions.length === 0) continue;
      const section = parent.createDiv({ cls: 'second-brain-workbench-today-section' });
      const heading = section.createDiv({ cls: 'second-brain-workbench-section-heading' });
      heading.createEl('strong', { text: group.label });
      heading.createSpan({ text: `${group.actions.length} 项` });
      for (const action of group.actions) this.renderActionRow(section, action);
    }
  }

  private openCreateModal(): void {
    const defaultStatus: WorkbenchActionStatus = this.activeView === 'today'
      ? 'today'
      : this.activeView === 'waiting'
        ? 'waiting'
        : this.activeView === 'long-term'
          ? 'planned'
          : 'inbox';
    new ActionFormModal(this.app, 'create', {
      title: '',
      status: defaultStatus,
      priority: 'none',
      dueDate: '',
      reminderAt: '',
      project: '',
      actionType: this.activeView === 'long-term' ? 'recurring' : 'one-off',
      recurrence: '',
      recurrenceDays: '',
      recurrenceInterval: 1,
      startDate: todayKey(),
      endDate: '',
      preferredTime: '',
      nextDueDate: '',
      note: '',
    }, async (values) => {
      await this.service.createAction(values);
      this.activeView = values.status === 'today'
        ? 'today'
        : values.status === 'waiting'
          ? 'waiting'
          : values.actionType !== 'one-off'
            ? 'long-term'
            : 'all';
      await this.render();
    }).open();
  }

  private scheduleRefresh(...paths: string[]): void {
    if (!paths.some(isActionRecordPath)) return;
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      if (this.bodyEl) void this.render();
    }, 250);
  }

  private renderProjectGroups(parent: HTMLElement, actions: WorkbenchAction[]): void {
    const groups = new Map<string, WorkbenchAction[]>();
    for (const action of actions) {
      const project = action.project || '未关联项目';
      groups.set(project, [...(groups.get(project) ?? []), action]);
    }
    for (const [project, items] of groups) {
      const section = parent.createDiv({ cls: 'second-brain-workbench-project' });
      const header = section.createDiv({ cls: 'second-brain-workbench-project-header' });
      setIcon(header.createSpan(), 'folder-kanban');
      header.createEl('strong', { text: project });
      header.createSpan({ text: `${items.length} 项` });
      for (const action of items) this.renderActionRow(section, action);
    }
  }

  private renderActionRow(parent: HTMLElement, action: WorkbenchAction): void {
    const longTerm = isLongTermAction(action);
    const periodCompleted = longTerm && isLongTermCompletedOn(action);
    const row = parent.createDiv({
      cls: `second-brain-workbench-row priority-${action.priority}${longTerm ? ' is-long-term' : ''}${periodCompleted ? ' is-period-complete' : ''}`,
    });
    const checkbox = row.createEl('input', { type: 'checkbox' });
    checkbox.checked = longTerm ? periodCompleted : action.status === 'completed';
    checkbox.setAttribute('aria-label', longTerm
      ? (periodCompleted ? '撤销本次完成' : '完成本次')
      : (action.status === 'completed' ? '恢复行动' : '完成行动'));
    checkbox.addEventListener('change', async () => {
      checkbox.disabled = true;
      try {
        if (longTerm) {
          if (periodCompleted) await this.service.undoLongTermOccurrence(action.id);
          else await this.service.completeLongTermOccurrence(action.id);
        } else if (action.status === 'completed') await this.service.restoreAction(action.id);
        else {
          await this.service.completeAction(action.id);
          this.undoActionId = action.id;
        }
        await this.render();
      } catch (error) {
        checkbox.disabled = false;
        new Notice(error instanceof Error ? error.message : String(error));
      }
    });

    const content = row.createDiv({ cls: 'second-brain-workbench-row-content' });
    const title = content.createDiv({
      cls: 'second-brain-workbench-title',
      text: action.title,
      attr: {
        contenteditable: 'true',
        role: 'textbox',
        tabindex: '0',
        spellcheck: 'true',
        'aria-label': '行动内容',
        'aria-multiline': 'true',
      },
    });
    title.addEventListener('blur', async () => {
      const nextTitle = title.textContent?.trim() ?? '';
      if (nextTitle === action.title) return;
      try {
        await this.service.updateAction(action.id, { title: nextTitle });
        await this.render();
      } catch (error) {
        title.setText(action.title);
        new Notice(error instanceof Error ? error.message : String(error));
      }
    });
    const meta = content.createDiv({ cls: 'second-brain-workbench-meta' });
    if (longTerm) {
      const badge = meta.createSpan({ cls: 'second-brain-workbench-long-term-badge' });
      setIcon(badge.createSpan(), action.actionType === 'maintenance' ? 'activity' : 'repeat-2');
      badge.createSpan({ text: action.actionType === 'maintenance' ? '持续维护' : recurrenceLabel(action) });
      if (action.preferredTime) meta.createSpan({ text: action.preferredTime });
      if (periodCompleted) meta.createSpan({ cls: 'is-complete', text: '今天已完成' });
      else if (action.lastCompletedAt) meta.createSpan({ text: `上次 ${action.lastCompletedAt.slice(0, 10)}` });
      meta.createSpan({ text: `累计 ${action.completionCount} 次` });
    }
    if (!longTerm && action.startDate) meta.createSpan({ text: `${action.startDate}${action.endDate ? ` 至 ${action.endDate}` : ''}` });
    if (action.dueDate) meta.createSpan({ text: action.status !== 'waiting' && action.dueDate < todayKey() ? `已过期 ${action.dueDate}` : action.dueDate });
    if (action.project) meta.createSpan({ text: action.project });
    meta.createSpan({ text: PRIORITY_LABELS[action.priority] });
    if (action.decision) {
      const state = content.createDiv({ cls: 'second-brain-workbench-state' });
      state.createSpan({ cls: 'second-brain-workbench-state-badge', text: actionDecisionLabel(action.decision) });
      if (action.currentConclusion) {
        state.createSpan({ cls: 'second-brain-workbench-state-conclusion', text: action.currentConclusion });
      }
      if (action.reopenCondition) {
        state.createSpan({ cls: 'second-brain-workbench-state-trigger', text: `重新激活：${action.reopenCondition}` });
      }
    }

    const controls = row.createDiv({ cls: 'second-brain-workbench-row-controls' });
    if (!['completed', 'cancelled'].includes(action.status)) {
      const priority = controls.createEl('select', { attr: { 'aria-label': '优先级' } });
      for (const value of Object.keys(PRIORITY_LABELS) as WorkbenchActionPriority[]) {
        priority.createEl('option', { value, text: PRIORITY_LABELS[value] });
      }
      priority.value = action.priority;
      priority.addEventListener('change', async () => {
        await this.service.updateAction(action.id, { priority: priority.value as WorkbenchActionPriority });
        await this.render();
      });
    }
    const edit = controls.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': '修改行动' } });
    setIcon(edit, 'pencil');
    edit.addEventListener('click', () => {
      new ActionFormModal(this.app, 'edit', action, async (changes) => {
        await this.service.updateAction(action.id, changes);
        await this.render();
      }).open();
    });
    const updateStatus = controls.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': '更新现状' } });
    updateStatus.setAttribute('aria-label', '更新现状');
    setIcon(updateStatus, 'history');
    updateStatus.addEventListener('click', () => {
      new ActionStatusDecisionModal(this.app, action, async (changes) => {
        await this.service.recordStatusDecision(action.id, changes);
        await this.render();
      }).open();
    });
    if (isActive(action)) {
      const cancel = controls.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': '取消并归档' } });
      setIcon(cancel, longTerm ? 'circle-stop' : 'archive-x');
      cancel.setAttribute('aria-label', longTerm ? '结束长期行动' : '取消并归档');
      cancel.addEventListener('click', async () => {
        const approved = await confirm(
          this.app,
          longTerm
            ? `结束并归档长期行动“${action.title}”？已有执行记录会保留。`
            : `取消并归档“${action.title}”？之后仍可从已完成视图恢复。`,
          longTerm ? '确认结束' : '确认取消',
        );
        if (!approved) return;
        if (longTerm) await this.service.finishLongTermAction(action.id);
        else await this.service.cancelAction(action.id);
        await this.render();
      });
    }
  }

  private filterActions(actions: WorkbenchAction[], viewId: string): WorkbenchAction[] {
    const query = this.searchText.trim().toLocaleLowerCase();
    let result = actions;
    if (viewId === 'today') result = actions.filter((action) => isActive(action) && (
      isLongTermAction(action)
        ? isLongTermScheduledOn(action)
        : isOneOffScheduledOn(action)
    ));
    else if (viewId === 'long-term') result = actions.filter((action) => isActive(action) && isLongTermAction(action));
    else if (viewId === 'inbox') result = actions.filter((action) => action.status === 'inbox');
    else if (viewId === 'planned') result = actions.filter((action) => action.status === 'planned');
    else if (viewId === 'all') result = actions.filter(isActive);
    else if (viewId === 'scheduled') result = actions.filter((action) => isActive(action)
      && Boolean(action.startDate || action.dueDate || action.reminderAt || (isLongTermAction(action) && action.recurrence)));
    else if (viewId === 'waiting') result = actions.filter((action) => action.status === 'waiting');
    else if (viewId === 'projects') result = actions.filter((action) => isActive(action) && Boolean(action.project));
    else if (viewId === 'completed') result = actions.filter((action) => ['completed', 'cancelled'].includes(action.status));
    else {
      const custom = this.plugin.settings.actionWorkbenchCustomViews.find((view) => view.id === viewId);
      if (custom) {
        result = actions.filter((action) => (
          (custom.statuses.length === 0 || custom.statuses.includes(action.status))
          && (!custom.priority || custom.priority === 'all' || action.priority === custom.priority)
          && (!custom.project || action.project.toLocaleLowerCase().includes(custom.project.toLocaleLowerCase()))
        ));
      }
    }
    if (query) {
      result = result.filter((action) => `${action.title} ${action.project} ${action.note}`.toLocaleLowerCase().includes(query));
    }
    return result;
  }

  private renderUndo(): void {
    if (!this.bodyEl || !this.undoActionId) return;
    const id = this.undoActionId;
    const bar = this.bodyEl.createDiv({ cls: 'second-brain-workbench-undo' });
    bar.createSpan({ text: '行动已完成并自动归档。' });
    const undo = bar.createEl('button', { text: '撤销' });
    undo.addEventListener('click', async () => {
      await this.service.restoreAction(id);
      this.undoActionId = '';
      await this.render();
    });
    const close = bar.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': '关闭' } });
    setIcon(close, 'x');
    close.addEventListener('click', () => {
      this.undoActionId = '';
      bar.remove();
    });
  }
}

class ActionFormModal extends Modal {
  constructor(
    app: ConstructorParameters<typeof Modal>[0],
    private mode: 'create' | 'edit',
    private initialValues: ActionFormValues,
    private onSave: (changes: ActionFormValues) => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(this.mode === 'create' ? '新建行动或日程' : '修改行动');
    this.modalEl.addClass('second-brain-action-edit-modal');
    const values = { ...this.initialValues };
    values.actionType ||= 'one-off';
    if (values.actionType === 'recurring' && !values.recurrence) values.recurrence = 'daily';
    if (values.actionType === 'maintenance' && !values.recurrence) values.recurrence = 'after-completion-days';
    values.recurrenceInterval = Math.max(1, values.recurrenceInterval || 1);
    if (values.actionType !== 'one-off') values.startDate ||= todayKey();
    const form = this.contentEl.createDiv({ cls: 'second-brain-action-edit-form' });
    const title = this.field(form, '行动内容', values.title, (value) => { values.title = value; }, 'text', '要完成什么？');
    this.selectField(form, '状态', this.mode === 'create' ? CREATE_STATUS_LABELS : STATUS_LABELS, values.status, (value) => { values.status = value as WorkbenchActionStatus; });
    this.selectField(form, '优先级', PRIORITY_LABELS, values.priority, (value) => { values.priority = value as WorkbenchActionPriority; });
    const typeSelect = this.selectField(form, '行动类型', ACTION_TYPE_LABELS, values.actionType, (value) => {
      values.actionType = value as WorkbenchActionType;
      if (values.actionType === 'recurring' && !values.recurrence) values.recurrence = 'daily';
      if (values.actionType === 'maintenance' && !values.recurrence) values.recurrence = 'after-completion-days';
    });

    const oneOffFields = form.createDiv({ cls: 'second-brain-action-edit-dependent' });
    this.field(oneOffFields, '日程开始（可选）', values.startDate, (value) => { values.startDate = value; }, 'date');
    this.field(oneOffFields, '日程结束（可选）', values.endDate, (value) => { values.endDate = value; }, 'date');
    this.field(oneOffFields, '截止日期', values.dueDate, (value) => { values.dueDate = value; }, 'date');
    this.field(oneOffFields, '提醒时间', values.reminderAt, (value) => { values.reminderAt = value; }, 'datetime-local');

    const longTermFields = form.createDiv({ cls: 'second-brain-action-edit-dependent' });
    const recurrenceSelect = this.selectField(longTermFields, '执行周期', RECURRENCE_LABELS, values.recurrence, (value) => {
      values.recurrence = value as WorkbenchRecurrence;
    });
    const weeklyField = longTermFields.createDiv({ cls: 'second-brain-action-edit-field second-brain-action-weekdays' });
    weeklyField.createEl('label', { text: '每周执行日' });
    const weekdayChoices = weeklyField.createDiv({ cls: 'second-brain-action-weekday-options' });
    const selectedWeekdays = new Set(values.recurrenceDays.split(',').filter(Boolean));
    for (const [day, label] of [['1', '一'], ['2', '二'], ['3', '三'], ['4', '四'], ['5', '五'], ['6', '六'], ['7', '日']]) {
      const option = weekdayChoices.createEl('label');
      const checkbox = option.createEl('input', { type: 'checkbox' });
      checkbox.checked = selectedWeekdays.has(day);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selectedWeekdays.add(day);
        else selectedWeekdays.delete(day);
        values.recurrenceDays = [...selectedWeekdays].sort().join(',');
      });
      option.createSpan({ text: label });
    }
    const monthlyField = longTermFields.createDiv({ cls: 'second-brain-action-edit-dependent' });
    this.field(monthlyField, '每月执行日', values.recurrenceDays, (value) => { values.recurrenceDays = value; }, 'number', '1—31')
      .setAttribute('min', '1');
    const intervalField = longTermFields.createDiv({ cls: 'second-brain-action-edit-dependent' });
    const interval = this.field(intervalField, '间隔数值', String(values.recurrenceInterval), (value) => {
      values.recurrenceInterval = Math.max(1, Math.round(Number(value) || 1));
    }, 'number', '例如：3');
    interval.setAttribute('min', '1');
    this.field(longTermFields, '开始日期', values.startDate, (value) => { values.startDate = value; }, 'date');
    this.field(longTermFields, '结束日期（可选）', values.endDate, (value) => { values.endDate = value; }, 'date');
    this.field(longTermFields, '执行或提醒时间（可选）', values.preferredTime, (value) => { values.preferredTime = value; }, 'time');
    const nextDueField = longTermFields.createDiv({ cls: 'second-brain-action-edit-dependent' });
    this.field(nextDueField, '首次复查日期', values.nextDueDate, (value) => { values.nextDueDate = value; }, 'date');

    this.field(form, '关联项目', values.project, (value) => { values.project = value; });
    const note = form.createDiv({ cls: 'second-brain-action-edit-field' });
    note.createEl('label', { text: '备注' });
    const area = note.createEl('textarea');
    area.value = values.note;
    area.addEventListener('input', () => { values.note = area.value; });

    const refreshDependentFields = () => {
      const longTerm = values.actionType !== 'one-off';
      oneOffFields.style.display = longTerm ? 'none' : '';
      longTermFields.style.display = longTerm ? '' : 'none';
      const recurrence = recurrenceSelect.value as WorkbenchRecurrence;
      values.recurrence = recurrence;
      weeklyField.style.display = recurrence === 'weekly' ? '' : 'none';
      monthlyField.style.display = recurrence === 'monthly' ? '' : 'none';
      intervalField.style.display = ['interval-days', 'interval-weeks', 'after-completion-days'].includes(recurrence) ? '' : 'none';
      nextDueField.style.display = values.actionType === 'maintenance' ? '' : 'none';
    };
    typeSelect.addEventListener('change', () => {
      if (values.actionType === 'recurring' && (!recurrenceSelect.value || recurrenceSelect.value === 'after-completion-days')) {
        recurrenceSelect.value = 'daily';
      } else if (values.actionType === 'maintenance' && (!recurrenceSelect.value || recurrenceSelect.value === 'daily')) {
        recurrenceSelect.value = 'after-completion-days';
      }
      refreshDependentFields();
    });
    recurrenceSelect.addEventListener('change', refreshDependentFields);
    refreshDependentFields();
    const actions = form.createDiv({ cls: 'second-brain-action-edit-actions' });
    const save = actions.createEl('button', { text: this.mode === 'create' ? '创建' : '保存', cls: 'mod-cta' });
    save.addEventListener('click', async () => {
      values.title = values.title.trim();
      if (!values.title) {
        new Notice('请填写行动内容。');
        title.focus();
        return;
      }
      if (values.endDate && (!values.startDate || values.endDate < values.startDate)) {
        new Notice('请填写开始日期，且结束日期不能早于开始日期。');
        return;
      }
      if (values.actionType !== 'one-off') {
        values.recurrence = recurrenceSelect.value as WorkbenchRecurrence;
        if (!values.recurrence) {
          new Notice('请选择长期行动的执行周期。');
          recurrenceSelect.focus();
          return;
        }
        if (values.recurrence === 'weekly' && !values.recurrenceDays) {
          new Notice('请至少选择一个每周执行日。');
          return;
        }
        if (values.recurrence === 'monthly') {
          const day = Number(values.recurrenceDays);
          if (!Number.isInteger(day) || day < 1 || day > 31) {
            new Notice('每月执行日应为 1—31。');
            return;
          }
        }
        if (values.endDate && values.startDate && values.endDate < values.startDate) {
          new Notice('结束日期不能早于开始日期。');
          return;
        }
        values.dueDate = '';
        values.reminderAt = '';
        if (values.actionType === 'maintenance') values.nextDueDate ||= values.startDate;
      } else {
        values.recurrence = '';
        values.recurrenceDays = '';
        values.recurrenceInterval = 0;
        values.preferredTime = '';
        values.nextDueDate = '';
      }
      save.disabled = true;
      try {
        await this.onSave(values);
        this.close();
      } catch (error) {
        save.disabled = false;
        new Notice(error instanceof Error ? error.message : String(error));
      }
    });
    const cancel = actions.createEl('button', { text: '取消' });
    cancel.addEventListener('click', () => this.close());
    window.setTimeout(() => title.focus(), 0);
  }

  private field(parent: HTMLElement, label: string, value: string, onChange: (value: string) => void, type = 'text', placeholder = ''): HTMLInputElement {
    const wrapper = parent.createDiv({ cls: 'second-brain-action-edit-field' });
    wrapper.createEl('label', { text: label });
    const input = wrapper.createEl('input', { type, value, placeholder });
    input.addEventListener('input', () => onChange(input.value));
    return input;
  }

  private selectField<T extends string>(parent: HTMLElement, label: string, values: Partial<Record<T, string>>, value: T, onChange: (value: string) => void): HTMLSelectElement {
    const wrapper = parent.createDiv({ cls: 'second-brain-action-edit-field' });
    wrapper.createEl('label', { text: label });
    const select = wrapper.createEl('select');
    for (const [key, text] of Object.entries(values) as Array<[T, string]>) select.createEl('option', { value: key, text });
    select.value = value;
    select.addEventListener('change', () => onChange(select.value));
    return select;
  }
}

class ActionStatusDecisionModal extends Modal {
  constructor(
    app: ConstructorParameters<typeof Modal>[0],
    private action: WorkbenchAction,
    private onSave: (changes: ActionStatusDecisionValues) => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText('更新行动现状');
    this.modalEl.addClass('second-brain-action-status-modal');
    const values: ActionStatusDecisionValues = {
      decision: this.action.decision || (this.action.status === 'waiting' ? 'waiting-condition' : 'continue'),
      conclusion: this.action.currentConclusion,
      reason: this.action.decisionReason,
      evidence: this.action.decisionEvidence,
      reopenCondition: this.action.reopenCondition,
      effectiveDate: this.action.decisionEffectiveDate || todayKey(),
    };
    const form = this.contentEl.createDiv({ cls: 'second-brain-action-status-form' });
    form.createEl('strong', { cls: 'second-brain-action-status-subject', text: this.action.title });
    let refreshPreview = () => {};
    const decision = this.selectField(form, '处理方式', DECISION_LABELS, values.decision, (value) => {
      values.decision = value as ActionStatusDecisionValues['decision'];
      refreshPreview();
    });
    const conclusion = this.textArea(form, '当前结论', values.conclusion, (value) => { values.conclusion = value; });
    const reason = this.textArea(form, '变化原因', values.reason, (value) => { values.reason = value; });
    this.textArea(form, '依据（可选）', values.evidence, (value) => { values.evidence = value; });
    const triggerField = form.createDiv({ cls: 'second-brain-action-edit-field' });
    triggerField.createEl('label', { text: '重新激活条件' });
    const trigger = triggerField.createEl('textarea');
    trigger.value = values.reopenCondition;
    trigger.addEventListener('input', () => { values.reopenCondition = trigger.value; });
    const effectiveDate = this.field(form, '生效日期', values.effectiveDate, (value) => { values.effectiveDate = value; }, 'date');
    const preview = form.createDiv({ cls: 'second-brain-action-status-preview' });
    refreshPreview = () => {
      const destination = values.decision === 'waiting-condition'
        ? '等待事项'
        : ['superseded', 'not-needed', 'completed'].includes(values.decision)
          ? '已完成与归档'
          : STATUS_LABELS[this.action.previousStatus] || '计划中';
      preview.setText(`${DECISION_LABELS[values.decision]} · 保存到“${destination}”`);
      triggerField.style.display = values.decision === 'completed' ? 'none' : '';
    };
    refreshPreview();

    const actions = form.createDiv({ cls: 'second-brain-action-edit-actions' });
    const save = actions.createEl('button', { text: '确认更新', cls: 'mod-cta' });
    save.addEventListener('click', async () => {
      values.conclusion = values.conclusion.trim();
      values.reason = values.reason.trim();
      values.evidence = values.evidence.trim();
      values.reopenCondition = values.reopenCondition.trim();
      if (!values.conclusion) {
        new Notice('请填写当前结论。');
        conclusion.focus();
        return;
      }
      if (!values.reason) {
        new Notice('请填写变化原因。');
        reason.focus();
        return;
      }
      if (values.decision === 'waiting-condition' && !values.reopenCondition) {
        new Notice('请填写重新激活条件。');
        trigger.focus();
        return;
      }
      if (!values.effectiveDate) {
        new Notice('请选择生效日期。');
        effectiveDate.focus();
        return;
      }
      save.disabled = true;
      decision.disabled = true;
      try {
        await this.onSave(values);
        new Notice('行动现状已更新，原内容和变更记录已保留。');
        this.close();
      } catch (error) {
        save.disabled = false;
        decision.disabled = false;
        new Notice(error instanceof Error ? error.message : String(error));
      }
    });
  }

  private field(
    parent: HTMLElement,
    label: string,
    value: string,
    onInput: (value: string) => void,
    type = 'text',
  ): HTMLInputElement {
    const wrapper = parent.createDiv({ cls: 'second-brain-action-edit-field' });
    wrapper.createEl('label', { text: label });
    const input = wrapper.createEl('input', { type });
    input.value = value;
    input.addEventListener('input', () => onInput(input.value));
    return input;
  }

  private textArea(
    parent: HTMLElement,
    label: string,
    value: string,
    onInput: (value: string) => void,
  ): HTMLTextAreaElement {
    const wrapper = parent.createDiv({ cls: 'second-brain-action-edit-field' });
    wrapper.createEl('label', { text: label });
    const area = wrapper.createEl('textarea');
    area.value = value;
    area.addEventListener('input', () => onInput(area.value));
    return area;
  }

  private selectField<T extends string>(
    parent: HTMLElement,
    label: string,
    values: Record<T, string>,
    value: T,
    onChange: (value: string) => void,
  ): HTMLSelectElement {
    const wrapper = parent.createDiv({ cls: 'second-brain-action-edit-field' });
    wrapper.createEl('label', { text: label });
    const select = wrapper.createEl('select');
    for (const [key, text] of Object.entries(values) as Array<[T, string]>) select.createEl('option', { value: key, text });
    select.value = value;
    select.addEventListener('change', () => onChange(select.value));
    return select;
  }
}

class ActionWorkbenchLayoutModal extends Modal {
  constructor(
    app: ConstructorParameters<typeof Modal>[0],
    private plugin: SecondBrainPlugin,
    private onSaved: SaveHandler,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText('自定义行动工作台');
    this.modalEl.addClass('second-brain-workbench-layout-modal');
    this.render();
  }

  private render(): void {
    this.contentEl.empty();
    const description = this.contentEl.createDiv({ cls: 'second-brain-workbench-layout-description' });
    description.createEl('strong', { text: '工作台由你决定' });
    description.createSpan({ text: '调整顺序、隐藏不用的模块，或建立自己的筛选视图。' });
    const order = this.plugin.settings.actionWorkbenchViewOrder;
    const hidden = new Set(this.plugin.settings.actionWorkbenchHiddenViews);
    const definitions = [
      ...BUILTIN_VIEWS.map((view) => ({ id: view.id, name: view.label, custom: false })),
      ...this.plugin.settings.actionWorkbenchCustomViews.map((view) => ({ id: view.id, name: view.name, custom: true })),
    ];
    const list = this.contentEl.createDiv({ cls: 'second-brain-workbench-layout-list' });
    for (const id of order) {
      const definition = definitions.find((item) => item.id === id);
      if (!definition) continue;
      const row = list.createDiv({ cls: 'second-brain-workbench-layout-row' });
      row.createSpan({ text: definition.name });
      const visible = row.createEl('input', { type: 'checkbox' });
      visible.checked = !hidden.has(id);
      visible.setAttribute('aria-label', '显示此视图');
      visible.addEventListener('change', async () => {
        if (visible.checked) hidden.delete(id);
        else hidden.add(id);
        this.plugin.settings.actionWorkbenchHiddenViews = [...hidden];
        await this.saveAndRefresh();
      });
      const up = row.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': '上移' } });
      setIcon(up, 'arrow-up');
      up.addEventListener('click', async () => this.move(id, -1));
      const down = row.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': '下移' } });
      setIcon(down, 'arrow-down');
      down.addEventListener('click', async () => this.move(id, 1));
      if (definition.custom) {
        const remove = row.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': '删除自定义视图' } });
        setIcon(remove, 'trash-2');
        remove.addEventListener('click', async () => {
          this.plugin.settings.actionWorkbenchCustomViews = this.plugin.settings.actionWorkbenchCustomViews.filter((view) => view.id !== id);
          this.plugin.settings.actionWorkbenchViewOrder = order.filter((value) => value !== id);
          await this.saveAndRefresh();
        });
      }
    }
    const preferences = this.contentEl.createDiv({ cls: 'second-brain-workbench-layout-preferences' });
    const compactLabel = preferences.createEl('label');
    const compact = compactLabel.createEl('input', { type: 'checkbox' });
    compact.checked = this.plugin.settings.actionWorkbenchCompactMode;
    compactLabel.createSpan({ text: '使用紧凑列表' });
    compact.addEventListener('change', async () => {
      this.plugin.settings.actionWorkbenchCompactMode = compact.checked;
      await this.plugin.saveSettings();
      await this.onSaved();
    });

    const creator = this.contentEl.createDiv({ cls: 'second-brain-workbench-custom-view' });
    creator.createEl('strong', { text: '新建筛选视图' });
    const name = creator.createEl('input', { type: 'text', placeholder: '视图名称' });
    const status = creator.createEl('select');
    status.createEl('option', { value: '', text: '所有状态' });
    for (const [value, label] of Object.entries(STATUS_LABELS)) status.createEl('option', { value, text: label });
    const priority = creator.createEl('select');
    priority.createEl('option', { value: 'all', text: '所有优先级' });
    for (const [value, label] of Object.entries(PRIORITY_LABELS)) priority.createEl('option', { value, text: label });
    const project = creator.createEl('input', { type: 'text', placeholder: '项目包含文字（可选）' });
    const add = creator.createEl('button', { text: '添加视图', cls: 'mod-cta' });
    add.addEventListener('click', async () => {
      if (!name.value.trim()) return;
      const id = `custom-${Date.now()}`;
      this.plugin.settings.actionWorkbenchCustomViews.push({
        id,
        name: name.value.trim(),
        statuses: status.value ? [status.value] : [],
        priority: priority.value,
        project: project.value.trim(),
      });
      this.plugin.settings.actionWorkbenchViewOrder.push(id);
      await this.saveAndRefresh();
    });
  }

  private async move(id: string, offset: number): Promise<void> {
    const order = this.plugin.settings.actionWorkbenchViewOrder;
    const index = order.indexOf(id);
    const target = index + offset;
    if (index < 0 || target < 0 || target >= order.length) return;
    [order[index], order[target]] = [order[target], order[index]];
    await this.saveAndRefresh();
  }

  private async saveAndRefresh(): Promise<void> {
    await this.plugin.saveSettings();
    this.render();
    await this.onSaved();
  }
}

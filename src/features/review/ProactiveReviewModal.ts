import { Modal, Notice, setIcon } from 'obsidian';

import type {
  ActionCatalogItem,
  ActionFeedbackReason,
  ActionLifecycleCenterResult,
  ActionLifecycleRecord,
  ActionLifecycleService,
  ActionPlanOverrides,
  ActionSuggestionKind,
  PreparedActionPlan,
} from '../../core/knowledge/ActionLifecycleService';
import type {
  ProactiveReviewService,
  ReviewFeedbackReason,
  ReviewItem,
  ReviewScanResult,
} from '../../core/knowledge/ProactiveReviewService';
import { confirm } from '../../shared/modals/ConfirmModal';
import { ActionCandidateEditModal } from './ActionCandidateEditModal';
import { DecisionCreateModal } from './DecisionCreateModal';

type ActionCenterTab = 'discoveries' | 'progress' | 'actions' | 'reviews';

interface ProactiveReviewModalActions {
  openSource: (path: string) => Promise<void>;
  startDeepReview: (item: ReviewItem) => Promise<void>;
  discussCandidate: (record: ActionLifecycleRecord) => Promise<void>;
  onCountChanged: (count: number) => void;
}

interface UndoFeedback {
  message: string;
  restore: () => Promise<void>;
}

const KIND_LABELS: Record<ReviewItem['kind'], string> = {
  'project-overdue': '项目逾期',
  'project-action-disconnected': '行动未接通',
  'project-no-next-action': '缺少下一步',
  'project-stale': '项目停滞',
  'today-carryover': '今日遗留',
  'weekly-stale': '本周积压',
  'waiting-overdue': '等待到期',
  'waiting-missing-date': '缺少跟进日期',
  'decision-review-due': '决策待复盘',
  'decision-missing-review-date': '缺少复盘日期',
};

const ACTION_STATUS_LABELS: Record<ActionCatalogItem['status'], string> = {
  'not-started': '未开始',
  'in-progress': '进行中',
  partial: '部分完成',
  completed: '已完成',
  postponed: '已延期',
  waiting: '等待中',
  'adjust-next': '待调整',
  abandoned: '已放弃',
};

const ACTION_FEEDBACK_LABELS: Record<ActionFeedbackReason, string> = {
  outdated: '信息已过期',
  incorrect: '判断有误',
  'not-action': '这不是行动',
  duplicate: '重复信息',
};

const REVIEW_FEEDBACK_LABELS: Record<ReviewFeedbackReason, string> = {
  outdated: '提醒已过期',
  incorrect: '判断有误',
  'not-needed': '不需要提醒',
  duplicate: '重复提醒',
};

function defaultReminderDate(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function needsActionText(kind: ActionSuggestionKind): boolean {
  return ['add-today', 'add-week', 'create-project', 'adjust'].includes(kind);
}

function needsStatusNote(kind: ActionSuggestionKind): boolean {
  return ['complete', 'partial', 'postpone', 'waiting', 'adjust', 'abandon'].includes(kind);
}

export class ProactiveReviewModal extends Modal {
  private bodyEl: HTMLElement | null = null;
  private reviewResult: ReviewScanResult | null = null;
  private lifecycleResult: ActionLifecycleCenterResult | null = null;
  private activeTab: ActionCenterTab = 'discoveries';
  private scanning = false;
  private undoFeedback: UndoFeedback | null = null;

  constructor(
    app: ConstructorParameters<typeof Modal>[0],
    private reviewService: ProactiveReviewService,
    private lifecycleService: ActionLifecycleService,
    private actions: ProactiveReviewModalActions,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass('second-brain-review-modal');
    this.titleEl.setText('行动与复盘中心');
    this.bodyEl = this.contentEl.createDiv({ cls: 'second-brain-review-body' });
    void this.refresh();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async refresh(): Promise<void> {
    if (!this.bodyEl) return;
    this.renderLoading('正在核对行动、进度和复盘证据…');
    try {
      [this.reviewResult, this.lifecycleResult] = await Promise.all([
        this.reviewService.scan(),
        this.lifecycleService.getCenter(),
      ]);
      const pending = this.reviewResult.totalDetected
        + this.lifecycleResult.counts.discoveries
        + this.lifecycleResult.counts.progress;
      this.actions.onCountChanged(pending);
      if (this.activeTab === 'discoveries' && this.lifecycleResult.counts.discoveries === 0) {
        if (this.lifecycleResult.counts.progress > 0) this.activeTab = 'progress';
        else if (this.reviewResult.totalDetected > 0) this.activeTab = 'reviews';
      }
      this.render();
    } catch (error) {
      this.renderError(error instanceof Error ? error.message : String(error));
    }
  }

  private renderLoading(text: string): void {
    if (!this.bodyEl) return;
    this.bodyEl.empty();
    const loading = this.bodyEl.createDiv({ cls: 'second-brain-review-loading' });
    const icon = loading.createSpan();
    setIcon(icon, 'loader-circle');
    loading.createSpan({ text });
  }

  private render(): void {
    if (!this.bodyEl || !this.reviewResult || !this.lifecycleResult) return;
    this.bodyEl.empty();
    this.renderHeader();
    this.renderTabs();
    this.renderUndoFeedback();
    const panel = this.bodyEl.createDiv({ cls: 'second-brain-action-panel' });
    if (this.activeTab === 'discoveries') this.renderCandidates(panel, this.lifecycleResult.discoveries, 'discoveries');
    if (this.activeTab === 'progress') this.renderCandidates(panel, this.lifecycleResult.progress, 'progress');
    if (this.activeTab === 'actions') this.renderActions(panel, this.lifecycleResult.actions);
    if (this.activeTab === 'reviews') this.renderReviews(panel, this.reviewResult.items);
    this.renderFooter();
  }

  private renderHeader(): void {
    if (!this.bodyEl || !this.lifecycleResult) return;
    const header = this.bodyEl.createDiv({ cls: 'second-brain-action-center-header' });
    const summary = header.createDiv({ cls: 'second-brain-review-summary' });
    summary.createEl('strong', { text: '从记录中找回遗漏，并把确认后的进度同步到行动系统' });
    const indexText = this.lifecycleResult.pendingNotes > 0
      ? `有 ${this.lifecycleResult.pendingNotes} 篇新增或变化的笔记待分析。`
      : this.lifecycleResult.analyzedNotes > 0
        ? '当前没有新增笔记待分析。'
        : '尚未进行首次历史扫描。';
    summary.createSpan({ text: indexText });

    const scan = header.createEl('button', { cls: 'mod-cta second-brain-action-scan' });
    const icon = scan.createSpan();
    setIcon(icon, 'scan-search');
    scan.createSpan({ text: this.scanning ? '分析中…' : '扫描遗漏与进度' });
    scan.disabled = this.scanning;
    scan.addEventListener('click', () => void this.scanLifecycle());
  }

  private renderTabs(): void {
    if (!this.bodyEl || !this.lifecycleResult || !this.reviewResult) return;
    const tabs = this.bodyEl.createDiv({ cls: 'second-brain-action-tabs', attr: { role: 'tablist' } });
    const definitions: Array<{ id: ActionCenterTab; label: string; count: number }> = [
      { id: 'discoveries', label: '遗漏事项', count: this.lifecycleResult.counts.discoveries },
      { id: 'progress', label: '待同步进度', count: this.lifecycleResult.counts.progress },
      { id: 'actions', label: '当前行动', count: this.lifecycleResult.counts.actions },
      { id: 'reviews', label: '复盘提醒', count: this.reviewResult.totalDetected },
    ];
    for (const tab of definitions) {
      const button = tabs.createEl('button', {
        cls: `second-brain-action-tab${this.activeTab === tab.id ? ' is-active' : ''}`,
        attr: { role: 'tab', 'aria-selected': String(this.activeTab === tab.id) },
      });
      button.createSpan({ text: tab.label });
      button.createSpan({ cls: 'second-brain-action-tab-count', text: String(tab.count) });
      button.addEventListener('click', () => {
        this.activeTab = tab.id;
        this.render();
      });
    }
  }

  private renderCandidates(
    parent: HTMLElement,
    records: ActionLifecycleRecord[],
    tab: 'discoveries' | 'progress',
  ): void {
    if (!this.lifecycleResult) return;
    if (records.length === 0) {
      const message = tab === 'discoveries'
        ? '没有待确认的遗漏事项。点击“扫描遗漏与进度”分析新增记录。'
        : '没有待同步进度。模型推断不会自动修改 020 行动系统。';
      this.renderEmpty(parent, message);
      return;
    }
    const list = parent.createDiv({ cls: 'second-brain-review-list' });
    for (const record of records) this.renderCandidate(list, record);
  }

  private renderCandidate(parent: HTMLElement, record: ActionLifecycleRecord): void {
    const card = parent.createDiv({ cls: 'second-brain-review-item severity-medium second-brain-action-candidate' });
    const header = card.createDiv({ cls: 'second-brain-review-item-header' });
    header.createSpan({
      cls: 'second-brain-review-kind',
      text: record.category === 'discovery' ? '遗漏候选' : '进度证据',
    });
    header.createEl('strong', { text: record.title });
    header.createSpan({ cls: 'second-brain-action-confidence', text: `${Math.round(record.confidence * 100)}%` });
    card.createDiv({ cls: 'second-brain-review-reason', text: record.summary });
    card.createDiv({ cls: 'second-brain-review-evidence', text: `判断依据：${record.rationale}` });
    const quote = card.createEl('blockquote', { cls: 'second-brain-action-quote' });
    quote.setText(record.evidence.quote);
    if (record.matchedActionId) {
      card.createDiv({
        cls: 'second-brain-action-match',
        text: `匹配行动：${record.matchedActionId}${record.matchedProjectPath ? ` · ${record.matchedProjectPath}` : ''}`,
      });
    }
    const source = card.createEl('button', {
      cls: 'second-brain-review-source',
      text: `${record.evidence.sourcePath}:${record.evidence.sourceLine}`,
    });
    source.addEventListener('click', () => void this.actions.openSource(record.evidence.sourcePath));

    const controls = card.createDiv({ cls: 'second-brain-action-controls' });
    const selection = controls.createEl('select');
    selection.setAttribute('aria-label', '处理建议');
    for (const item of record.suggestions) selection.createEl('option', { value: item.kind, text: item.label });
    const fields = controls.createDiv({ cls: 'second-brain-action-fields' });
    let values: ActionPlanOverrides = {};
    const renderFields = () => {
      fields.empty();
      const kind = selection.value as ActionSuggestionKind;
      const selected = record.suggestions.find((item) => item.kind === kind);
      values = {
        actionText: selected?.actionText ?? record.actionText,
        projectName: selected?.projectName ?? record.projectName,
        reminderDate: defaultReminderDate(selected?.reminderDays ?? 7),
        statusNote: record.summary,
        nextActionText: record.nextActionText,
      };
      if (needsActionText(kind)) {
        this.renderField(fields, kind === 'adjust' ? '调整后的下一步' : '行动内容', values.actionText ?? '', (value) => { values.actionText = value; });
      }
      if (kind === 'create-project') {
        this.renderField(fields, '项目名称', values.projectName ?? '', (value) => { values.projectName = value; });
      }
      if (kind === 'remind') {
        this.renderField(fields, '提醒日期', values.reminderDate ?? '', (value) => { values.reminderDate = value; }, 'date');
      }
      if (needsStatusNote(kind)) {
        this.renderField(fields, '进度或原因', values.statusNote ?? '', (value) => { values.statusNote = value; });
        if (record.matchedProjectPath) {
          this.renderField(fields, '项目新的下一步', values.nextActionText ?? '', (value) => { values.nextActionText = value; });
        }
      }
    };
    selection.addEventListener('change', renderFields);
    renderFields();

    const actions = card.createDiv({ cls: 'second-brain-review-actions' });
    const preview = actions.createEl('button', { text: '预览处理', cls: 'mod-cta' });
    preview.addEventListener('click', () => void this.showPlanPreview(card, record, selection.value as ActionSuggestionKind, values));
    const edit = actions.createEl('button', { cls: 'second-brain-action-icon-text' });
    const editIcon = edit.createSpan();
    setIcon(editIcon, 'pencil');
    edit.createSpan({ text: '快速修改' });
    edit.addEventListener('click', () => {
      new ActionCandidateEditModal(this.app, record, async (changes) => {
        await this.lifecycleService.updateRecord(record.id, changes);
        new Notice('建议已修改，不需要重新调用模型。');
        await this.refresh();
      }).open();
    });
    const editSource = actions.createEl('button', { cls: 'second-brain-action-icon-text' });
    const sourceIcon = editSource.createSpan();
    setIcon(sourceIcon, 'file-pen-line');
    editSource.createSpan({ text: '修改来源' });
    editSource.addEventListener('click', async () => {
      this.close();
      await this.actions.openSource(record.evidence.sourcePath);
    });
    this.renderActionFeedback(actions, record);
    const discuss = actions.createEl('button', { text: '交给 AI 深入讨论', cls: 'second-brain-action-discuss' });
    discuss.addEventListener('click', async () => {
      this.close();
      await this.actions.discussCandidate(record);
    });
  }

  private renderField(
    parent: HTMLElement,
    label: string,
    value: string,
    onChange: (value: string) => void,
    type = 'text',
  ): void {
    const wrapper = parent.createDiv({ cls: 'second-brain-action-field' });
    wrapper.createEl('label', { text: label });
    const input = wrapper.createEl('input', { type, value });
    input.addEventListener('input', () => onChange(input.value));
  }

  private async showPlanPreview(
    card: HTMLElement,
    record: ActionLifecycleRecord,
    kind: ActionSuggestionKind,
    overrides: ActionPlanOverrides,
  ): Promise<void> {
    const existing = card.querySelector('.second-brain-action-plan');
    existing?.remove();
    try {
      const plan = await this.lifecycleService.preparePlan(record.id, kind, overrides);
      this.renderPlan(card, plan);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error), 7000);
    }
  }

  private renderPlan(card: HTMLElement, plan: PreparedActionPlan): void {
    const panel = card.createDiv({ cls: 'second-brain-action-plan' });
    panel.createEl('strong', { text: plan.title });
    panel.createDiv({ cls: 'second-brain-action-plan-summary', text: plan.summary });
    panel.createEl('pre', { text: plan.preview });
    const actions = panel.createDiv({ cls: 'second-brain-review-actions' });
    const apply = actions.createEl('button', { text: '确认执行', cls: 'mod-cta' });
    apply.addEventListener('click', async () => {
      apply.disabled = true;
      try {
        const result = await this.lifecycleService.applyPlan(plan);
        const message = result.changedPaths.length > 0
          ? `已同步 ${result.changedPaths.length} 个文件，并创建回滚点。`
          : '已更新提醒或处理状态。';
        new Notice(message, 6000);
        await this.refresh();
      } catch (error) {
        apply.disabled = false;
        new Notice(error instanceof Error ? error.message : String(error), 8000);
      }
    });
    const cancel = actions.createEl('button', { text: '返回修改' });
    cancel.addEventListener('click', () => panel.remove());
  }

  private renderActions(parent: HTMLElement, items: ActionCatalogItem[]): void {
    if (!this.lifecycleResult) return;
    if (items.length === 0) {
      this.renderEmpty(parent, '当前没有未完成行动。');
      return;
    }
    const list = parent.createDiv({ cls: 'second-brain-review-list second-brain-current-actions' });
    for (const item of items) {
      const row = list.createDiv({ cls: 'second-brain-current-action' });
      const main = row.createDiv();
      const header = main.createDiv({ cls: 'second-brain-current-action-header' });
      header.createSpan({ cls: 'second-brain-review-kind', text: ACTION_STATUS_LABELS[item.status] });
      header.createEl('strong', { text: item.text });
      main.createDiv({
        cls: 'second-brain-review-evidence',
        text: `${item.section || '未分组'} · ${item.persistent ? item.id : '尚未分配稳定 ID'}`,
      });
      const open = row.createEl('button', { cls: 'second-brain-action-icon-text', attr: { 'aria-label': '修改行动来源' } });
      setIcon(open, 'file-search');
      open.createSpan({ text: '修改来源' });
      open.addEventListener('click', async () => {
        this.close();
        await this.actions.openSource(item.locations[0].path);
      });
    }
  }

  private renderReviews(parent: HTMLElement, items: ReviewItem[]): void {
    if (!this.reviewResult) return;
    if (items.length === 0) {
      this.renderEmpty(parent, '当前没有项目停滞、行动积压、等待到期或决策复盘提醒。');
      return;
    }
    const list = parent.createDiv({ cls: 'second-brain-review-list' });
    for (const item of items) this.renderReviewItem(list, item);
  }

  private renderReviewItem(parent: HTMLElement, item: ReviewItem): void {
    const card = parent.createDiv({ cls: `second-brain-review-item severity-${item.severity}` });
    const header = card.createDiv({ cls: 'second-brain-review-item-header' });
    header.createSpan({ cls: 'second-brain-review-kind', text: KIND_LABELS[item.kind] });
    header.createEl('strong', { text: item.title });
    card.createDiv({ cls: 'second-brain-review-reason', text: item.reason });
    card.createDiv({ cls: 'second-brain-review-evidence', text: item.evidence });
    const source = card.createEl('button', { cls: 'second-brain-review-source', text: item.sourcePath });
    source.addEventListener('click', () => void this.actions.openSource(item.sourcePath));

    const actions = card.createDiv({ cls: 'second-brain-review-actions' });
    if (item.canComplete) {
      const complete = actions.createEl('button', { text: '标记完成', cls: 'mod-cta' });
      complete.addEventListener('click', async () => {
        const approved = await confirm(this.app, `将在“${item.sourcePath}”中勾选任务：${item.taskText ?? item.title}`, '确认完成');
        if (!approved) return;
        const changed = await this.reviewService.completeTask(item);
        new Notice(changed ? '任务已标记完成。' : '原任务已经变化，请打开来源核对。');
        await this.refresh();
      });
    }
    const editSource = actions.createEl('button', { cls: 'second-brain-action-icon-text' });
    const editIcon = editSource.createSpan();
    setIcon(editIcon, 'file-pen-line');
    editSource.createSpan({ text: '修改来源' });
    editSource.addEventListener('click', async () => {
      this.close();
      await this.actions.openSource(item.sourcePath);
    });
    const snooze = actions.createEl('select');
    snooze.setAttribute('aria-label', '稍后提醒');
    snooze.createEl('option', { value: '', text: '稍后提醒…' });
    snooze.createEl('option', { value: '1', text: '明天' });
    snooze.createEl('option', { value: '3', text: '3 天后' });
    snooze.createEl('option', { value: '7', text: '一周后' });
    snooze.addEventListener('change', async () => {
      const days = Number(snooze.value);
      if (!days) return;
      await this.reviewService.snooze(item.id, days);
      await this.refresh();
    });
    const resolved = actions.createEl('button', { text: '已处理' });
    resolved.addEventListener('click', async () => {
      await this.reviewService.resolve(item.id);
      await this.refresh();
    });
    this.renderReviewFeedback(actions, item);
    const review = actions.createEl('button', { text: '交给 AI 深入复盘', cls: 'second-brain-action-discuss' });
    review.addEventListener('click', async () => {
      this.close();
      await this.actions.startDeepReview(item);
    });
  }

  private renderActionFeedback(parent: HTMLElement, record: ActionLifecycleRecord): void {
    const feedback = parent.createEl('select', { cls: 'second-brain-quick-feedback' });
    feedback.setAttribute('aria-label', '快速反馈');
    feedback.createEl('option', { value: '', text: '快速反馈…' });
    for (const [value, label] of Object.entries(ACTION_FEEDBACK_LABELS)) {
      feedback.createEl('option', { value, text: label });
    }
    feedback.addEventListener('change', async () => {
      const reason = feedback.value as ActionFeedbackReason;
      if (!reason) return;
      feedback.disabled = true;
      try {
        await this.lifecycleService.dismissRecord(record.id, reason);
        this.undoFeedback = {
          message: `已反馈“${ACTION_FEEDBACK_LABELS[reason]}”，该建议已移出待确认区。`,
          restore: () => this.lifecycleService.restoreRecord(record.id),
        };
        await this.refresh();
      } catch (error) {
        feedback.disabled = false;
        feedback.value = '';
        new Notice(error instanceof Error ? error.message : String(error), 7000);
      }
    });
  }

  private renderReviewFeedback(parent: HTMLElement, item: ReviewItem): void {
    const feedback = parent.createEl('select', { cls: 'second-brain-quick-feedback' });
    feedback.setAttribute('aria-label', '快速反馈');
    feedback.createEl('option', { value: '', text: '快速反馈…' });
    for (const [value, label] of Object.entries(REVIEW_FEEDBACK_LABELS)) {
      feedback.createEl('option', { value, text: label });
    }
    feedback.addEventListener('change', async () => {
      const reason = feedback.value as ReviewFeedbackReason;
      if (!reason) return;
      feedback.disabled = true;
      try {
        await this.reviewService.dismiss(item.id, reason);
        this.undoFeedback = {
          message: `已反馈“${REVIEW_FEEDBACK_LABELS[reason]}”，该提醒已移出列表。`,
          restore: () => this.reviewService.restore(item.id),
        };
        await this.refresh();
      } catch (error) {
        feedback.disabled = false;
        feedback.value = '';
        new Notice(error instanceof Error ? error.message : String(error), 7000);
      }
    });
  }

  private renderUndoFeedback(): void {
    if (!this.bodyEl || !this.undoFeedback) return;
    const feedback = this.undoFeedback;
    const bar = this.bodyEl.createDiv({ cls: 'second-brain-feedback-undo' });
    const icon = bar.createSpan();
    setIcon(icon, 'circle-check');
    bar.createSpan({ text: feedback.message });
    const undo = bar.createEl('button', { text: '撤销' });
    undo.addEventListener('click', async () => {
      undo.disabled = true;
      try {
        await feedback.restore();
        this.undoFeedback = null;
        await this.refresh();
      } catch (error) {
        undo.disabled = false;
        new Notice(error instanceof Error ? error.message : String(error), 7000);
      }
    });
    const close = bar.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': '关闭撤销提示' } });
    setIcon(close, 'x');
    close.addEventListener('click', () => {
      this.undoFeedback = null;
      bar.remove();
    });
  }

  private renderEmpty(parent: HTMLElement, message: string): void {
    const empty = parent.createDiv({ cls: 'second-brain-review-empty' });
    const icon = empty.createSpan();
    setIcon(icon, 'circle-check');
    empty.createEl('strong', { text: message });
  }

  private renderFooter(): void {
    if (!this.bodyEl) return;
    const footer = this.bodyEl.createDiv({ cls: 'second-brain-review-footer' });
    footer.createSpan({ text: '快速纠错在本地生效；正式写入仍需预览确认。' });
    const actions = footer.createDiv({ cls: 'second-brain-review-footer-actions' });
    const decision = actions.createEl('button', { text: '记录决策' });
    decision.addEventListener('click', () => this.openDecisionCreator());
    const refresh = actions.createEl('button', { attr: { 'aria-label': '重新核对' } });
    setIcon(refresh, 'refresh-cw');
    refresh.addEventListener('click', () => void this.refresh());
  }

  private async scanLifecycle(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    this.renderLoading('快速模型正在辨别遗漏事项和进度证据…');
    try {
      const result = await this.lifecycleService.analyze(true);
      const details = [
        result.generated > 0 ? `新增 ${result.generated} 条待确认建议` : '没有新增高置信建议',
        result.remainingNotes > 0 ? `仍有 ${result.remainingNotes} 篇待下一批分析` : '本批索引已处理完',
        result.invalidated > 0 ? `移出 ${result.invalidated} 条失效证据` : '',
      ].filter(Boolean).join('；');
      new Notice(details, 7000);
    } catch (error) {
      new Notice(`行动扫描失败：${error instanceof Error ? error.message : String(error)}`, 8000);
    } finally {
      this.scanning = false;
      await this.refresh();
    }
  }

  private renderError(message: string): void {
    if (!this.bodyEl) return;
    this.bodyEl.empty();
    this.bodyEl.createDiv({ cls: 'second-brain-review-error', text: `检查失败：${message}` });
    const retry = this.bodyEl.createEl('button', { text: '重新检查', cls: 'mod-cta' });
    retry.addEventListener('click', () => void this.refresh());
  }

  private openDecisionCreator(): void {
    new DecisionCreateModal(this.app, this.reviewService, () => void this.refresh()).open();
  }
}

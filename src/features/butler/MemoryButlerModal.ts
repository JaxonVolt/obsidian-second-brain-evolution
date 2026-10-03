import { Modal, Notice, setIcon } from 'obsidian';

import type { ActionLifecycleRecord, ActionLifecycleService } from '../../core/knowledge/ActionLifecycleService';
import {
  type ActionWorkbenchService,
  recurrenceLabel,
  type WorkbenchAction,
  type WorkbenchActionPriority,
} from '../../core/knowledge/ActionWorkbenchService';
import type { InsightRecord, InsightTab, ProactiveInsightService } from '../../core/knowledge/ProactiveInsightService';
import type { ProactiveReviewService, ReviewItem } from '../../core/knowledge/ProactiveReviewService';
import type SecondBrainPlugin from '../../main';
import { InsightEditModal } from '../insight/InsightEditModal';
import {
  InsightSourcesModal,
  ObserveExperienceModal,
  PermanentExperienceModal,
} from '../insight/InsightResolutionModals';
import { ActionCandidateEditModal } from '../review/ActionCandidateEditModal';

type ButlerTab = 'pending' | 'observing' | 'snoozed' | 'history';
type ActionDestination = 'today' | 'planned' | 'inbox' | 'waiting';

interface MemoryButlerActions {
  openSource: (path: string) => Promise<void>;
  discussInsight: (insight: InsightRecord) => Promise<void>;
  discussAction: (record: ActionLifecycleRecord) => Promise<void>;
  discussReview: (item: ReviewItem) => Promise<void>;
  openWorkbench: (view: string) => void;
  onCountChanged: (count: number) => void;
}

const MODE_LABELS = {
  off: '关闭',
  quiet: '安静',
  brief: '管家简报',
  timely: '及时提醒',
} as const;

const MODULE_LABELS: Record<string, string> = {
  'action-discovery': '遗漏事项',
  progress: '进度同步',
  review: '复盘提醒',
  insight: '规律与矛盾',
};

const PRIORITY_LABELS: Record<WorkbenchActionPriority, string> = {
  none: '优先级待定',
  high: '高优先级',
  medium: '普通优先级',
  low: '低优先级',
};

const DESTINATION_LABELS: Record<ActionDestination, string> = {
  today: '今天',
  planned: '计划中',
  inbox: '收集箱',
  waiting: '等待中',
};

export class MemoryButlerModal extends Modal {
  private bodyEl: HTMLElement | null = null;
  private activeTab: ButlerTab = 'pending';
  private scanning = false;
  private lastAddedView = '';
  private lastResultMessage = '';

  constructor(
    app: ConstructorParameters<typeof Modal>[0],
    private plugin: SecondBrainPlugin,
    private actionLifecycle: ActionLifecycleService,
    private reviewService: ProactiveReviewService,
    private insightService: ProactiveInsightService,
    private workbench: ActionWorkbenchService,
    private actions: MemoryButlerActions,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass('second-brain-butler-modal');
    this.titleEl.setText('记忆管家');
    this.bodyEl = this.contentEl.createDiv({ cls: 'second-brain-butler-body' });
    void this.render();
  }

  onClose(): void {
    this.bodyEl = null;
    this.contentEl.empty();
  }

  private async render(): Promise<void> {
    if (!this.bodyEl) return;
    this.bodyEl.empty();
    const loading = this.bodyEl.createDiv({ cls: 'second-brain-butler-loading' });
    setIcon(loading.createSpan(), 'loader-circle');
    loading.createSpan({ text: '正在核对提醒和证据…' });
    try {
      const insightTab: InsightTab = this.activeTab;
      const modules = new Set(this.plugin.settings.memoryButlerModules);
      const [lifecycle, reviews, insights, longTermDue] = await Promise.all([
        modules.has('action-discovery') || modules.has('progress') ? this.actionLifecycle.getCenter() : { discoveries: [], progress: [] },
        modules.has('review') ? this.reviewService.scan() : { items: [] },
        modules.has('insight') ? this.insightService.getCenter(insightTab) : { items: [], counts: { pending: 0, observing: 0, snoozed: 0, history: 0 } },
        this.workbench.getLongTermDue(),
      ]);
      if (!this.bodyEl) return;
      const pendingCount = (modules.has('action-discovery') ? lifecycle.discoveries.length : 0)
        + (modules.has('progress') ? lifecycle.progress.length : 0)
        + (modules.has('review') ? reviews.items.length : 0)
        + (modules.has('insight') ? insights.counts.pending : 0)
        + longTermDue.length;
      this.actions.onCountChanged(pendingCount);
      this.bodyEl.empty();
      this.renderHeader(pendingCount);
      this.renderTabs(pendingCount, insights.counts.observing, insights.counts.snoozed, insights.counts.history);
      const list = this.bodyEl.createDiv({ cls: 'second-brain-butler-list' });
      if (this.activeTab === 'pending') {
        for (const action of longTermDue) this.renderLongTermAction(list, action);
        if (modules.has('action-discovery')) for (const item of lifecycle.discoveries) this.renderActionCandidate(list, item);
        if (modules.has('progress')) for (const item of lifecycle.progress) this.renderProgressCandidate(list, item);
        if (modules.has('review')) for (const item of reviews.items) this.renderReview(list, item);
        if (modules.has('insight')) for (const item of insights.items) this.renderInsight(list, item);
      } else {
        for (const item of insights.items) this.renderInsight(list, item);
      }
      if (!list.childElementCount) this.renderEmpty(list);
      this.renderFooter();
    } catch (error) {
      if (!this.bodyEl) return;
      this.bodyEl.empty();
      this.bodyEl.createDiv({ cls: 'second-brain-butler-error', text: `记忆管家加载失败：${error instanceof Error ? error.message : String(error)}` });
    }
  }

  private renderLongTermAction(parent: HTMLElement, action: WorkbenchAction): void {
    const timing = [recurrenceLabel(action), action.preferredTime ? `建议时间 ${action.preferredTime}` : '今天内完成']
      .filter(Boolean)
      .join(' · ');
    const card = this.card(parent, '长期行动', action.title, `${timing}。需要记录本次完成吗？`);
    const controls = card.createDiv({ cls: 'second-brain-butler-actions' });
    const priority = this.prioritySelect(controls);
    priority.value = action.priority;
    priority.addEventListener('change', async () => {
      await this.workbench.updateAction(action.id, { priority: priority.value as WorkbenchActionPriority });
      await this.render();
    });
    const complete = controls.createEl('button', { text: '完成本次', cls: 'mod-cta' });
    complete.addEventListener('click', async () => {
      complete.disabled = true;
      try {
        await this.workbench.completeLongTermOccurrence(action.id);
        await this.render();
      } catch (error) {
        complete.disabled = false;
        new Notice(`记录失败：${error instanceof Error ? error.message : String(error)}`);
      }
    });
    const open = controls.createEl('button', { text: '打开长期行动' });
    open.addEventListener('click', () => this.actions.openWorkbench('long-term'));
  }

  private renderHeader(pendingCount: number): void {
    if (!this.bodyEl) return;
    const header = this.bodyEl.createDiv({ cls: 'second-brain-butler-header' });
    const summary = header.createDiv({ cls: 'second-brain-butler-summary' });
    summary.createEl('strong', { text: pendingCount ? `有 ${pendingCount} 件事需要你看一眼` : '目前没有需要打扰你的事' });
    summary.createSpan({ text: '我负责发现和提醒，是否行动以及优先级由你决定。' });
    const controls = header.createDiv({ cls: 'second-brain-butler-header-controls' });
    const mode = controls.createEl('select', { attr: { 'aria-label': '管家主动程度' } });
    for (const [value, label] of Object.entries(MODE_LABELS)) mode.createEl('option', { value, text: label });
    mode.value = this.plugin.settings.memoryButlerMode;
    mode.addEventListener('change', async () => {
      this.plugin.settings.memoryButlerMode = mode.value as keyof typeof MODE_LABELS;
      await this.plugin.saveSettings();
    });
    const scan = controls.createEl('button', { cls: 'mod-cta' });
    setIcon(scan.createSpan(), 'scan-search');
    scan.createSpan({ text: this.scanning ? '分析中…' : '检查新增记录' });
    scan.disabled = this.scanning;
    scan.addEventListener('click', () => void this.scan());
    const settings = controls.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': '设置记忆管家' } });
    setIcon(settings, 'sliders-horizontal');
    settings.addEventListener('click', () => new MemoryButlerSettingsModal(this.app, this.plugin, async () => this.render()).open());
  }

  private renderTabs(pending: number, observing: number, snoozed: number, history: number): void {
    if (!this.bodyEl) return;
    const tabs = this.bodyEl.createDiv({ cls: 'second-brain-butler-tabs' });
    const definitions: Array<{ id: ButlerTab; label: string; count: number }> = [
      { id: 'pending', label: '待我确认', count: pending },
      { id: 'observing', label: '继续观察', count: observing },
      { id: 'snoozed', label: '稍后提醒', count: snoozed },
      { id: 'history', label: '处理记录', count: history },
    ];
    for (const tab of definitions) {
      const button = tabs.createEl('button', { cls: this.activeTab === tab.id ? 'is-active' : '' });
      button.createSpan({ text: tab.label });
      button.createSpan({ text: String(tab.count) });
      button.addEventListener('click', () => {
        this.activeTab = tab.id;
        void this.render();
      });
    }
  }

  private renderActionCandidate(parent: HTMLElement, record: ActionLifecycleRecord): void {
    const card = this.card(parent, '遗漏事项', record.title, `${record.summary} 还准备继续吗？`);
    this.evidence(card, record.evidence.sourcePath, record.evidence.quote);
    const controls = card.createDiv({ cls: 'second-brain-butler-actions' });
    const priority = this.prioritySelect(controls);
    const destination = this.destinationSelect(controls);
    const dueDate = this.dueDateInput(controls);
    const add = controls.createEl('button', { text: '加入行动', cls: 'mod-cta second-brain-butler-add' });
    add.disabled = true;
    destination.addEventListener('change', () => {
      add.disabled = !destination.value;
    });
    add.addEventListener('click', async () => {
      const selected = destination.value as ActionDestination;
      if (!selected) return;
      add.disabled = true;
      try {
        const action = await this.workbench.createAction({
          title: record.actionText || record.title,
          status: selected,
          priority: priority.value as WorkbenchActionPriority,
          dueDate: dueDate.value,
          project: record.projectName,
          sourcePath: record.evidence.sourcePath,
        });
        await this.actionLifecycle.markAppliedExternally(record.id, action.path);
        this.lastAddedView = selected;
        new Notice(`已加入行动工作台 · ${DESTINATION_LABELS[selected]}。`);
        await this.render();
      } catch (error) {
        add.disabled = false;
        new Notice(`加入失败：${error instanceof Error ? error.message : String(error)}`, 7000);
      }
    });
    this.snoozeControl(controls, async (days) => this.actionLifecycle.snoozeRecord(record.id, days));
    this.localCorrectionControls(controls, record);
    this.moreButton(controls, '让 AI 深入分析', async () => this.actions.discussAction(record));
  }

  private renderProgressCandidate(parent: HTMLElement, record: ActionLifecycleRecord): void {
    const card = this.card(parent, '进度同步', record.title, record.summary);
    this.evidence(card, record.evidence.sourcePath, record.evidence.quote);
    const controls = card.createDiv({ cls: 'second-brain-butler-actions' });
    const sync = controls.createEl('button', { text: '同步到工作台', cls: 'mod-cta' });
    sync.addEventListener('click', async () => {
      const action = record.matchedActionId ? await this.workbench.getAction(record.matchedActionId) : null;
      if (!action) {
        new Notice('没有找到对应行动，请先修改匹配关系或在工作台中处理。');
        return;
      }
      if (record.progressStatus === 'completed') await this.workbench.completeAction(action.id);
      else if (record.progressStatus === 'waiting') await this.workbench.updateAction(action.id, { status: 'waiting', note: record.summary });
      else await this.workbench.updateAction(action.id, { note: record.summary });
      await this.actionLifecycle.markAppliedExternally(record.id, action.path);
      await this.render();
    });
    const handled = controls.createEl('button', { text: '已处理' });
    handled.addEventListener('click', async () => {
      await this.actionLifecycle.markAppliedExternally(record.id, '');
      await this.render();
    });
    this.localCorrectionControls(controls, record);
    this.moreButton(controls, '让 AI 深入分析', async () => this.actions.discussAction(record));
  }

  private renderReview(parent: HTMLElement, item: ReviewItem): void {
    const card = this.card(parent, '到期提醒', item.title, item.reason);
    this.evidence(card, item.sourcePath, item.evidence);
    const controls = card.createDiv({ cls: 'second-brain-butler-actions' });
    if (item.canComplete) {
      const complete = controls.createEl('button', { text: '标记完成', cls: 'mod-cta' });
      complete.addEventListener('click', async () => {
        const matched = (await this.workbench.listActions()).find((action) => action.title === (item.taskText ?? item.title));
        if (matched) await this.workbench.completeAction(matched.id);
        else await this.reviewService.completeTask(item);
        await this.reviewService.resolve(item.id);
        await this.render();
      });
    }
    this.snoozeControl(controls, async (days) => this.reviewService.snooze(item.id, days));
    const done = controls.createEl('button', { text: '不再提醒' });
    done.addEventListener('click', async () => {
      await this.reviewService.dismiss(item.id, 'not-needed');
      await this.render();
    });
    this.sourceButton(controls, item.sourcePath);
    this.moreButton(controls, '让 AI 深入复盘', async () => this.actions.discussReview(item));
  }

  private renderInsight(parent: HTMLElement, insight: InsightRecord): void {
    const card = this.card(parent, this.insightService.getKindLabel(insight.kind), insight.title, insight.summary);
    if (insight.suggestedAction) card.createDiv({ cls: 'second-brain-butler-suggestion', text: `可能的下一步：${insight.suggestedAction}` });
    if (insight.observation) {
      const progress = `${insight.observation.matches.length}/${insight.observation.targetEvidenceCount}`;
      card.createDiv({
        cls: `second-brain-butler-observation${insight.observation.readyForReview ? ' is-ready' : ''}`,
        text: insight.observation.readyForReview
          ? `已积累 ${progress} 条证据或发现反例，需要重新决定。`
          : `待验证经验 · 已积累 ${progress} 条相关记录。`,
      });
    }
    const firstEvidence = insight.evidence[0];
    if (firstEvidence) this.evidence(card, firstEvidence.sourcePath, firstEvidence.quote);
    const controls = card.createDiv({ cls: 'second-brain-butler-actions' });
    if (insight.status === 'pending' || insight.status === 'observing') {
      const priority = this.prioritySelect(controls);
      const destination = this.destinationSelect(controls);
      const dueDate = this.dueDateInput(controls);
      const add = controls.createEl('button', { text: '加入行动', cls: 'mod-cta second-brain-butler-add' });
      add.disabled = true;
      destination.addEventListener('change', () => {
        add.disabled = !destination.value;
      });
      add.addEventListener('click', async () => {
        const selected = destination.value as ActionDestination;
        if (!selected) return;
        add.disabled = true;
        try {
          const action = await this.workbench.createAction({
            title: insight.suggestedAction || insight.title,
            status: selected,
            priority: priority.value as WorkbenchActionPriority,
            dueDate: dueDate.value,
            sourcePath: firstEvidence?.sourcePath ?? '',
            note: insight.summary,
          });
          await this.insightService.markActionConverted(insight.id, action.path);
          this.lastAddedView = selected;
          this.lastResultMessage = `已加入行动工作台 · ${DESTINATION_LABELS[selected]} · ${action.path}`;
          new Notice(this.lastResultMessage);
          await this.render();
        } catch (error) {
          add.disabled = false;
          new Notice(`加入失败：${error instanceof Error ? error.message : String(error)}`, 7000);
        }
      });
      const edit = controls.createEl('button', { text: '修改判断' });
      edit.addEventListener('click', () => {
        new InsightEditModal(this.app, insight, async (changes) => {
          await this.insightService.updateInsight(insight.id, changes);
          this.lastResultMessage = '判断文字已保存，尚未改变去向。';
          await this.render();
        }).open();
      });
      const permanent = controls.createEl('button', { text: '沉淀经验' });
      permanent.addEventListener('click', () => {
        new PermanentExperienceModal(this.app, insight, async (draft) => {
          const path = await this.insightService.convertToPermanent(insight.id, draft);
          this.lastResultMessage = `已沉淀为长期经验 · ${path}`;
          new Notice(this.lastResultMessage);
          await this.render();
        }).open();
      });
      const observe = controls.createEl('button', { text: insight.observation ? '调整观察' : '继续观察' });
      observe.addEventListener('click', () => {
        new ObserveExperienceModal(this.app, insight, async (draft) => {
          const path = await this.insightService.startObservation(insight.id, draft);
          this.lastResultMessage = `已保存为待验证经验 · ${path}`;
          new Notice(this.lastResultMessage);
          this.activeTab = 'observing';
          await this.render();
        }).open();
      });
      this.snoozeControl(controls, async (days) => this.insightService.snooze(insight.id, days));
      const sources = controls.createEl('button', { text: '修改来源' });
      sources.addEventListener('click', () => {
        new InsightSourcesModal(this.app, insight.evidence, this.actions.openSource).open();
      });
      const dismiss = controls.createEl('button', { text: '不需要' });
      dismiss.addEventListener('click', async () => {
        await this.insightService.dismiss(insight.id);
        this.lastResultMessage = '已标记为不需要，并放入处理记录。';
        await this.render();
      });
      this.moreButton(controls, '让 AI 深入分析', async () => this.actions.discussInsight(insight));
    } else if (insight.status === 'snoozed') {
      const restore = controls.createEl('button', { text: '现在处理' });
      restore.addEventListener('click', async () => {
        await this.insightService.restore(insight.id);
        this.activeTab = 'pending';
        await this.render();
      });
    } else {
      if (insight.convertedTo) {
        const target = controls.createEl('button', { text: '打开处理结果' });
        target.addEventListener('click', () => void this.actions.openSource(insight.convertedTo ?? ''));
      }
      if (firstEvidence) this.sourceButton(controls, firstEvidence.sourcePath);
    }
  }

  private card(parent: HTMLElement, kind: string, title: string, question: string): HTMLElement {
    const card = parent.createDiv({ cls: 'second-brain-butler-card' });
    const header = card.createDiv({ cls: 'second-brain-butler-card-header' });
    header.createSpan({ text: kind });
    header.createEl('strong', { text: title });
    card.createDiv({ cls: 'second-brain-butler-question', text: question });
    return card;
  }

  private evidence(card: HTMLElement, path: string, quote: string): void {
    const details = card.createEl('details', { cls: 'second-brain-butler-evidence' });
    details.createEl('summary', { text: '查看依据' });
    const source = details.createEl('button', { text: path });
    source.addEventListener('click', () => void this.actions.openSource(path));
    details.createEl('blockquote', { text: quote });
  }

  private prioritySelect(parent: HTMLElement): HTMLSelectElement {
    const select = parent.createEl('select', { cls: 'second-brain-butler-priority', attr: { 'aria-label': '优先级' } });
    for (const [value, label] of Object.entries(PRIORITY_LABELS)) select.createEl('option', { value, text: label });
    return select;
  }

  private destinationSelect(parent: HTMLElement): HTMLSelectElement {
    const select = parent.createEl('select', { cls: 'second-brain-butler-destination', attr: { 'aria-label': '加入位置' } });
    select.createEl('option', { value: '', text: '选择去向' });
    for (const [value, label] of Object.entries(DESTINATION_LABELS)) {
      select.createEl('option', { value, text: `加入${label}` });
    }
    return select;
  }

  private dueDateInput(parent: HTMLElement): HTMLInputElement {
    return parent.createEl('input', {
      cls: 'second-brain-butler-due-date',
      attr: { type: 'date', 'aria-label': '截止日期', title: '截止日期（可选）' },
    });
  }

  private snoozeControl(parent: HTMLElement, handler: (days: number) => Promise<void>): void {
    const select = parent.createEl('select', { attr: { 'aria-label': '稍后提醒' } });
    select.createEl('option', { value: '', text: '稍后提醒' });
    select.createEl('option', { value: '1', text: '明天' });
    select.createEl('option', { value: '3', text: '3 天后' });
    select.createEl('option', { value: '7', text: '一周后' });
    select.createEl('option', { value: '30', text: '一个月后' });
    select.addEventListener('change', async () => {
      const days = Number(select.value);
      if (!days) return;
      await handler(days);
      await this.render();
    });
  }

  private localCorrectionControls(parent: HTMLElement, record: ActionLifecycleRecord): void {
    const edit = parent.createEl('button', { text: '修改判断' });
    edit.addEventListener('click', () => {
      new ActionCandidateEditModal(this.app, record, async (changes) => {
        await this.actionLifecycle.updateRecord(record.id, changes);
        await this.render();
      }).open();
    });
    const feedback = parent.createEl('select', { attr: { 'aria-label': '纠正管家' } });
    feedback.createEl('option', { value: '', text: '纠正管家' });
    feedback.createEl('option', { value: 'outdated', text: '信息已过期' });
    feedback.createEl('option', { value: 'incorrect', text: '判断有误' });
    feedback.createEl('option', { value: 'not-action', text: '这不是行动' });
    feedback.createEl('option', { value: 'duplicate', text: '重复信息' });
    feedback.addEventListener('change', async () => {
      if (!feedback.value) return;
      await this.actionLifecycle.dismissRecord(record.id, feedback.value as 'outdated' | 'incorrect' | 'not-action' | 'duplicate');
      await this.render();
    });
    this.sourceButton(parent, record.evidence.sourcePath);
  }

  private sourceButton(parent: HTMLElement, path: string): void {
    const button = parent.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': '打开证据来源' } });
    setIcon(button, 'file-search');
    button.addEventListener('click', () => void this.actions.openSource(path));
  }

  private moreButton(parent: HTMLElement, label: string, handler: () => Promise<void>): void {
    const button = parent.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': label } });
    setIcon(button, 'sparkles');
    button.addEventListener('click', async () => {
      this.close();
      await handler();
    });
  }

  private renderEmpty(parent: HTMLElement): void {
    const empty = parent.createDiv({ cls: 'second-brain-butler-empty' });
    setIcon(empty.createSpan(), 'circle-check');
    empty.createEl('strong', { text: this.activeTab === 'pending' ? '当前没有需要确认的事项' : '这里还没有记录' });
  }

  private renderFooter(): void {
    if (!this.bodyEl) return;
    const footer = this.bodyEl.createDiv({ cls: 'second-brain-butler-footer' });
    footer.createSpan({
      text: this.lastResultMessage || '每条提醒都需要明确去向；修改文字本身不会自动写入行动或长期经验。',
      cls: this.lastResultMessage ? 'second-brain-butler-result' : '',
    });
    const open = footer.createEl('button', { text: '打开行动工作台', cls: 'second-brain-butler-open-workbench' });
    open.addEventListener('click', () => {
      const view = this.lastAddedView || 'all';
      this.close();
      this.actions.openWorkbench(view);
    });
  }

  private async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    await this.render();
    try {
      const modules = new Set(this.plugin.settings.memoryButlerModules);
      const action = modules.has('action-discovery') || modules.has('progress')
        ? await this.actionLifecycle.analyze(false) : { generated: 0, invalidated: 0 };
      const insight = modules.has('insight')
        ? await this.insightService.analyze(false) : { generated: 0, observationMatches: 0, invalidated: 0 };
      const observation = insight.observationMatches > 0 ? `，待验证经验新增 ${insight.observationMatches} 条证据` : '';
      new Notice(`检查完成：新增 ${action.generated + insight.generated} 条${observation}，移出 ${action.invalidated + insight.invalidated} 条失效证据。`, 7000);
    } catch (error) {
      new Notice(`检查失败：${error instanceof Error ? error.message : String(error)}`, 8000);
    } finally {
      this.scanning = false;
      await this.render();
    }
  }
}

class MemoryButlerSettingsModal extends Modal {
  constructor(
    app: ConstructorParameters<typeof Modal>[0],
    private plugin: SecondBrainPlugin,
    private onSaved: () => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText('记忆管家设置');
    this.modalEl.addClass('second-brain-butler-settings-modal');
    const description = this.contentEl.createDiv({ cls: 'second-brain-butler-settings-description' });
    description.createEl('strong', { text: '只保留你真正需要的提醒' });
    description.createSpan({ text: '关闭模块不会删除任何笔记或历史处理记录。' });
    const modeRow = this.contentEl.createDiv({ cls: 'second-brain-butler-setting-row' });
    modeRow.createSpan({ text: '主动程度' });
    const mode = modeRow.createEl('select');
    for (const [value, label] of Object.entries(MODE_LABELS)) mode.createEl('option', { value, text: label });
    mode.value = this.plugin.settings.memoryButlerMode;
    mode.addEventListener('change', async () => {
      this.plugin.settings.memoryButlerMode = mode.value as keyof typeof MODE_LABELS;
      await this.save();
    });
    const modules = new Set(this.plugin.settings.memoryButlerModules);
    for (const [value, label] of Object.entries(MODULE_LABELS)) {
      const row = this.contentEl.createEl('label', { cls: 'second-brain-butler-setting-row' });
      row.createSpan({ text: label });
      const toggle = row.createEl('input', { type: 'checkbox' });
      toggle.checked = modules.has(value);
      toggle.addEventListener('change', async () => {
        if (toggle.checked) modules.add(value);
        else modules.delete(value);
        this.plugin.settings.memoryButlerModules = [...modules];
        await this.save();
      });
    }
  }

  private async save(): Promise<void> {
    await this.plugin.saveSettings();
    await this.onSaved();
  }
}

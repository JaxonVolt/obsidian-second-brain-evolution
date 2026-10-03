import { Modal, Setting } from 'obsidian';

import type {
  InsightEvidence,
  InsightObservationDraft,
  InsightPermanentDraft,
  InsightRecord,
} from '../../core/knowledge/ProactiveInsightService';

export class PermanentExperienceModal extends Modal {
  private draft: InsightPermanentDraft;

  constructor(
    app: ConstructorParameters<typeof Modal>[0],
    insight: InsightRecord,
    private onSave: (draft: InsightPermanentDraft) => Promise<void>,
  ) {
    super(app);
    this.draft = {
      title: insight.title,
      judgment: insight.summary,
      applicableConditions: insight.rationale,
      exceptions: insight.counterEvidence,
      actionPrinciple: insight.suggestedAction,
    };
  }

  onOpen(): void {
    this.modalEl.addClass('second-brain-insight-resolution-modal');
    this.titleEl.setText('沉淀为长期经验');
    this.contentEl.createEl('p', {
      cls: 'second-brain-insight-intro',
      text: '确认后会在“500_永久笔记与知识资产”中创建可检索笔记。桌面端和微信端只会在问题相关时引用，并保留适用条件与例外。',
    });
    this.text('经验标题', '一个清楚、可复用的判断', this.draft.title, (value) => { this.draft.title = value; });
    this.area('核心经验', '你希望长期保留的判断', this.draft.judgment, 5, (value) => { this.draft.judgment = value; });
    this.area('适用条件', '什么情况下适用', this.draft.applicableConditions, 4, (value) => { this.draft.applicableConditions = value; });
    this.area('例外与失效条件', '什么情况下不能照搬', this.draft.exceptions, 4, (value) => { this.draft.exceptions = value; });
    this.area('行动原则', '以后遇到类似情况怎么做', this.draft.actionPrinciple, 3, (value) => { this.draft.actionPrinciple = value; });
    this.actions('确认沉淀', async () => {
      if (!this.draft.title.trim() || !this.draft.judgment.trim()) return false;
      await this.onSave(trimPermanentDraft(this.draft));
      return true;
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private text(name: string, description: string, value: string, onChange: (value: string) => void): void {
    new Setting(this.contentEl)
      .setName(name)
      .setDesc(description)
      .addText((text) => text.setValue(value).onChange(onChange));
  }

  private area(
    name: string,
    description: string,
    value: string,
    rows: number,
    onChange: (value: string) => void,
  ): void {
    new Setting(this.contentEl)
      .setName(name)
      .setDesc(description)
      .addTextArea((text) => {
        text.inputEl.rows = rows;
        text.setValue(value).onChange(onChange);
      });
  }

  private actions(label: string, handler: () => Promise<boolean>): void {
    const actions = this.contentEl.createDiv({ cls: 'second-brain-insight-edit-actions' });
    const cancel = actions.createEl('button', { text: '取消' });
    cancel.addEventListener('click', () => this.close());
    const save = actions.createEl('button', { text: label, cls: 'mod-cta' });
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        if (await handler()) this.close();
      } finally {
        save.disabled = false;
      }
    });
  }
}

export class ObserveExperienceModal extends Modal {
  private draft: InsightObservationDraft;

  constructor(
    app: ConstructorParameters<typeof Modal>[0],
    insight: InsightRecord,
    private onSave: (draft: InsightObservationDraft) => Promise<void>,
  ) {
    super(app);
    this.draft = {
      title: insight.title,
      hypothesis: insight.observation?.hypothesis || insight.summary,
      recordFields: insight.observation?.recordFields.join('\n') || [
        '场景与关系',
        '对方或环境的具体行为',
        '我的回应',
        '结果与后续影响',
      ].join('\n'),
      targetEvidenceCount: insight.observation
        ? Math.max(insight.observation.targetEvidenceCount, insight.observation.matches.length + 3)
        : 3,
    };
  }

  onOpen(): void {
    this.modalEl.addClass('second-brain-insight-resolution-modal');
    this.titleEl.setText('继续观察');
    this.contentEl.createEl('p', {
      cls: 'second-brain-insight-intro',
      text: '这不是定论。它会保存为“待验证经验”；今后的新增笔记出现相关真实事件或反例时，管家会累计证据，达到条件后再次请你决定。',
    });
    new Setting(this.contentEl)
      .setName('观察主题')
      .addText((text) => text.setValue(this.draft.title).onChange((value) => { this.draft.title = value; }));
    new Setting(this.contentEl)
      .setName('待验证假设')
      .setDesc('用暂时性的说法表达，不要写成绝对规则')
      .addTextArea((text) => {
        text.inputEl.rows = 5;
        text.setValue(this.draft.hypothesis).onChange((value) => { this.draft.hypothesis = value; });
      });
    new Setting(this.contentEl)
      .setName('每次记录什么')
      .setDesc('每行一项，后续会显示在观察笔记中')
      .addTextArea((text) => {
        text.inputEl.rows = 5;
        text.setValue(this.draft.recordFields).onChange((value) => { this.draft.recordFields = value; });
      });
    new Setting(this.contentEl)
      .setName('累计多少次后复盘')
      .setDesc('建议 3 次，范围 1—20 次')
      .addText((text) => {
        text.inputEl.type = 'number';
        text.inputEl.min = '1';
        text.inputEl.max = '20';
        text.setValue(String(this.draft.targetEvidenceCount)).onChange((value) => {
          this.draft.targetEvidenceCount = Math.max(1, Math.min(20, Number(value) || 3));
        });
      });
    const actions = this.contentEl.createDiv({ cls: 'second-brain-insight-edit-actions' });
    const cancel = actions.createEl('button', { text: '取消' });
    cancel.addEventListener('click', () => this.close());
    const save = actions.createEl('button', { text: '开始观察', cls: 'mod-cta' });
    save.addEventListener('click', async () => {
      if (!this.draft.title.trim() || !this.draft.hypothesis.trim()) return;
      save.disabled = true;
      try {
        await this.onSave({
          title: this.draft.title.trim(),
          hypothesis: this.draft.hypothesis.trim(),
          recordFields: this.draft.recordFields,
          targetEvidenceCount: Math.max(1, Math.min(20, this.draft.targetEvidenceCount)),
        });
        this.close();
      } finally {
        save.disabled = false;
      }
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class InsightSourcesModal extends Modal {
  constructor(
    app: ConstructorParameters<typeof Modal>[0],
    private evidence: InsightEvidence[],
    private openSource: (path: string) => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass('second-brain-insight-sources-modal');
    this.titleEl.setText('选择要核对或修改的来源');
    this.contentEl.createEl('p', {
      cls: 'second-brain-insight-intro',
      text: '这里只打开原笔记，不会自动改写。修改来源后，下次扫描会重新核验证据。',
    });
    for (const item of this.evidence) {
      const row = this.contentEl.createDiv({ cls: 'second-brain-insight-source-row' });
      row.createEl('strong', { text: item.sourcePath });
      row.createEl('blockquote', { text: item.quote });
      const open = row.createEl('button', { text: '打开笔记', cls: 'mod-cta' });
      open.addEventListener('click', async () => {
        this.close();
        await this.openSource(item.sourcePath);
      });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

function trimPermanentDraft(draft: InsightPermanentDraft): InsightPermanentDraft {
  return {
    title: draft.title.trim(),
    judgment: draft.judgment.trim(),
    applicableConditions: draft.applicableConditions.trim(),
    exceptions: draft.exceptions.trim(),
    actionPrinciple: draft.actionPrinciple.trim(),
  };
}

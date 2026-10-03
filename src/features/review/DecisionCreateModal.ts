import { Modal, Notice, Setting } from 'obsidian';

import type { DecisionDraft, ProactiveReviewService } from '../../core/knowledge/ProactiveReviewService';

function dateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export class DecisionCreateModal extends Modal {
  private draft: DecisionDraft;

  constructor(
    app: ConstructorParameters<typeof Modal>[0],
    private service: ProactiveReviewService,
    private onCreated: (id: string) => void,
    initial: Partial<DecisionDraft> = {},
  ) {
    super(app);
    const today = new Date();
    const reviewDate = new Date(today);
    reviewDate.setDate(reviewDate.getDate() + 30);
    this.draft = {
      title: '',
      background: '',
      rationale: '',
      expectedResult: '',
      decisionDate: dateKey(today),
      reviewDate: dateKey(reviewDate),
      ...initial,
    };
  }

  onOpen(): void {
    this.modalEl.addClass('second-brain-decision-modal');
    this.titleEl.setText('记录决策');
    this.contentEl.createEl('p', {
      cls: 'second-brain-decision-intro',
      text: '只记录需要在未来检验的重要选择。默认 30 天后复盘，可按实际情况修改。',
    });

    new Setting(this.contentEl)
      .setName('决策内容')
      .setDesc('一句话写清楚你决定做什么。')
      .addText((text) => text
        .setPlaceholder('例如：入职前先完成现场图纸最小训练')
        .setValue(this.draft.title)
        .onChange((value) => { this.draft.title = value; }));

    new Setting(this.contentEl)
      .setName('做出日期')
      .addText((text) => {
        text.inputEl.type = 'date';
        text.setValue(this.draft.decisionDate).onChange((value) => { this.draft.decisionDate = value; });
      });

    new Setting(this.contentEl)
      .setName('复盘日期')
      .setDesc('到期后插件会主动提醒。')
      .addText((text) => {
        text.inputEl.type = 'date';
        text.setValue(this.draft.reviewDate).onChange((value) => { this.draft.reviewDate = value; });
      });

    this.addTextArea('背景', '当时需要解决什么问题？', this.draft.background, (value) => {
      this.draft.background = value;
    });
    this.addTextArea('判断依据', '哪些事实或约束支持这个选择？', this.draft.rationale, (value) => {
      this.draft.rationale = value;
    });
    this.addTextArea('预期结果', '到复盘日期时，用什么事实判断它是否有效？', this.draft.expectedResult, (value) => {
      this.draft.expectedResult = value;
    });

    const actions = this.contentEl.createDiv({ cls: 'second-brain-decision-actions' });
    const cancel = actions.createEl('button', { text: '取消' });
    cancel.addEventListener('click', () => this.close());
    const save = actions.createEl('button', { text: '确认记录', cls: 'mod-cta' });
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        const id = await this.service.createDecision(this.draft);
        new Notice(`决策 ${id} 已记录。`);
        this.close();
        this.onCreated(id);
      } catch (error) {
        new Notice(error instanceof Error ? error.message : String(error));
        save.disabled = false;
      }
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private addTextArea(
    name: string,
    placeholder: string,
    value: string,
    onChange: (value: string) => void,
  ): void {
    new Setting(this.contentEl)
      .setName(name)
      .addTextArea((text) => {
        text.inputEl.rows = 3;
        text.setPlaceholder(placeholder).setValue(value).onChange(onChange);
      });
  }
}

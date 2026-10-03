import { Modal, Setting } from 'obsidian';

import type { InsightRecord } from '../../core/knowledge/ProactiveInsightService';

export class InsightEditModal extends Modal {
  private title: string;
  private summary: string;
  private suggestedAction: string;

  constructor(
    app: ConstructorParameters<typeof Modal>[0],
    insight: InsightRecord,
    private onSave: (changes: Pick<InsightRecord, 'title' | 'summary' | 'suggestedAction'>) => Promise<void>,
  ) {
    super(app);
    this.title = insight.title;
    this.summary = insight.summary;
    this.suggestedAction = insight.suggestedAction;
  }

  onOpen(): void {
    this.modalEl.addClass('second-brain-insight-edit-modal');
    this.titleEl.setText('修改管家判断');
    this.contentEl.createEl('p', {
      cls: 'second-brain-insight-intro',
      text: '这里只修改文字，不会自动加入行动、生成笔记或结束这条提醒。保存后请继续选择它的去向。',
    });

    new Setting(this.contentEl)
      .setName('洞察标题')
      .addText((text) => text
        .setValue(this.title)
        .onChange((value) => { this.title = value; }));

    new Setting(this.contentEl)
      .setName('核心判断')
      .addTextArea((text) => {
        text.inputEl.rows = 5;
        text.setValue(this.summary).onChange((value) => { this.summary = value; });
      });

    new Setting(this.contentEl)
      .setName('建议下一步')
      .addTextArea((text) => {
        text.inputEl.rows = 3;
        text.setValue(this.suggestedAction).onChange((value) => { this.suggestedAction = value; });
      });

    const actions = this.contentEl.createDiv({ cls: 'second-brain-insight-edit-actions' });
    const cancel = actions.createEl('button', { text: '取消' });
    cancel.addEventListener('click', () => this.close());
    const save = actions.createEl('button', { text: '保存修改', cls: 'mod-cta' });
    save.addEventListener('click', async () => {
      if (!this.title.trim() || !this.summary.trim()) return;
      save.disabled = true;
      try {
        await this.onSave({
          title: this.title.trim(),
          summary: this.summary.trim(),
          suggestedAction: this.suggestedAction.trim(),
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

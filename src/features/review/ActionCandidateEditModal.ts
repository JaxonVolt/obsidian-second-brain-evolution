import { Modal, Notice, Setting } from 'obsidian';

import type {
  ActionLifecycleRecord,
  ActionRecordEdits,
} from '../../core/knowledge/ActionLifecycleService';

export class ActionCandidateEditModal extends Modal {
  private edits: ActionRecordEdits;

  constructor(
    app: ConstructorParameters<typeof Modal>[0],
    record: ActionLifecycleRecord,
    private onSave: (changes: ActionRecordEdits) => Promise<void>,
  ) {
    super(app);
    this.edits = {
      title: record.title,
      summary: record.summary,
      rationale: record.rationale,
      actionText: record.actionText,
      projectName: record.projectName,
      nextActionText: record.nextActionText,
    };
  }

  onOpen(): void {
    this.modalEl.addClass('second-brain-action-edit-modal');
    this.titleEl.setText('快速修改建议');
    this.contentEl.createEl('p', {
      cls: 'second-brain-action-edit-intro',
      text: '这里只修正待确认建议，不调用模型，也不会改动原笔记或行动系统。',
    });

    this.addTextSetting('标题', '这件事应该叫什么', 'title');
    this.addAreaSetting('简要判断', '说明这条信息现在代表什么', 'summary', 3);
    this.addAreaSetting('判断依据', '保留最关键的事实依据', 'rationale', 3);
    this.addAreaSetting('建议行动', '写成可以直接开始的一步', 'actionText', 2);
    this.addTextSetting('项目名称', '没有对应项目时可以留空', 'projectName');
    this.addAreaSetting('新的下一步', '用于进度同步或项目更新', 'nextActionText', 2);

    const actions = this.contentEl.createDiv({ cls: 'second-brain-action-edit-actions' });
    const cancel = actions.createEl('button', { text: '取消' });
    cancel.addEventListener('click', () => this.close());
    const save = actions.createEl('button', { text: '保存修改', cls: 'mod-cta' });
    save.addEventListener('click', async () => {
      if (!this.edits.title.trim() || !this.edits.summary.trim() || !this.edits.actionText.trim()) {
        new Notice('标题、简要判断和建议行动不能为空。');
        return;
      }
      save.disabled = true;
      try {
        await this.onSave({
          title: this.edits.title.trim(),
          summary: this.edits.summary.trim(),
          rationale: this.edits.rationale.trim(),
          actionText: this.edits.actionText.trim(),
          projectName: this.edits.projectName.trim(),
          nextActionText: this.edits.nextActionText.trim(),
        });
        this.close();
      } catch (error) {
        new Notice(error instanceof Error ? error.message : String(error), 7000);
      } finally {
        save.disabled = false;
      }
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private addTextSetting(
    name: string,
    description: string,
    key: Extract<keyof ActionRecordEdits, 'title' | 'projectName'>,
  ): void {
    new Setting(this.contentEl)
      .setName(name)
      .setDesc(description)
      .addText((text) => text
        .setValue(this.edits[key])
        .onChange((value) => { this.edits[key] = value; }));
  }

  private addAreaSetting(
    name: string,
    description: string,
    key: Extract<keyof ActionRecordEdits, 'summary' | 'rationale' | 'actionText' | 'nextActionText'>,
    rows: number,
  ): void {
    new Setting(this.contentEl)
      .setName(name)
      .setDesc(description)
      .addTextArea((text) => {
        text.inputEl.rows = rows;
        text.setValue(this.edits[key]).onChange((value) => { this.edits[key] = value; });
      });
  }
}

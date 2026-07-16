import { Modal, Notice, Setting } from 'obsidian';

import type {
  InitializationInspection,
  SecondBrainInitializer,
} from '../../core/knowledge/SecondBrainInitializer';

const SECTIONS = [
  ['000_元数据', '核心坐标、使用指南和迭代日志'],
  ['010_收件箱', '原始输入、来源资料和微信附件'],
  ['020_行动系统', '项目、下一步行动、等待与决策'],
  ['100_领域与职责', '长期维护的责任和知识领域'],
  ['300_复盘与日志', '每日笔记和心智复盘'],
  ['500 / 600 / 700', '永久笔记、输出与归档'],
  ['900_模板', '每日笔记、永久笔记和周回顾模板'],
] as const;

export class SecondBrainOnboardingModal extends Modal {
  private resolved = false;

  constructor(
    app: ConstructorParameters<typeof Modal>[0],
    private initializer: SecondBrainInitializer,
    private mode: 'first-run' | 'manual' = 'first-run',
    private onComplete?: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass('second-brain-onboarding-modal');
    this.titleEl.setText(this.mode === 'first-run' ? '初始化你的第二大脑' : '检查并补全知识库骨架');
    this.contentEl.empty();
    this.contentEl.createEl('p', {
      cls: 'second-brain-onboarding-intro',
      text: '插件将创建一套精简的通用结构。所有操作只发生在当前 Obsidian 仓库中，已有文件一律保留，不会覆盖。',
    });
    const status = this.contentEl.createDiv({ cls: 'second-brain-onboarding-status', text: '正在检查当前仓库…' });
    void this.renderInspection(status);
  }

  onClose(): void {
    if (!this.resolved && this.mode === 'first-run') void this.initializer.dismiss();
    this.contentEl.empty();
  }

  private async renderInspection(status: HTMLElement): Promise<void> {
    try {
      const inspection = await this.initializer.inspect();
      status.remove();
      this.renderSummary(inspection);
    } catch (error) {
      status.setText(`检查失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private renderSummary(inspection: InitializationInspection): void {
    const summary = this.contentEl.createDiv({ cls: 'second-brain-onboarding-summary' });
    summary.createEl('strong', { text: `需要补建 ${inspection.missingFolders.length} 个目录、${inspection.missingFiles.length} 个文件` });
    summary.createEl('span', { text: `；已有 ${inspection.existingFiles.length} 个文件会被跳过。` });

    const list = this.contentEl.createDiv({ cls: 'second-brain-onboarding-list' });
    for (const [name, description] of SECTIONS) {
      const row = list.createDiv({ cls: 'second-brain-onboarding-row' });
      row.createEl('strong', { text: name });
      row.createEl('span', { text: description });
    }

    this.contentEl.createEl('p', {
      cls: 'second-brain-onboarding-note',
      text: '初始化只建立空白通用骨架，不会生成或推断个人画像。以后可在插件设置中再次运行，用于补建缺失内容。',
    });

    const controls = new Setting(this.contentEl);
    controls.addButton((button) => button
      .setButtonText(this.mode === 'first-run' ? '暂不初始化' : '关闭')
      .onClick(async () => {
        this.resolved = true;
        if (this.mode === 'first-run') await this.initializer.dismiss();
        this.close();
      }));
    controls.addButton((button) => button
      .setButtonText(inspection.missingFolders.length || inspection.missingFiles.length ? '创建通用骨架' : '骨架已完整')
      .setCta()
      .setDisabled(inspection.missingFolders.length === 0 && inspection.missingFiles.length === 0)
      .onClick(async () => {
        button.setDisabled(true).setButtonText('正在创建…');
        try {
          const result = await this.initializer.initialize();
          this.resolved = true;
          new Notice(`初始化完成：新建 ${result.createdFolders.length} 个目录、${result.createdFiles.length} 个文件，未覆盖已有内容。`);
          this.onComplete?.();
          this.close();
        } catch (error) {
          button.setDisabled(false).setButtonText('重试');
          new Notice(`初始化失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }));
  }
}

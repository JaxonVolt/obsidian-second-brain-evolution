import { type App, Modal, Notice } from 'obsidian';

import { MAX_CUSTOM_INSTRUCTIONS_LENGTH } from '../../core/agent/customInstructionsControl';
import type ClaudianPlugin from '../../main';

export { MAX_CUSTOM_INSTRUCTIONS_LENGTH } from '../../core/agent/customInstructionsControl';

export interface CustomInstructionsModalOptions {
  initialValue?: string;
  proposalSource?: 'conversation';
}

export class CustomInstructionsModal extends Modal {
  constructor(
    app: App,
    private readonly plugin: ClaudianPlugin,
    private readonly onSaved?: (value: string) => void,
    private readonly options: CustomInstructionsModalOptions = {},
  ) {
    super(app);
  }

  onOpen(): void {
    const isConversationProposal = this.options.proposalSource === 'conversation';
    this.setTitle(isConversationProposal ? '确认自定义指令修改' : '自定义指令');
    this.modalEl.addClass('second-brain-custom-instructions-modal');

    this.contentEl.createEl('p', {
      cls: 'second-brain-custom-instructions-intro',
      text: isConversationProposal
        ? '以下内容由本次对话生成。请核对完整指令，只有点击“保存”才会写入，并从下一次提问开始生效。'
        : '用于保存需要 AI 长期遵守的稳定设定。对所有对话标签页和模型生效，并从下一次提问开始使用。',
    });

    this.contentEl.createEl('h3', {
      cls: 'second-brain-custom-instructions-section-title',
      text: '通用自定义指令',
    });
    this.contentEl.createEl('p', {
      cls: 'second-brain-custom-instructions-section-desc',
      text: '电脑端和微信端共同遵守。',
    });
    const sharedTextarea = this.contentEl.createEl('textarea', {
      cls: 'second-brain-custom-instructions-input',
      attr: {
        placeholder: '例如：默认使用中文；先给结论，再说明依据；涉及我的长期目标时先读取第二大脑中的相关笔记。',
        maxlength: String(MAX_CUSTOM_INSTRUCTIONS_LENGTH),
        'aria-label': '通用自定义指令内容',
      },
    });
    const persistedSharedValue = (this.plugin.settings.systemPrompt ?? '').trim();
    sharedTextarea.value = this.options.initialValue ?? persistedSharedValue;

    this.contentEl.createEl('h3', {
      cls: 'second-brain-custom-instructions-section-title',
      text: '微信端附加指令',
    });
    this.contentEl.createEl('p', {
      cls: 'second-brain-custom-instructions-section-desc',
      text: '只追加到微信会话，不影响电脑端。适合保留移动端回复长度、提示方式等特殊要求。',
    });
    const wechatTextarea = this.contentEl.createEl('textarea', {
      cls: 'second-brain-custom-instructions-input second-brain-custom-instructions-input-secondary',
      attr: {
        placeholder: '例如：微信端回复尽量简洁；需要确认时将可复制命令单独发送。',
        maxlength: String(MAX_CUSTOM_INSTRUCTIONS_LENGTH),
        'aria-label': '微信端附加指令内容',
      },
    });
    const persistedWechatValue = (this.plugin.settings.wechatAdditionalInstructions ?? '').trim();
    wechatTextarea.value = persistedWechatValue;

    const footer = this.contentEl.createDiv({ cls: 'second-brain-custom-instructions-footer' });
    const counter = footer.createSpan({ cls: 'second-brain-custom-instructions-counter' });
    const actions = footer.createDiv({ cls: 'second-brain-custom-instructions-actions' });
    const cancelButton = actions.createEl('button', { text: '取消' });
    const saveButton = actions.createEl('button', { cls: 'mod-cta', text: '保存' });

    const refreshState = (): void => {
      const sharedLength = sharedTextarea.value.length;
      const wechatLength = wechatTextarea.value.length;
      counter.setText(
        `通用 ${sharedLength.toLocaleString('zh-CN')} / 微信 ${wechatLength.toLocaleString('zh-CN')}`,
      );
      saveButton.disabled = sharedTextarea.value.trim() === persistedSharedValue
        && wechatTextarea.value.trim() === persistedWechatValue;
    };

    const save = async (): Promise<void> => {
      const nextSharedValue = sharedTextarea.value.trim();
      const nextWechatValue = wechatTextarea.value.trim();
      if (nextSharedValue === persistedSharedValue && nextWechatValue === persistedWechatValue) {
        this.close();
        return;
      }

      saveButton.disabled = true;
      const previousSharedValue = this.plugin.settings.systemPrompt;
      const previousWechatValue = this.plugin.settings.wechatAdditionalInstructions;
      try {
        this.plugin.settings.systemPrompt = nextSharedValue;
        this.plugin.settings.wechatAdditionalInstructions = nextWechatValue;
        await this.plugin.saveSettings();
        this.onSaved?.(nextSharedValue);
        for (const view of this.plugin.getAllViews()) {
          view.refreshCustomInstructionsButton();
        }
        new Notice('自定义指令已保存，将从下一次提问生效。');
        this.close();
      } catch (error) {
        this.plugin.settings.systemPrompt = previousSharedValue;
        this.plugin.settings.wechatAdditionalInstructions = previousWechatValue;
        saveButton.disabled = false;
        new Notice(`保存自定义指令失败：${error instanceof Error ? error.message : String(error)}`);
      }
    };

    for (const textarea of [sharedTextarea, wechatTextarea]) {
      textarea.addEventListener('input', refreshState);
      textarea.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) {
          event.preventDefault();
          void save();
        }
      });
    }
    cancelButton.addEventListener('click', () => this.close());
    saveButton.addEventListener('click', () => void save());

    refreshState();
    window.setTimeout(() => sharedTextarea.focus());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

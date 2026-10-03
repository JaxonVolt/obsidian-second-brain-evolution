import { type App, Modal } from 'obsidian';

export function requestTabTitle(app: App, currentTitle: string): Promise<string | null> {
  return new Promise(resolve => {
    new TabRenameModal(app, currentTitle, resolve).open();
  });
}

class TabRenameModal extends Modal {
  private readonly currentTitle: string;
  private readonly resolve: (title: string | null) => void;
  private resolved = false;

  constructor(app: App, currentTitle: string, resolve: (title: string | null) => void) {
    super(app);
    this.currentTitle = currentTitle;
    this.resolve = resolve;
  }

  onOpen(): void {
    this.setTitle('重命名对话标签页');
    this.modalEl.addClass('claudian-tab-rename-modal');

    const input = this.contentEl.createEl('input', {
      cls: 'claudian-tab-rename-input',
      attr: {
        type: 'text',
        value: this.currentTitle,
        placeholder: '输入标签页名称',
        maxlength: '60',
      },
    });

    const actions = this.contentEl.createDiv({ cls: 'claudian-tab-rename-actions' });
    const cancelButton = actions.createEl('button', { text: '取消' });
    const saveButton = actions.createEl('button', { cls: 'mod-cta', text: '保存' });

    const submit = (): void => {
      const title = input.value.trim();
      if (!title) {
        input.focus();
        return;
      }
      this.resolved = true;
      this.resolve(title);
      this.close();
    };

    cancelButton.addEventListener('click', () => this.close());
    saveButton.addEventListener('click', submit);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault();
        submit();
      } else if (event.key === 'Escape' && !event.isComposing) {
        event.preventDefault();
        this.close();
      }
    });

    window.setTimeout(() => {
      input.focus();
      input.select();
    });
  }

  onClose(): void {
    if (!this.resolved) {
      this.resolve(null);
    }
    this.contentEl.empty();
  }
}

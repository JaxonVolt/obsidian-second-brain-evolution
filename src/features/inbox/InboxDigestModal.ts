import { Modal, Notice, setIcon } from 'obsidian';

import type { InboxDigestService, RoutingProposal } from '../../core/knowledge/InboxDigestService';
import { ROUTING_CATEGORIES } from '../../core/knowledge/InboxDigestService';

export class InboxDigestModal extends Modal {
  private proposals: RoutingProposal[] = [];
  private bodyEl: HTMLElement | null = null;

  constructor(app: ConstructorParameters<typeof Modal>[0], private service: InboxDigestService) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass('second-brain-routing-modal');
    this.titleEl.setText('消化收件箱');
    this.bodyEl = this.contentEl.createDiv({ cls: 'second-brain-routing-body' });
    void this.loadSuggestions();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async loadSuggestions(): Promise<void> {
    if (!this.bodyEl) return;
    this.bodyEl.empty();
    const loading = this.bodyEl.createDiv({ cls: 'second-brain-routing-loading' });
    const icon = loading.createSpan();
    setIcon(icon, 'loader-circle');
    loading.createSpan({ text: '正在使用快速通道分析未处理内容…' });

    try {
      this.proposals = await this.service.analyze();
      if (this.proposals.length === 0) {
        this.renderEmpty();
        return;
      }
      this.renderProposals();
    } catch (error) {
      this.renderError(error instanceof Error ? error.message : String(error));
    }
  }

  private renderEmpty(): void {
    if (!this.bodyEl) return;
    this.bodyEl.empty();
    this.bodyEl.createDiv({ cls: 'second-brain-routing-empty', text: '没有待消化的原始输入。' });
    const closeButton = this.bodyEl.createEl('button', { text: '关闭', cls: 'mod-cta' });
    closeButton.addEventListener('click', () => this.close());
  }

  private renderError(message: string): void {
    if (!this.bodyEl) return;
    this.bodyEl.empty();
    this.bodyEl.createDiv({ cls: 'second-brain-routing-error', text: message });
    const actions = this.bodyEl.createDiv({ cls: 'second-brain-routing-actions' });
    const retry = actions.createEl('button', { text: '重新分析' });
    retry.addEventListener('click', () => void this.loadSuggestions());
    const close = actions.createEl('button', { text: '取消' });
    close.addEventListener('click', () => this.close());
  }

  private renderProposals(): void {
    if (!this.bodyEl) return;
    this.bodyEl.empty();
    this.bodyEl.createEl('p', {
      cls: 'second-brain-routing-intro',
      text: '逐条检查并修改。只有勾选的内容会归位，原始输入始终保留。',
    });

    const list = this.bodyEl.createDiv({ cls: 'second-brain-routing-list' });
    for (const [index, proposal] of this.proposals.entries()) {
      this.renderProposal(list, proposal, index);
    }

    const actions = this.bodyEl.createDiv({ cls: 'second-brain-routing-actions' });
    const retry = actions.createEl('button', { text: '重新分析' });
    retry.addEventListener('click', () => void this.loadSuggestions());
    const cancel = actions.createEl('button', { text: '取消' });
    cancel.addEventListener('click', () => this.close());
    const apply = actions.createEl('button', { text: '确认并一键归位', cls: 'mod-cta' });
    apply.addEventListener('click', async () => {
      apply.disabled = true;
      apply.setText('正在归位…');
      try {
        const result = await this.service.apply(this.proposals);
        new Notice(`归位完成：新建 ${result.created.length}，更新 ${result.updated.length}。`);
        this.close();
      } catch (error) {
        new Notice(error instanceof Error ? error.message : String(error));
        apply.disabled = false;
        apply.setText('确认并一键归位');
      }
    });
  }

  private renderProposal(parent: HTMLElement, proposal: RoutingProposal, index: number): void {
    const card = parent.createDiv({ cls: 'second-brain-routing-item' });
    const header = card.createDiv({ cls: 'second-brain-routing-item-header' });
    const checkbox = header.createEl('input', { type: 'checkbox' });
    checkbox.checked = proposal.selected;
    checkbox.setAttribute('aria-label', `选择建议 ${index + 1}`);
    checkbox.addEventListener('change', () => { proposal.selected = checkbox.checked; });
    header.createSpan({ cls: 'second-brain-routing-number', text: String(index + 1) });
    header.createSpan({ cls: 'second-brain-routing-source', text: proposal.sourcePath.split('/').pop() ?? proposal.sourcePath });
    header.createSpan({ cls: 'second-brain-routing-confidence', text: `置信度 ${Math.round(proposal.confidence * 100)}%` });

    const fields = card.createDiv({ cls: 'second-brain-routing-fields' });
    const destinationField = fields.createDiv({ cls: 'second-brain-routing-field' });
    destinationField.createEl('label', { text: '去向' });
    const select = destinationField.createEl('select');
    for (const option of ROUTING_CATEGORIES) {
      select.createEl('option', { value: option.value, text: option.label });
    }
    select.value = proposal.category;
    select.addEventListener('change', () => {
      proposal.category = select.value as RoutingProposal['category'];
      if (proposal.category === 'inbox') {
        proposal.selected = false;
        checkbox.checked = false;
      }
    });

    const titleField = fields.createDiv({ cls: 'second-brain-routing-field second-brain-routing-title-field' });
    titleField.createEl('label', { text: '标题' });
    const title = titleField.createEl('input', { type: 'text', value: proposal.title });
    title.addEventListener('input', () => { proposal.title = title.value.trim(); });

    const contentField = card.createDiv({ cls: 'second-brain-routing-field' });
    contentField.createEl('label', { text: '内容' });
    const content = contentField.createEl('textarea');
    content.value = proposal.content;
    content.rows = 4;
    content.addEventListener('input', () => { proposal.content = content.value.trim(); });

    card.createDiv({ cls: 'second-brain-routing-reason', text: `建议理由：${proposal.rationale || '未提供'}` });
  }
}

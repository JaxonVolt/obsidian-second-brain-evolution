import { setIcon } from 'obsidian';

import { KNOWLEDGE_QUICK_ACTIONS } from '../../core/commands';
import type ClaudianPlugin from '../../main';

export function renderKnowledgeWelcome(container: HTMLElement, plugin: ClaudianPlugin): void {
  container.empty();

  const intro = container.createDiv({ cls: 'knowledge-welcome-intro' });
  intro.createEl('h2', { text: '我的第二大脑', cls: 'knowledge-welcome-title' });
  intro.createEl('p', {
    text: '先记录，再消化；让知识最终回到行动',
    cls: 'knowledge-welcome-subtitle',
  });

  const actions = container.createDiv({ cls: 'knowledge-quick-actions' });
  for (const [index, action] of KNOWLEDGE_QUICK_ACTIONS.entries()) {
    const button = actions.createEl('button', {
      cls: 'knowledge-quick-action',
      attr: { type: 'button' },
    });
    if (index === 0) button.addClass('knowledge-quick-action--primary');

    const icon = button.createSpan({ cls: 'knowledge-quick-action-icon' });
    setIcon(icon, action.icon);

    const copy = button.createSpan({ cls: 'knowledge-quick-action-copy' });
    copy.createSpan({ cls: 'knowledge-quick-action-label', text: action.label });
    copy.createSpan({ cls: 'knowledge-quick-action-description', text: action.description });

    button.addEventListener('click', () => {
      if (action.requiresInput) {
        void plugin.prefillKnowledgeCommand(action.command);
      } else {
        void plugin.runKnowledgeCommand(action.command);
      }
    });
  }

  container.createDiv({
    cls: 'knowledge-welcome-hint',
    text: '输入问题直接对话；混合记录请用输入框下方“存入收件箱”',
  });
}

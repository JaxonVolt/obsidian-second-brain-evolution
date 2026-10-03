import { resolveConversationCommand } from '../../../../src/core/commands/conversationCommandResolver';

describe('resolveConversationCommand', () => {
  it('expands the same knowledge command for desktop and remote conversations', () => {
    const result = resolveConversationCommand('/route 变频器故障');
    expect(result?.prompt).toContain('变频器故障');
    expect(result?.prompt).toContain('最合适的去向');
  });

  it('keeps Codex passthrough commands unchanged', () => {
    expect(resolveConversationCommand('/plan 检查结构')).toEqual({ prompt: '/plan 检查结构' });
  });

  it('rejects a non-invocable custom command consistently', () => {
    const result = resolveConversationCommand('/hidden', [{
      id: 'custom:hidden',
      name: 'hidden',
      description: 'hidden',
      content: 'do not run',
      userInvocable: false,
    }]);
    expect(result?.blockedMessage).toContain('不能被直接调用');
  });
});

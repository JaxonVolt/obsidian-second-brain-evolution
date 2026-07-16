import {
  findKnowledgeCommand,
  getKnowledgeCommandsForDropdown,
  KNOWLEDGE_COMMANDS,
  KNOWLEDGE_QUICK_ACTIONS,
} from '@/core/commands';

describe('knowledge evolution commands', () => {
  it('ships thirteen distinct, user-invocable commands', () => {
    expect(KNOWLEDGE_COMMANDS).toHaveLength(13);
    expect(new Set(KNOWLEDGE_COMMANDS.map((command) => command.name)).size).toBe(13);
    expect(KNOWLEDGE_COMMANDS.every((command) => command.userInvocable)).toBe(true);
  });

  it('applies proposal-first governance to every command', () => {
    for (const command of KNOWLEDGE_COMMANDS) {
      expect(command.content).toContain('默认只生成分析和建议');
      expect(command.content).toContain('必须等用户明确确认后才能写入');
      expect(command.content).toContain('每个重要结论都给出对应笔记路径');
      expect(command.content).toContain('000_元数据/000_元数据：核心坐标.md');
    }
  });

  it('resolves commands case-insensitively', () => {
    expect(findKnowledgeCommand('DASHBOARD')?.name).toBe('dashboard');
    expect(findKnowledgeCommand('ask-vault')?.argumentHint).toBe('<问题>');
    expect(findKnowledgeCommand('missing')).toBeNull();
  });

  it('exposes the commands in the slash dropdown', () => {
    const dropdown = getKnowledgeCommandsForDropdown();
    expect(dropdown).toHaveLength(13);
    expect(dropdown).not.toBe(KNOWLEDGE_COMMANDS);
  });

  it('keeps the first screen focused on the daily note and core actions', () => {
    expect(KNOWLEDGE_QUICK_ACTIONS.map((action) => action.command)).toEqual([
      'today',
      'dashboard',
      'digest',
      'ask-vault',
      'weekly',
    ]);
  });

  it('uses the visible core profile as the single profile source', () => {
    expect(findKnowledgeCommand('profile-distill')?.content).toContain('区分稳定画像与当前阶段');
    expect(findKnowledgeCommand('profile-distill')?.content).not.toContain('读取 .second-brain/profile.md');
  });
});

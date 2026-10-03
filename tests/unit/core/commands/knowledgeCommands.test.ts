import {
  findKnowledgeCommand,
  getKnowledgeCommandsForDropdown,
  KNOWLEDGE_COMMANDS,
  KNOWLEDGE_QUICK_ACTIONS,
  shouldUseNaturalKnowledgeMode,
} from '@/core/commands';

describe('knowledge evolution commands', () => {
  it('ships twelve distinct, user-invocable commands', () => {
    expect(KNOWLEDGE_COMMANDS).toHaveLength(12);
    expect(new Set(KNOWLEDGE_COMMANDS.map((command) => command.name)).size).toBe(12);
    expect(KNOWLEDGE_COMMANDS.every((command) => command.userInvocable)).toBe(true);
  });

  it('applies proposal-first governance to every command', () => {
    for (const command of KNOWLEDGE_COMMANDS) {
      expect(command.content).toContain('默认只生成分析和建议');
      expect(command.content).toContain('没有当前任务的明确授权时不得写入');
      expect(command.content).toContain('不重复索取同一批准');
      expect(command.content).toContain('当前进度读取 000_元数据/现状.md');
      expect(command.content).toContain('每个重要结论都给出对应笔记路径');
      expect(command.content).toContain('000_元数据/000_元数据：核心坐标.md');
    }
  });

  it('resolves commands case-insensitively', () => {
    expect(findKnowledgeCommand('CURRENT-STATUS')?.name).toBe('current-status');
    expect(findKnowledgeCommand('organize-recent-logs')?.name).toBe('organize-recent-logs');
    expect(findKnowledgeCommand('missing')).toBeNull();
  });

  it('organizes personal and work logs as independent ranges', () => {
    const command = findKnowledgeCommand('organize-recent-logs');
    expect(command?.content).toContain('300_复盘与日志/310_每日笔记');
    expect(command?.content).toContain('100_领域与职责/140_工作日志');
    expect(command?.content).toContain('不得把同一天的个人日志与工作日志合并');
    expect(command?.content).toContain('班次、岗位、参与程度、安全与授权');
    expect(command?.content).toContain('技术排障笔记');
    expect(command?.content).toContain('加入行动工作台、更新技能或项目、值得单独整理的故障、其他可复用内容');
    expect(command?.content).toContain('没有合理去向的回流项填写“暂无”');
    expect(command?.content).toContain('不得把“建议”写成“已完成”');
  });

  it('exposes the commands in the slash dropdown', () => {
    const dropdown = getKnowledgeCommandsForDropdown();
    expect(dropdown).toHaveLength(12);
    expect(dropdown).not.toBe(KNOWLEDGE_COMMANDS);
  });

  it('keeps the first screen focused on the daily note and core actions', () => {
    expect(KNOWLEDGE_QUICK_ACTIONS.map((action) => action.command)).toEqual([
      'today',
      'work-log',
      'organize-recent-logs',
      'digest',
      'current-status',
    ]);
  });

  it('detects natural requests to answer from the vault', () => {
    expect(shouldUseNaturalKnowledgeMode('根据我的笔记分析这个问题')).toBe(true);
    expect(shouldUseNaturalKnowledgeMode('在第二大脑里查一下之前的决定')).toBe(true);
    expect(shouldUseNaturalKnowledgeMode('解释一下接触器的作用')).toBe(false);
  });

  it('keeps status analysis proposal-only until the user confirms', () => {
    const command = findKnowledgeCommand('current-status');
    expect(command?.content).toContain('不依赖额外Skill');
    expect(command?.content).toContain('上次记录边界');
    expect(command?.content).toContain('带编号的全局进度差异表');
    expect(command?.content).toContain('同一事件只计算一次');
    expect(command?.content).toContain('区分用户原文、推断和建议');
    expect(command?.content).toContain('等待用户明确选择');
    expect(command?.content).toContain('获批后只修改对应文件');
    expect(command?.content).toContain('不修改任何文件');
    expect(command?.content).toContain('不推进同步游标');
  });

  it('uses the visible core profile as the single profile source', () => {
    expect(findKnowledgeCommand('profile-distill')?.content).toContain('区分稳定画像与当前阶段');
    expect(findKnowledgeCommand('profile-distill')?.content).not.toContain('读取 .second-brain/profile.md');
  });
});

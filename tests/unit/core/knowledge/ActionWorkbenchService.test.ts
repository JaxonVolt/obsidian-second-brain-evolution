import { TFile } from 'obsidian';

import {
  ActionWorkbenchService,
  isActionRecordPath,
  isLongTermCompletedOn,
  isLongTermScheduledOn,
  parseActionRecord,
} from '../../../../src/core/knowledge/ActionWorkbenchService';

const NEXT_ACTIONS = '020_行动系统/下一步行动.md';
const WAITING = '020_行动系统/等待与委托.md';
const PROJECT = '020_行动系统/活跃项目/入职前能力补强/入职前能力补强.md';
const NOW = new Date(2026, 7, 11, 9, 30, 0);

function parentPaths(path: string): string[] {
  const parts = path.split('/');
  return parts.slice(1).map((_, index) => parts.slice(0, index + 1).join('/'));
}

function createVault(initial: Record<string, string> = {}) {
  const files = new Map<string, string>();
  const runtime = new Map<string, string>();
  const tFiles = new Map<string, TFile>();
  const folders = new Set<string>();

  const upsert = (path: string, content: string) => {
    files.set(path, content);
    let file = tFiles.get(path);
    if (!file) {
      file = new TFile();
      const name = path.split('/').pop() ?? '';
      Object.assign(file, { path, name, basename: name.replace(/\.md$/u, ''), extension: 'md' });
      tFiles.set(path, file);
    }
    Object.assign(file, { stat: { ctime: NOW.getTime(), mtime: NOW.getTime(), size: content.length } });
    parentPaths(path).forEach((folder) => folders.add(folder));
    return file;
  };
  Object.entries(initial).forEach(([path, content]) => upsert(path, content));

  const adapter = {
    exists: jest.fn(async (path: string) => files.has(path) || runtime.has(path) || folders.has(path)),
    read: jest.fn(async (path: string) => runtime.get(path) ?? files.get(path) ?? ''),
    write: jest.fn(async (path: string, content: string) => {
      if (path.startsWith('.second-brain/')) runtime.set(path, content);
      else upsert(path, content);
    }),
    mkdir: jest.fn(async (path: string) => { folders.add(path); }),
    remove: jest.fn(async (path: string) => { files.delete(path); tFiles.delete(path); }),
  };
  const vault = {
    adapter,
    getMarkdownFiles: jest.fn(() => [...tFiles.values()]),
    getAbstractFileByPath: jest.fn((path: string) => tFiles.get(path) ?? null),
    cachedRead: jest.fn(async (file: TFile) => files.get(file.path) ?? ''),
    create: jest.fn(async (path: string, content: string) => upsert(path, content)),
    modify: jest.fn(async (file: TFile, content: string) => { files.set(file.path, content); }),
  };
  const app = {
    vault,
    fileManager: {
      renameFile: jest.fn(async (file: TFile, nextPath: string) => {
        const previousPath = file.path;
        const content = files.get(previousPath) ?? '';
        files.delete(previousPath);
        tFiles.delete(previousPath);
        const name = nextPath.split('/').pop() ?? '';
        Object.assign(file, { path: nextPath, name, basename: name.replace(/\.md$/u, '') });
        files.set(nextPath, content);
        tFiles.set(nextPath, file);
        parentPaths(nextPath).forEach((folder) => folders.add(folder));
      }),
    },
  };
  return { app, files, runtime };
}

describe('ActionWorkbenchService', () => {
  it('refreshes managed views after external edits, archive, restore and deletion without importing duplicates', async () => {
    const vault = createVault({ [WAITING]: '# 等待与委托\n<!-- second-brain:waiting-view -->\n' });
    const service = new ActionWorkbenchService(vault.app as never);
    await service.initialize(NOW);
    const action = await service.createAction({ title: '外部状态', status: 'planned' }, NOW);
    jest.useFakeTimers();
    try {
      const refresh = jest.spyOn(service, 'refreshViews');
      const update = vault.files.get(action.path)!.replace('status: planned', 'status: waiting');
      await vault.app.vault.adapter.write(action.path, update);
      service.handleVaultChange(action.path);
      service.handleVaultChange(action.path);
      service.handleVaultChange('020_行动系统/行动台账.md');
      await jest.advanceTimersByTimeAsync(400);
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(vault.files.get(WAITING)).toContain('外部状态');
      const archived = await service.completeAction(action.id, NOW);
      expect(vault.files.get(WAITING)).not.toContain('外部状态');
      const restored = await service.restoreAction(action.id, NOW);
      expect(vault.files.get(WAITING)).toContain('外部状态');
      await vault.app.vault.adapter.remove(restored.path);
      service.handleVaultChange(restored.path);
      service.handleVaultChange(archived.path);
      await jest.advanceTimersByTimeAsync(400);
      expect(vault.files.get(WAITING)).not.toContain('外部状态');
      expect(vault.files.get('020_行动系统/行动台账.md')).not.toContain('外部状态');
      await service.initialize(NOW);
      expect(await service.listActions()).toHaveLength(0);
      service.handleVaultChange(action.path);
      service.dispose();
      await jest.advanceTimersByTimeAsync(400);
      expect(refresh).toHaveBeenCalledTimes(2);
    } finally { jest.useRealTimers(); }
  });

  it('preserves handwritten waiting notes and supports two-day schedules without reminders', async () => {
    const original = '# 等待\n手写内容\n';
    const vault = createVault({ [WAITING]: original });
    const service = new ActionWorkbenchService(vault.app as never);
    await service.initialize(NOW);
    const action = await service.createAction({ title: '两天讲座', status: 'planned', startDate: '2026-09-28', endDate: '2026-09-29', dueDate: '2026-09-29' }, NOW);
    for (const day of [28, 29]) expect((await service.getBrief(new Date(2026, 8, day))).today.map(a => a.id)).toContain(action.id);
    for (const day of [27, 30]) expect((await service.getBrief(new Date(2026, 8, day))).today).toHaveLength(0);
    expect(action.reminderAt).toBe('');
    await service.updateAction(action.id, { status: 'waiting' }, NOW);
    expect((await service.getBrief(new Date(2026, 8, 30))).overdue).toHaveLength(0);
    expect((await service.getBrief(new Date(2026, 8, 29))).today).toHaveLength(0);
    expect(vault.files.get(WAITING)).toBe(original);
    const reloaded = new ActionWorkbenchService(vault.app as never);
    await reloaded.initialize(NOW);
    expect((await reloaded.getAction(action.id))?.startDate).toBe('2026-09-28');
  });

  it('allows a later event to refresh again after a failed refresh', async () => {
    const vault = createVault();
    const service = new ActionWorkbenchService(vault.app as never);
    const refresh = jest.spyOn(service, 'refreshViews').mockRejectedValueOnce(new Error('temporary')).mockResolvedValue(undefined);
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.useFakeTimers();
    try {
      service.handleVaultChange('020_行动系统/行动记录/进行中/A-1.md');
      await jest.advanceTimersByTimeAsync(400);
      service.handleVaultChange('020_行动系统/行动记录/进行中/A-1.md');
      await jest.advanceTimersByTimeAsync(400);
      expect(refresh).toHaveBeenCalledTimes(2);
      expect(warning).toHaveBeenCalledTimes(1);
    } finally { service.dispose(); warning.mockRestore(); jest.useRealTimers(); }
  });

  it('recognizes only durable action record Markdown paths', () => {
    expect(isActionRecordPath('020_行动系统/行动记录/进行中/A-1.md')).toBe(true);
    expect(isActionRecordPath('020_行动系统\\行动记录\\归档\\2026-08\\A-2.md')).toBe(true);
    expect(isActionRecordPath('020_行动系统/行动台账.md')).toBe(false);
    expect(isActionRecordPath('020_行动系统/行动记录/进行中/A-1.json')).toBe(false);
  });

  it('creates, completes, archives and restores one durable action record', async () => {
    const vault = createVault();
    const service = new ActionWorkbenchService(vault.app as never);
    await service.initialize(NOW);

    const created = await service.createAction({
      title: '  完成接触器控制链验收  ',
      status: 'today',
      priority: 'high',
      dueDate: '2026-08-11',
    }, NOW);
    expect(created.path).toBe('020_行动系统/行动记录/进行中/A-20260811-001.md');
    expect((await service.getBrief(NOW)).today).toHaveLength(1);

    const completed = await service.completeAction(created.id, new Date(2026, 7, 11, 10, 0, 0));
    expect(completed.path).toBe('020_行动系统/行动记录/归档/2026-08/A-20260811-001.md');
    expect(vault.files.has(created.path)).toBe(false);
    expect(vault.files.get('020_行动系统/行动台账.md')).toContain('完成接触器控制链验收');

    const restored = await service.restoreAction(created.id, new Date(2026, 7, 11, 10, 5, 0));
    expect(restored.status).toBe('today');
    expect(restored.path).toBe(created.path);
  });

  it('imports legacy tasks once and preserves existing action ids', async () => {
    const vault = createVault({
      [NEXT_ACTIONS]: [
        '# 下一步行动',
        '## 今天',
        '- [ ] 画出电机直接启动控制链 <!-- sb-action:A-20260803-001 -->',
        '## 等待之后再做',
        '- [ ] 复刻贾维斯最小功能',
      ].join('\n'),
      [WAITING]: [
        '# 等待与委托',
        '| 事项 | 对方 / 条件 | 记录日期 | 下次跟进 |',
        '| --- | --- | --- | --- |',
        '| 等待入职通知 | 公司 | 2026-08-01 | 2026-08-15 |',
      ].join('\n'),
    });
    const service = new ActionWorkbenchService(vault.app as never);

    await expect(service.initialize(NOW)).resolves.toEqual({ imported: 3 });
    await expect(service.initialize(NOW)).resolves.toEqual({ imported: 0 });
    const actions = await service.listActions();
    expect(actions).toHaveLength(3);
    expect(actions.find((action) => action.title.includes('控制链'))?.id).toBe('A-20260803-001');
    expect(actions.find((action) => action.title.includes('入职通知'))).toMatchObject({ status: 'waiting', dueDate: '2026-08-15' });
  });

  it('merges near-duplicate global and project actions while preserving the project link', async () => {
    const vault = createVault({
      [NEXT_ACTIONS]: [
        '# 下一步行动',
        '## 本周',
        '- [ ] 路线第2月第一步：复刻1张电机控制回路，补全端子对应，形成测量点表；最终用5个故障检验。',
      ].join('\n'),
      [PROJECT]: [
        '# 入职前能力补强',
        '## 下一步',
        '- [ ] 第2月第一步：复刻1张电机控制回路，补全端子对应，并形成“测量对象—参考点—预期值—风险”测量点表。',
      ].join('\n'),
    });
    const service = new ActionWorkbenchService(vault.app as never);

    await expect(service.initialize(NOW)).resolves.toEqual({ imported: 1 });
    const actions = await service.listActions();
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ project: '入职前能力补强' });
  });

  it('parses notes without swallowing later sections', () => {
    const record = parseActionRecord('a.md', [
      '---',
      'type: action',
      'id: "A-1"',
      'status: planned',
      'priority: medium',
      '---',
      '# 测试行动',
      '## 备注',
      '只保留这段',
      '## 其他',
      '不要进入备注',
    ].join('\n'));
    expect(record?.note).toBe('只保留这段');
  });

  it('records a condition-based status decision without overwriting the original action', async () => {
    const vault = createVault();
    const service = new ActionWorkbenchService(vault.app as never);
    await service.initialize(NOW);
    const created = await service.createAction({
      title: '核验低压证和仪表证安排',
      status: 'planned',
      priority: 'high',
      dueDate: '2026-09-11',
      reminderAt: '2026-09-10T20:00',
      project: '运维部基层实习与岗位适应',
    }, NOW);

    const updated = await service.recordStatusDecision(created.id, {
      decision: 'waiting-condition',
      conclusion: '低压证继续保留，等待公司统一组织高压证和仪表实操机会。',
      reason: '新规与当前岗位需求改变了原核验计划。',
      evidence: '应急〔2026〕45号',
      reopenCondition: '公司发布统一报名通知或岗位明确要求。',
      effectiveDate: '2026-08-29',
    }, new Date(2026, 7, 29, 21, 0, 0));

    expect(updated).toMatchObject({
      title: created.title,
      status: 'waiting',
      priority: 'none',
      dueDate: '',
      reminderAt: '',
      decision: 'waiting-condition',
      decisionEffectiveDate: '2026-08-29',
    });
    const stored = vault.files.get(created.path) ?? '';
    expect(stored).toContain('# 核验低压证和仪表证安排');
    expect(stored).toContain('## 当前状态结论');
    expect(stored).toContain('重新激活条件：公司发布统一报名通知或岗位明确要求。');
    expect(stored).toContain('## 状态变更记录');
    expect(vault.files.get('020_行动系统/行动台账.md')).toContain('现状：等待条件');
  });

  it('preserves status-decision history and can reactivate a waiting action', async () => {
    const vault = createVault();
    const service = new ActionWorkbenchService(vault.app as never);
    await service.initialize(NOW);
    const created = await service.createAction({ title: '等待统一考试', status: 'planned' }, NOW);
    await service.recordStatusDecision(created.id, {
      decision: 'waiting-condition',
      conclusion: '暂不主动报名。',
      reason: '等待公司统一安排。',
      reopenCondition: '公司发布报名通知。',
    }, new Date(2026, 7, 29, 9, 0, 0));
    const reactivated = await service.recordStatusDecision(created.id, {
      decision: 'continue',
      conclusion: '公司已发布报名通知，恢复执行。',
      reason: '重新激活条件已经满足。',
      evidence: '公司报名通知',
    }, new Date(2026, 8, 5, 9, 0, 0));

    expect(reactivated.status).toBe('planned');
    expect(reactivated.decisionHistory.match(/^### /gmu)).toHaveLength(2);
    expect(reactivated.decisionHistory).toContain('暂不主动报名。');
    expect(reactivated.decisionHistory).toContain('恢复执行。');
  });

  it('rejects a condition-based status decision without an activation condition', async () => {
    const vault = createVault();
    const service = new ActionWorkbenchService(vault.app as never);
    await service.initialize(NOW);
    const created = await service.createAction({ title: '等待统一考试', status: 'planned' }, NOW);
    await expect(service.recordStatusDecision(created.id, {
      decision: 'waiting-condition',
      conclusion: '暂不处理。',
      reason: '等待外部条件。',
    }, NOW)).rejects.toThrow('等待条件不能为空');
  });

  it('shows recurring actions only on their configured calendar days', async () => {
    const vault = createVault();
    const service = new ActionWorkbenchService(vault.app as never);
    await service.initialize(NOW);
    const daily = await service.createAction({
      title: '每天呼吸训练',
      status: 'planned',
      actionType: 'recurring',
      recurrence: 'daily',
      startDate: '2026-08-10',
    }, NOW);
    const weekdays = await service.createAction({
      title: '工作日整理记录',
      status: 'planned',
      actionType: 'recurring',
      recurrence: 'weekdays',
      startDate: '2026-08-10',
    }, NOW);
    const wednesday = await service.createAction({
      title: '每周三复查',
      status: 'planned',
      actionType: 'recurring',
      recurrence: 'weekly',
      recurrenceDays: '3',
      startDate: '2026-08-10',
    }, NOW);

    expect(isLongTermScheduledOn(daily, new Date(2026, 7, 15))).toBe(true);
    expect(isLongTermScheduledOn(weekdays, new Date(2026, 7, 15))).toBe(false);
    expect(isLongTermScheduledOn(wednesday, new Date(2026, 7, 12))).toBe(true);
    expect(isLongTermScheduledOn(wednesday, new Date(2026, 7, 13))).toBe(false);
  });

  it('completes and undoes one recurring occurrence without archiving the action', async () => {
    const vault = createVault();
    const service = new ActionWorkbenchService(vault.app as never);
    await service.initialize(NOW);
    const created = await service.createAction({
      title: '睡前做几组 90/90 呼吸',
      status: 'planned',
      priority: 'medium',
      actionType: 'recurring',
      recurrence: 'daily',
      startDate: '2026-08-11',
      preferredTime: '22:30',
    }, NOW);

    const completed = await service.completeAction(created.id, new Date(2026, 7, 11, 22, 35));
    expect(completed.status).toBe('planned');
    expect(completed.path).toContain('/进行中/');
    expect(completed.completionCount).toBe(1);
    expect(isLongTermCompletedOn(completed, new Date(2026, 7, 11))).toBe(true);
    expect((await service.getLongTermDue(new Date(2026, 7, 11, 23, 0)))).toHaveLength(0);

    const undone = await service.undoLongTermOccurrence(created.id, new Date(2026, 7, 11, 23, 5));
    expect(undone.completionCount).toBe(0);
    expect(isLongTermCompletedOn(undone, new Date(2026, 7, 11))).toBe(false);
    expect((await service.getLongTermDue(new Date(2026, 7, 11, 23, 6)))).toHaveLength(1);
  });

  it('moves a maintenance review forward from the completion date', async () => {
    const vault = createVault();
    const service = new ActionWorkbenchService(vault.app as never);
    await service.initialize(NOW);
    const created = await service.createAction({
      title: '每 7 天复查睡眠数据',
      status: 'planned',
      actionType: 'maintenance',
      recurrence: 'after-completion-days',
      recurrenceInterval: 7,
      startDate: '2026-08-11',
      nextDueDate: '2026-08-11',
    }, NOW);

    expect((await service.getLongTermDue(NOW))).toHaveLength(1);
    const completed = await service.completeLongTermOccurrence(created.id, NOW);
    expect(completed.nextDueDate).toBe('2026-08-18');
    expect((await service.getLongTermDue(new Date(2026, 7, 17)))).toHaveLength(0);
    expect((await service.getLongTermDue(new Date(2026, 7, 18)))).toHaveLength(1);
  });
});

import { ActionReminderService } from '../../../../src/core/knowledge/ActionReminderService';

describe('ActionReminderService', () => {
  it('delivers a due reminder once and allows a changed reminder time to fire again', async () => {
    const runtime = new Map<string, string>();
    const app = {
      vault: {
        adapter: {
          exists: jest.fn(async (path: string) => runtime.has(path)),
          read: jest.fn(async (path: string) => runtime.get(path) ?? ''),
          write: jest.fn(async (path: string, content: string) => { runtime.set(path, content); }),
        },
      },
    };
    const action = {
      id: 'A-1',
      title: '完成验收',
      status: 'today',
      dueDate: '2026-08-11',
      reminderAt: '2026-08-11T09:00',
    };
    const workbench = { listActions: jest.fn(async () => [action]) };
    const notify = jest.fn();
    const service = new ActionReminderService(app as never, workbench as never, notify);

    await expect(service.check(new Date(2026, 7, 11, 9, 30))).resolves.toBe(1);
    await expect(service.check(new Date(2026, 7, 11, 10, 0))).resolves.toBe(0);
    action.reminderAt = '2026-08-11T10:30';
    await expect(service.check(new Date(2026, 7, 11, 10, 31))).resolves.toBe(1);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('ignores future and completed actions', async () => {
    const app = { vault: { adapter: { exists: async () => false, read: async () => '', write: async () => undefined } } };
    const workbench = { listActions: async () => [
      { id: 'A-1', title: '未来事项', status: 'planned', reminderAt: '2026-08-12T09:00' },
      { id: 'A-2', title: '已完成事项', status: 'completed', reminderAt: '2026-08-10T09:00' },
    ] };
    const notify = jest.fn();
    const service = new ActionReminderService(app as never, workbench as never, notify);

    await expect(service.check(new Date(2026, 7, 11, 9, 30))).resolves.toBe(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it('delivers a recurring reminder once per due day and skips completed occurrences', async () => {
    const runtime = new Map<string, string>();
    const app = { vault: { adapter: {
      exists: async (path: string) => runtime.has(path),
      read: async (path: string) => runtime.get(path) ?? '',
      write: async (path: string, content: string) => { runtime.set(path, content); },
    } } };
    const action = {
      id: 'A-LONG', title: '睡前呼吸', status: 'planned', actionType: 'recurring', recurrence: 'daily',
      recurrenceDays: '', recurrenceInterval: 0, startDate: '2026-08-11', endDate: '',
      preferredTime: '22:30', lastCompletedAt: '', createdAt: '2026-08-11T09:00:00',
    };
    const workbench = { listActions: jest.fn(async () => [action]) };
    const notify = jest.fn();
    const service = new ActionReminderService(app as never, workbench as never, notify);

    await expect(service.check(new Date(2026, 7, 11, 22, 29))).resolves.toBe(0);
    await expect(service.check(new Date(2026, 7, 11, 22, 30))).resolves.toBe(1);
    await expect(service.check(new Date(2026, 7, 11, 23, 0))).resolves.toBe(0);
    action.lastCompletedAt = '2026-08-12T21:30:00';
    await expect(service.check(new Date(2026, 7, 12, 22, 30))).resolves.toBe(0);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

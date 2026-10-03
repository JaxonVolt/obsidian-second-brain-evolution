import { createMockEl } from '@test/helpers/mockElement';

let lastModalInstance: any;

jest.mock('obsidian', () => {
  const actual = jest.requireActual('obsidian');

  class MockModal {
    app: any;
    modalEl = createMockEl();
    contentEl = createMockEl();
    titleEl = createMockEl();

    constructor(app: any) {
      this.app = app;
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      lastModalInstance = this;
    }

    open() {
      this.onOpen();
    }

    close() {
      this.onClose();
    }

    onOpen() {}
    onClose() {}
  }

  return { ...actual, Modal: MockModal };
});

import { ActionWorkbenchModal } from '../../../../src/features/action/ActionWorkbenchModal';

function wait(milliseconds = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function createHarness(actions: any[] = [], initialView?: string) {
  const callbacks = new Map<string, (...args: any[]) => void>();
  const refs = new Map<string, object>();
  const vault = {
    on: jest.fn((event: string, callback: (...args: any[]) => void) => {
      callbacks.set(event, callback);
      const ref = { event };
      refs.set(event, ref);
      return ref;
    }),
    offref: jest.fn(),
  };
  const app = { vault } as any;
  const plugin = {
    settings: {
      actionWorkbenchDefaultView: 'today',
      actionWorkbenchViewOrder: ['today', 'inbox', 'planned'],
      actionWorkbenchHiddenViews: [],
      actionWorkbenchCustomViews: [],
      actionWorkbenchCompactMode: false,
    },
  } as any;
  const service = {
    initialize: jest.fn().mockResolvedValue(undefined),
    listActions: jest.fn().mockResolvedValue(actions),
    createAction: jest.fn().mockResolvedValue(undefined),
    updateAction: jest.fn().mockResolvedValue(undefined),
    completeAction: jest.fn().mockResolvedValue(undefined),
    restoreAction: jest.fn().mockResolvedValue(undefined),
    completeLongTermOccurrence: jest.fn().mockResolvedValue(undefined),
    undoLongTermOccurrence: jest.fn().mockResolvedValue(undefined),
    finishLongTermAction: jest.fn().mockResolvedValue(undefined),
    cancelAction: jest.fn().mockResolvedValue(undefined),
    recordStatusDecision: jest.fn().mockResolvedValue(undefined),
  } as any;
  const modal = new ActionWorkbenchModal(app, plugin, service, initialView);
  return { callbacks, refs, vault, service, modal };
}

describe('ActionWorkbenchModal', () => {
  it('keeps one-off schedule dates when editing an existing action', async () => {
    const actions = [{ id: 'A-1', title: '讲座', status: 'planned', priority: 'high', project: '', note: '', dueDate: '2026-09-29', reminderAt: '', actionType: 'one-off', startDate: '2026-09-28', endDate: '2026-09-29', recurrenceDays: '' }];
    const { modal, service } = createHarness(actions, 'planned');
    modal.onOpen();
    await wait();
    const controls = modal.contentEl.querySelector('.second-brain-workbench-row-controls') as HTMLElement;
    (controls.children[1] as HTMLElement).click();
    (lastModalInstance.contentEl.querySelector('.mod-cta') as HTMLElement).click();
    await wait();
    expect(service.updateAction).toHaveBeenCalledWith('A-1', expect.objectContaining({ startDate: '2026-09-28', endDate: '2026-09-29', reminderAt: '' }));
    modal.onClose();
  });

  beforeEach(() => {
    lastModalInstance = null;
    (globalThis as any).window = globalThis;
  });

  it('uses a dedicated create button instead of the quick Enter field', async () => {
    const { modal } = createHarness();
    modal.onOpen();
    await wait();

    expect(modal.contentEl.querySelector('.second-brain-workbench-quick-add')).toBeNull();
    const createButton = modal.contentEl.querySelector('.second-brain-workbench-create') as HTMLElement | null;
    expect(createButton).not.toBeNull();

    createButton?.click();
    expect(lastModalInstance.titleEl.textContent).toBe('新建行动或日程');
    expect(lastModalInstance.contentEl.querySelector('.second-brain-action-edit-form')).not.toBeNull();
  });

  it('debounces all action record changes and unregisters listeners on close', async () => {
    const { callbacks, refs, vault, service, modal } = createHarness();
    modal.onOpen();
    await wait();
    expect(service.listActions).toHaveBeenCalledTimes(1);

    callbacks.get('modify')?.({ path: '020_行动系统/行动台账.md' });
    await wait(300);
    expect(service.listActions).toHaveBeenCalledTimes(1);

    callbacks.get('create')?.({ path: '020_行动系统/行动记录/进行中/A-1.md' });
    callbacks.get('modify')?.({ path: '020_行动系统/行动记录/进行中/A-1.md' });
    callbacks.get('rename')?.(
      { path: '020_行动系统/行动记录/归档/2026-08/A-1.md' },
      '020_行动系统/行动记录/进行中/A-1.md',
    );
    callbacks.get('delete')?.({ path: '020_行动系统/行动记录/归档/2026-08/A-1.md' });
    await wait(300);
    expect(service.listActions).toHaveBeenCalledTimes(2);

    modal.onClose();
    expect(vault.offref).toHaveBeenCalledTimes(4);
    for (const ref of refs.values()) expect(vault.offref).toHaveBeenCalledWith(ref);
  });

  it('opens the inbox directly and only shows inbox actions', async () => {
    const actions = [
      { id: 'A-1', title: '收集事项', status: 'inbox', priority: 'none', project: '', note: '', dueDate: '', reminderAt: '' },
      { id: 'A-2', title: '今日事项', status: 'today', priority: 'high', project: '', note: '', dueDate: '', reminderAt: '' },
    ];
    const { modal } = createHarness(actions, 'inbox');
    modal.onOpen();
    await wait();

    expect(modal.contentEl.querySelectorAll('.second-brain-workbench-row')).toHaveLength(1);
    expect((modal as any).filterActions(actions, 'inbox').map((action: any) => action.id)).toEqual(['A-1']);
  });

  it('keeps planned actions separate from the dated schedule view', () => {
    const actions = [
      { id: 'A-1', title: '以后安排', status: 'planned', priority: 'none', project: '', note: '', dueDate: '', reminderAt: '' },
      { id: 'A-2', title: '已有日期', status: 'inbox', priority: 'none', project: '', note: '', dueDate: '2099-01-01', reminderAt: '' },
    ];
    const { modal } = createHarness(actions);

    expect((modal as any).filterActions(actions, 'planned').map((action: any) => action.id)).toEqual(['A-1']);
    expect((modal as any).filterActions(actions, 'scheduled').map((action: any) => action.id)).toEqual(['A-2']);
  });

  it('renders long action titles as naturally growing multi-line editors', async () => {
    const longTitle = '整理一份包含前因后果、验收条件和下一步安排的完整学习记录，确保工作台中能够直接阅读全部内容';
    const actions = [
      { id: 'A-1', title: longTitle, status: 'inbox', priority: 'medium', project: '', note: '', dueDate: '', reminderAt: '' },
    ];
    const { modal, service } = createHarness(actions, 'inbox');
    modal.onOpen();
    await wait();

    const title = modal.contentEl.querySelector('.second-brain-workbench-title') as any;
    expect(title.tagName).toBe('DIV');
    expect(title.textContent).toBe(longTitle);
    expect(title.style.height).toBeUndefined();

    title.textContent = `${longTitle}，并补充实际结果。`;
    title.dispatchEvent('blur');
    await wait();
    expect(service.updateAction).toHaveBeenCalledWith('A-1', { title: title.textContent });
  });

  it('shows the current decision separately and opens the status update form', async () => {
    const actions = [{
      id: 'A-1', title: '核对证书安排', status: 'waiting', priority: 'none', project: '岗位适应', note: '',
      dueDate: '', reminderAt: '', decision: 'waiting-condition', currentConclusion: '等待公司统一组织高压取证。',
      decisionReason: '当前尚未取得高压证。', decisionEvidence: '应急〔2026〕45号',
      reopenCondition: '公司发布统一报名通知。', decisionEffectiveDate: '2026-08-29', decisionUpdatedAt: '',
      decisionHistory: '', actionType: 'one-off', recurrence: '', recurrenceDays: '', recurrenceInterval: 0,
      startDate: '', endDate: '', preferredTime: '', nextDueDate: '', lastCompletedAt: '', completionCount: 0,
      completionLog: [], createdAt: '2026-08-11T08:00:00', updatedAt: '2026-08-29T08:00:00', completedAt: '',
      previousStatus: 'planned', sourcePath: '', path: 'A-1.md',
    }];
    const { modal } = createHarness(actions, 'waiting');
    modal.onOpen();
    await wait();

    const state = modal.contentEl.querySelector('.second-brain-workbench-state') as any;
    expect(state.querySelector('.second-brain-workbench-state-conclusion')?.textContent)
      .toContain('等待公司统一组织高压取证');
    expect(state.querySelector('.second-brain-workbench-state-trigger')?.textContent)
      .toContain('公司发布统一报名通知');

    const controls = modal.contentEl.querySelector('.second-brain-workbench-row-controls') as any;
    const updateButton = Array.from(controls.children)
      .find((button: any) => button.getAttribute('aria-label') === '更新现状') as any;
    expect(updateButton).toBeDefined();
    updateButton.click();
    expect(lastModalInstance.titleEl.textContent).toBe('更新行动现状');
    expect(lastModalInstance.contentEl.querySelector('.second-brain-action-status-form')).not.toBeNull();
  });

  it('separates regular and long-term actions in Today and completes only the current occurrence', async () => {
    const actions = [
      {
        id: 'A-1', title: '提交一次性材料', status: 'today', priority: 'high', project: '', note: '',
        dueDate: '', reminderAt: '', actionType: 'one-off', recurrence: '', recurrenceDays: '',
        recurrenceInterval: 0, startDate: '', endDate: '', preferredTime: '', nextDueDate: '',
        lastCompletedAt: '', completionCount: 0, completionLog: [], createdAt: '2026-08-15T08:00:00',
        updatedAt: '2026-08-15T08:00:00', completedAt: '', previousStatus: 'today', path: 'A-1.md',
      },
      {
        id: 'A-2', title: '睡前做 90/90 呼吸', status: 'planned', priority: 'medium', project: '', note: '',
        dueDate: '', reminderAt: '', actionType: 'recurring', recurrence: 'daily', recurrenceDays: '',
        recurrenceInterval: 0, startDate: '2000-01-01', endDate: '', preferredTime: '22:30', nextDueDate: '',
        lastCompletedAt: '', completionCount: 3, completionLog: [], createdAt: '2026-08-15T08:00:00',
        updatedAt: '2026-08-15T08:00:00', completedAt: '', previousStatus: 'planned', path: 'A-2.md',
      },
    ];
    const { modal, service } = createHarness(actions);
    modal.onOpen();
    await wait();

    const headings = Array.from(modal.contentEl.querySelectorAll('.second-brain-workbench-section-heading'))
      .map((node: any) => node.children[0]?.textContent);
    expect(headings).toEqual(['今日常规行动', '今日长期行动']);

    const longTermRow = modal.contentEl.querySelector('.is-long-term') as any;
    const checkbox = longTermRow.children.find((child: any) => child.tagName === 'INPUT') as any;
    expect(checkbox.getAttribute('aria-label')).toBe('完成本次');
    checkbox.checked = true;
    checkbox.dispatchEvent('change');
    await wait();

    expect(service.completeLongTermOccurrence).toHaveBeenCalledWith('A-2');
    expect(service.completeAction).not.toHaveBeenCalledWith('A-2');
  });
});

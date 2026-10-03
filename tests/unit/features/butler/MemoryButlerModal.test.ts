import { createMockEl } from '@test/helpers/mockElement';

jest.mock('obsidian', () => {
  const actual = jest.requireActual('obsidian');

  class MockModal {
    app: any;
    modalEl = createMockEl();
    contentEl = createMockEl();
    titleEl = createMockEl();

    constructor(app: any) {
      this.app = app;
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

  return { ...actual, Modal: MockModal, Notice: jest.fn(), setIcon: jest.fn() };
});

import { MemoryButlerModal } from '../../../../src/features/butler/MemoryButlerModal';

function wait(milliseconds = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function createHarness(createAction = jest.fn().mockResolvedValue({ path: '020_行动系统/行动记录/进行中/A-1.md' })) {
  const discovery = {
    id: 'D-1',
    title: '复刻贾维斯',
    actionText: '闲暇时复刻一下贾维斯',
    summary: '日志中出现了尚未安排的行动意图。',
    projectName: '',
    evidence: { sourcePath: '310_每日行为日志/2026-08/2026-08-03.md', quote: '闲暇时复刻一下贾维斯' },
  };
  const plugin = {
    settings: {
      memoryButlerModules: ['action-discovery'],
      memoryButlerMode: 'quiet',
    },
    saveSettings: jest.fn().mockResolvedValue(undefined),
  } as any;
  const actionLifecycle = {
    getCenter: jest.fn().mockResolvedValue({ discoveries: [discovery], progress: [] }),
    analyze: jest.fn().mockResolvedValue({ generated: 0, invalidated: 0 }),
    markAppliedExternally: jest.fn().mockResolvedValue(undefined),
  } as any;
  const reviewService = { scan: jest.fn().mockResolvedValue({ items: [] }) } as any;
  const insightService = {
    getCenter: jest.fn().mockResolvedValue({ items: [], counts: { pending: 0, observing: 0, snoozed: 0, history: 0 } }),
    analyze: jest.fn().mockResolvedValue({ generated: 0, observationMatches: 0, invalidated: 0 }),
  } as any;
  const workbench = {
    createAction,
    getLongTermDue: jest.fn().mockResolvedValue([]),
    completeLongTermOccurrence: jest.fn().mockResolvedValue(undefined),
    updateAction: jest.fn().mockResolvedValue(undefined),
  } as any;
  const actions = {
    openSource: jest.fn(),
    discussInsight: jest.fn(),
    discussAction: jest.fn(),
    discussReview: jest.fn(),
    openWorkbench: jest.fn(),
    onCountChanged: jest.fn(),
  };
  const modal = new MemoryButlerModal({} as any, plugin, actionLifecycle, reviewService, insightService, workbench, actions);
  return { modal, createAction, actionLifecycle, workbench, actions, plugin, reviewService, insightService };
}

function buttonLabels(root: any): string[] {
  const labels: string[] = [];
  const visit = (node: any) => {
    if (node.tagName === 'BUTTON') labels.push(node.textContent);
    for (const child of node.children ?? []) visit(child);
  };
  visit(root);
  return labels;
}

function findButton(root: any, label: string): any {
  if (root.tagName === 'BUTTON' && root.textContent === label) return root;
  for (const child of root.children ?? []) {
    const found = findButton(child, label);
    if (found) return found;
  }
  return null;
}

describe('MemoryButlerModal action routing', () => {
  it('does not scan or analyze disabled modules', async () => {
    const { modal, plugin, actionLifecycle, reviewService, insightService } = createHarness();
    plugin.settings.memoryButlerModules = [];
    modal.onOpen();
    await wait();
    await (modal as unknown as { scan: () => Promise<void> }).scan();
    expect(actionLifecycle.getCenter).not.toHaveBeenCalled();
    expect(actionLifecycle.analyze).not.toHaveBeenCalled();
    expect(reviewService.scan).not.toHaveBeenCalled();
    expect(insightService.getCenter).not.toHaveBeenCalled();
    expect(insightService.analyze).not.toHaveBeenCalled();
  });

  it('keeps action discovery available without starting disabled insight analysis', async () => {
    const { modal, actionLifecycle, reviewService, insightService } = createHarness();
    modal.onOpen();
    await wait();
    await (modal as unknown as { scan: () => Promise<void> }).scan();
    expect(actionLifecycle.analyze).toHaveBeenCalledTimes(1);
    expect(reviewService.scan).not.toHaveBeenCalled();
    expect(insightService.analyze).not.toHaveBeenCalled();
  });

  it('requires the user to choose a destination before creating an action', async () => {
    const { modal, createAction } = createHarness();
    modal.onOpen();
    await wait();

    const add = modal.contentEl.querySelector('.second-brain-butler-add') as any;
    expect(add.disabled).toBe(true);
    add.click();
    await wait();
    expect(createAction).not.toHaveBeenCalled();
  });

  it('preserves the chosen priority and sends the action to the chosen view', async () => {
    const { modal, createAction, actionLifecycle, actions } = createHarness();
    modal.onOpen();
    await wait();

    const priority = modal.contentEl.querySelector('.second-brain-butler-priority') as any;
    const destination = modal.contentEl.querySelector('.second-brain-butler-destination') as any;
    const dueDate = modal.contentEl.querySelector('.second-brain-butler-due-date') as any;
    const add = modal.contentEl.querySelector('.second-brain-butler-add') as any;
    priority.value = 'high';
    destination.value = 'planned';
    dueDate.value = '2026-08-20';
    destination.dispatchEvent('change');
    expect(add.disabled).toBe(false);
    add.click();
    await wait();

    expect(createAction).toHaveBeenCalledWith(expect.objectContaining({
      title: '闲暇时复刻一下贾维斯',
      status: 'planned',
      priority: 'high',
      dueDate: '2026-08-20',
    }));
    expect(actionLifecycle.markAppliedExternally).toHaveBeenCalledWith('D-1', '020_行动系统/行动记录/进行中/A-1.md');

    const openWorkbench = modal.contentEl.querySelector('.second-brain-butler-open-workbench') as any;
    openWorkbench.click();
    expect(actions.openWorkbench).toHaveBeenCalledWith('planned');
  });

  it('keeps the candidate available when creating the action fails', async () => {
    const createAction = jest.fn().mockRejectedValue(new Error('写入失败'));
    const { modal, actionLifecycle } = createHarness(createAction);
    modal.onOpen();
    await wait();

    const destination = modal.contentEl.querySelector('.second-brain-butler-destination') as any;
    const add = modal.contentEl.querySelector('.second-brain-butler-add') as any;
    destination.value = 'today';
    destination.dispatchEvent('change');
    add.click();
    await wait();

    expect(actionLifecycle.markAppliedExternally).not.toHaveBeenCalled();
    expect(add.disabled).toBe(false);
  });

  it('shows explicit destinations for an abstract insight and has no accepted dead end', async () => {
    const insight = {
      id: 'I-1',
      kind: 'cross-domain-link',
      title: '人际判断需要继续验证',
      summary: '目前只有一次经历，不能形成绝对规则。',
      suggestedAction: '再记录三次真实事件。',
      evidence: [{ sourcePath: '300_复盘与日志/复盘.md', quote: '需要结合场景复盘。' }],
      status: 'pending',
    };
    const plugin = {
      settings: { memoryButlerModules: ['insight'], memoryButlerMode: 'quiet' },
      saveSettings: jest.fn().mockResolvedValue(undefined),
    } as any;
    const actionLifecycle = { getCenter: jest.fn().mockResolvedValue({ discoveries: [], progress: [] }) } as any;
    const reviewService = { scan: jest.fn().mockResolvedValue({ items: [] }) } as any;
    const insightService = {
      getCenter: jest.fn().mockResolvedValue({
        items: [insight],
        counts: { pending: 1, observing: 0, snoozed: 0, history: 0 },
      }),
      getKindLabel: jest.fn(() => '跨领域连接'),
    } as any;
    const modal = new MemoryButlerModal(
      {} as any,
      plugin,
      actionLifecycle,
      reviewService,
      insightService,
      { createAction: jest.fn(), getLongTermDue: jest.fn().mockResolvedValue([]) } as any,
      {
        openSource: jest.fn(),
        discussInsight: jest.fn(),
        discussAction: jest.fn(),
        discussReview: jest.fn(),
        openWorkbench: jest.fn(),
        onCountChanged: jest.fn(),
      },
    );

    modal.onOpen();
    await wait();

    const labels = buttonLabels(modal.contentEl);
    expect(labels).toEqual(expect.arrayContaining(['加入行动', '修改判断', '沉淀经验', '继续观察', '修改来源', '不需要']));
    expect(labels).not.toContain('确认采纳');
  });

  it('shows due long-term actions and records one occurrence without invoking an agent', async () => {
    const { modal, workbench } = createHarness();
    workbench.getLongTermDue.mockResolvedValue([{
      id: 'A-LONG', title: '睡前做 90/90 呼吸', status: 'planned', priority: 'medium',
      actionType: 'recurring', recurrence: 'daily', recurrenceDays: '', recurrenceInterval: 0,
      preferredTime: '22:30', completionCount: 2,
    }]);

    modal.onOpen();
    await wait();

    expect(buttonLabels(modal.contentEl)).toEqual(expect.arrayContaining(['完成本次', '打开长期行动']));
    const complete = findButton(modal.contentEl, '完成本次');
    complete.click();
    await wait();

    expect(workbench.completeLongTermOccurrence).toHaveBeenCalledWith('A-LONG');
  });
});

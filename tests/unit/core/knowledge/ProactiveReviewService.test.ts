import { TFile } from 'obsidian';

import {
  ProactiveReviewService,
  type ProactiveReviewSettings,
  type ReviewItem,
} from '../../../../src/core/knowledge/ProactiveReviewService';

const NEXT_ACTIONS = '020_行动系统/下一步行动.md';
const WAITING = '020_行动系统/等待与委托.md';
const DECISIONS = '020_行动系统/决策记录.md';

function createVault(initial: Record<string, { content: string; mtime?: number }>) {
  const files = new Map<string, string>();
  const tFiles = new Map<string, TFile>();
  const runtime = new Map<string, string>();
  for (const [path, value] of Object.entries(initial)) {
    files.set(path, value.content);
    const file = new TFile();
    const name = path.split('/').pop() ?? '';
    Object.assign(file, {
      path,
      name,
      basename: name.replace(/\.md$/, ''),
      extension: 'md',
      stat: { mtime: value.mtime ?? new Date(2026, 6, 25).getTime(), ctime: 0, size: 0 },
    });
    tFiles.set(path, file);
  }

  const app = {
    vault: {
      getMarkdownFiles: jest.fn(() => [...tFiles.values()]),
      cachedRead: jest.fn(async (file: TFile) => files.get(file.path) ?? ''),
      read: jest.fn(async (file: TFile) => files.get(file.path) ?? ''),
      modify: jest.fn(async (file: TFile, content: string) => { files.set(file.path, content); }),
      create: jest.fn(async (path: string, content: string) => {
        files.set(path, content);
        const file = new TFile();
        const name = path.split('/').pop() ?? '';
        Object.assign(file, {
          path,
          name,
          basename: name.replace(/\.md$/, ''),
          extension: 'md',
          stat: { mtime: Date.now(), ctime: Date.now(), size: content.length },
        });
        tFiles.set(path, file);
        return file;
      }),
      getAbstractFileByPath: jest.fn((path: string) => tFiles.get(path) ?? null),
      adapter: {
        exists: jest.fn(async (path: string) => runtime.has(path) || path === '.second-brain/runtime'),
        read: jest.fn(async (path: string) => runtime.get(path) ?? ''),
        write: jest.fn(async (path: string, content: string) => { runtime.set(path, content); }),
        mkdir: jest.fn(),
      },
    },
  };
  return { app, files, runtime };
}

function settings(overrides: Partial<ProactiveReviewSettings> = {}): ProactiveReviewSettings {
  return {
    enabled: true,
    projectStaleDays: 14,
    weeklyActionDays: 7,
    maxVisible: 10,
    startupNotice: true,
    ...overrides,
  };
}

describe('ProactiveReviewService', () => {
  it('tracks new tasks without immediately declaring them overdue', async () => {
    const vault = createVault({
      [NEXT_ACTIONS]: {
        content: '# 下一步行动\n\n## 今天\n- [ ] 今天任务\n\n## 本周\n- [ ] 本周任务\n',
      },
    });
    const service = new ProactiveReviewService(vault.app as never, () => settings());

    const first = await service.scan(new Date(2026, 6, 25, 9));
    expect(first.items).toHaveLength(0);

    const nextDay = await service.scan(new Date(2026, 6, 26, 9));
    expect(nextDay.items.map((item) => item.kind)).toEqual(['today-carryover']);

    const nextWeek = await service.scan(new Date(2026, 7, 1, 9));
    expect(nextWeek.items.map((item) => item.kind).sort()).toEqual(['today-carryover', 'weekly-stale']);
  });

  it('detects overdue, stalled, and missing-next-action projects conservatively', async () => {
    const projectPath = '020_行动系统/活跃项目/测试项目/测试项目.md';
    const vault = createVault({
      [projectPath]: {
        mtime: new Date(2026, 6, 1).getTime(),
        content: [
          '---',
          'type: project',
          'status: active',
          'updated: 2026-07-01',
          'deadline: 2026-07-20',
          '---',
          '# 测试项目',
          '## 下一步',
          '- [x] 已做完',
        ].join('\n'),
      },
    });
    const service = new ProactiveReviewService(vault.app as never, () => settings());

    const result = await service.scan(new Date(2026, 6, 25, 9));
    expect(result.items.map((item) => item.kind)).toEqual([
      'project-no-next-action',
      'project-overdue',
      'project-stale',
    ]);
    expect(result.items[0].severity).toBe('high');
  });

  it('does not treat an empty waiting table or decision template as real records', async () => {
    const vault = createVault({
      [WAITING]: {
        content: '# 等待与委托\n| 事项 | 对方 / 条件 | 记录日期 | 下次跟进 |\n| --- | --- | --- | --- |\n',
      },
      [DECISIONS]: {
        content: '# 决策记录\n| 日期 | 决策 | 背景 | 依据 | 复盘时间 |\n| --- | --- | --- | --- | --- |\n|  |  |  |  |  |\n\n## 决策模板\n- 决策：',
      },
    });
    const service = new ProactiveReviewService(vault.app as never, () => settings());

    expect((await service.scan(new Date(2026, 6, 25, 9))).items).toHaveLength(0);
  });

  it('detects due and incomplete waiting and decision records', async () => {
    const vault = createVault({
      [WAITING]: {
        content: [
          '# 等待与委托',
          '| 事项 | 对方 / 条件 | 记录日期 | 下次跟进 |',
          '| --- | --- | --- | --- |',
          '| 等回复 | 同事 | 2026-07-20 | 2026-07-25 |',
          '| 等材料 | 供应商 | 2026-07-21 | |',
          '## 已解除',
          '| 已解决 | - | 2026-07-22 |',
        ].join('\n'),
      },
      [DECISIONS]: {
        content: [
          '# 决策记录',
          '| 日期 | 决策 | 背景 | 依据 | 复盘时间 |',
          '| --- | --- | --- | --- | --- |',
          '| 2026-07-01 | 继续项目 | 试运行 | 有数据 | 2026-07-25 |',
          '| 2026-07-02 | 暂缓购买 | 信息不足 | 等通勤数据 | |',
          '## 决策模板',
        ].join('\n'),
      },
    });
    const service = new ProactiveReviewService(vault.app as never, () => settings());

    const kinds = (await service.scan(new Date(2026, 6, 25, 9))).items.map((item) => item.kind);
    expect(kinds).toEqual([
      'waiting-overdue',
      'decision-review-due',
      'waiting-missing-date',
      'decision-missing-review-date',
    ]);
  });

  it('returns every detected item while keeping the configured viewport size', async () => {
    const vault = createVault({
      [WAITING]: {
        content: [
          '| 事项 | 对方 / 条件 | 记录日期 | 下次跟进 |',
          '| --- | --- | --- | --- |',
          '| 等回复一 | 同事 | 2026-07-20 | 2026-07-25 |',
          '| 等回复二 | 同事 | 2026-07-20 | 2026-07-25 |',
          '| 等回复三 | 同事 | 2026-07-20 | 2026-07-25 |',
          '| 等回复四 | 同事 | 2026-07-20 | 2026-07-25 |',
        ].join('\n'),
      },
    });
    const service = new ProactiveReviewService(vault.app as never, () => settings({ maxVisible: 3 }));

    const result = await service.scan(new Date(2026, 6, 25, 9));

    expect(result.totalDetected).toBe(4);
    expect(result.items).toHaveLength(4);
    expect(result.viewportItems).toBe(3);
  });

  it('persists snooze and dismiss state across repeated scans', async () => {
    const vault = createVault({
      [WAITING]: {
        content: '| 事项 | 对方 / 条件 | 记录日期 | 下次跟进 |\n| --- | --- | --- | --- |\n| 等回复 | 同事 | 2026-07-20 | 2026-07-25 |\n',
      },
    });
    const service = new ProactiveReviewService(vault.app as never, () => settings());
    const first = await service.scan(new Date(2026, 6, 25, 9));
    const item = first.items[0];

    await service.snooze(item.id, 3, new Date(2026, 6, 25, 9));
    expect((await service.scan(new Date(2026, 6, 26, 9))).items).toHaveLength(0);
    expect((await service.scan(new Date(2026, 6, 28, 10))).items).toHaveLength(1);

    await service.dismiss(item.id);
    expect((await service.scan(new Date(2026, 7, 5, 9))).items).toHaveLength(0);
  });

  it('reopens a dismissed issue only after its source changes', async () => {
    const vault = createVault({
      [WAITING]: {
        content: '| 事项 | 对方 / 条件 | 记录日期 | 下次跟进 |\n| --- | --- | --- | --- |\n| 等回复 | 同事 | 2026-07-20 | |\n',
      },
    });
    const service = new ProactiveReviewService(vault.app as never, () => settings());
    const first = await service.scan(new Date(2026, 6, 25, 9));
    await service.dismiss(first.items[0].id);
    expect((await service.scan(new Date(2026, 6, 26, 9))).items).toHaveLength(0);

    vault.files.set(
      WAITING,
      '| 事项 | 对方 / 条件 | 记录日期 | 下次跟进 |\n| --- | --- | --- | --- |\n| 等回复 | 新条件 | 2026-07-20 | |\n',
    );
    expect((await service.scan(new Date(2026, 6, 26, 10))).items).toHaveLength(1);
  });

  it('stores quick-feedback reasons and can undo a dismissed reminder', async () => {
    const vault = createVault({
      [WAITING]: {
        content: '| 事项 | 对方 / 条件 | 记录日期 | 下次跟进 |\n| --- | --- | --- | --- |\n| 等回复 | 同事 | 2026-07-20 | 2026-07-25 |\n',
      },
    });
    const service = new ProactiveReviewService(vault.app as never, () => settings());
    const item = (await service.scan(new Date(2026, 6, 25, 9))).items[0];

    await service.dismiss(item.id, 'outdated');
    expect((await service.scan(new Date(2026, 6, 25, 10))).items).toHaveLength(0);
    expect(vault.runtime.get('.second-brain/runtime/review-state.json')).toContain('"feedbackReason": "outdated"');

    await service.restore(item.id);
    expect((await service.scan(new Date(2026, 6, 25, 11))).items).toHaveLength(1);
    expect(vault.runtime.get('.second-brain/runtime/review-state.json')).not.toContain('feedbackReason');
  });

  it('marks only the confirmed task complete and resolves its reminder', async () => {
    const vault = createVault({
      [NEXT_ACTIONS]: {
        content: '# 下一步行动\n## 今天\n- [ ] 同名任务\n## 本周\n- [ ] 同名任务\n',
      },
    });
    const service = new ProactiveReviewService(vault.app as never, () => settings());
    await service.scan(new Date(2026, 6, 25, 9));
    const result = await service.scan(new Date(2026, 6, 26, 9));
    const item = result.items.find((candidate) => candidate.kind === 'today-carryover') as ReviewItem;

    expect(await service.completeTask(item)).toBe(true);
    expect(vault.files.get(NEXT_ACTIONS)).toContain('## 今天\n- [x] 同名任务');
    expect(vault.files.get(NEXT_ACTIONS)).toContain('## 本周\n- [ ] 同名任务');
  });

  it('records the daily scan date and recognizes relevant paths', async () => {
    const vault = createVault({});
    const service = new ProactiveReviewService(vault.app as never, () => settings());

    expect(await service.shouldRunDaily(new Date(2026, 6, 25, 8))).toBe(true);
    await service.scan(new Date(2026, 6, 25, 9));
    expect(await service.shouldRunDaily(new Date(2026, 6, 25, 20))).toBe(false);
    expect(service.isRelevantPath(NEXT_ACTIONS)).toBe(true);
    expect(service.isRelevantPath('500_永久笔记/测试.md')).toBe(false);
  });

  it('creates structured decisions and detects them when review is due', async () => {
    const vault = createVault({
      [DECISIONS]: {
        content: [
          '---',
          'type: decision-log',
          'updated: "2026-07-09"',
          '---',
          '# 决策记录',
          '',
          '## 决策模板',
          '- 决策：',
        ].join('\n'),
      },
    });
    const service = new ProactiveReviewService(vault.app as never, () => settings());

    const id = await service.createDecision({
      title: '先完成最小训练',
      decisionDate: '2026-07-25',
      reviewDate: '2026-08-24',
      background: '即将入职',
      rationale: '现场能力优先',
      expectedResult: '完成一份可验证成果',
    }, new Date(2026, 6, 25, 9));

    expect(id).toBe('D-20260725-001');
    expect(vault.files.get(DECISIONS)).toContain('## 决策事项');
    expect(vault.files.get(DECISIONS)).toContain('- 复盘日期：2026-08-24');
    expect((await service.scan(new Date(2026, 7, 23, 9))).items).toHaveLength(0);
    expect((await service.scan(new Date(2026, 7, 24, 9))).items[0]).toMatchObject({
      kind: 'decision-review-due',
      title: '先完成最小训练',
    });
  });
});

import { TFile } from 'obsidian';

import {
  type ActionCatalogItem,
  ActionLifecycleService,
  type ActionProgressStatus,
  type ActionSuggestionKind,
  type ActiveProjectSummary,
  extractActionLifecycleJson,
  extractLocalActionSignals,
} from '../../../../src/core/knowledge/ActionLifecycleService';

const NEXT_ACTIONS = '020_行动系统/下一步行动.md';
const PROJECT_INDEX = '020_行动系统/项目清单.md';
const WAITING = '020_行动系统/等待与委托.md';
const DAILY = '300_复盘与日志/310_每日笔记/2026-08/2026-08-03.md';
const PROJECT = '020_行动系统/活跃项目/入职前能力补强/入职前能力补强.md';
const NOW = new Date(2026, 7, 10, 10, 0, 0);

function parentPaths(path: string): string[] {
  const parts = path.split('/');
  const result: string[] = [];
  for (let index = 1; index < parts.length; index++) result.push(parts.slice(0, index).join('/'));
  return result;
}

function createVault(initial: Record<string, string>) {
  const files = new Map<string, string>();
  const runtime = new Map<string, string>();
  const tFiles = new Map<string, TFile>();
  const folders = new Set<string>(['.second-brain', '.second-brain/runtime']);
  let clock = NOW.getTime();
  let failPath = '';

  const upsertFile = (path: string, content: string) => {
    files.set(path, content);
    clock += 1;
    let file = tFiles.get(path);
    if (!file) {
      file = new TFile();
      const name = path.split('/').pop() ?? '';
      Object.assign(file, {
        path,
        name,
        basename: name.replace(/\.md$/u, ''),
        extension: 'md',
      });
      tFiles.set(path, file);
    }
    Object.assign(file, { stat: { mtime: clock, ctime: clock, size: content.length } });
    parentPaths(path).forEach((folder) => folders.add(folder));
  };
  Object.entries(initial).forEach(([path, content]) => upsertFile(path, content));

  const adapter = {
    exists: jest.fn(async (path: string) => files.has(path) || runtime.has(path) || folders.has(path)),
    read: jest.fn(async (path: string) => {
      if (files.has(path)) return files.get(path) ?? '';
      if (runtime.has(path)) return runtime.get(path) ?? '';
      throw new Error(`missing: ${path}`);
    }),
    write: jest.fn(async (path: string, content: string) => {
      if (failPath === path) {
        failPath = '';
        throw new Error(`injected write failure: ${path}`);
      }
      if (path.startsWith('.second-brain/')) runtime.set(path, content);
      else upsertFile(path, content);
      parentPaths(path).forEach((folder) => folders.add(folder));
    }),
    mkdir: jest.fn(async (path: string) => { folders.add(path); }),
    remove: jest.fn(async (path: string) => {
      files.delete(path);
      runtime.delete(path);
      tFiles.delete(path);
    }),
    rmdir: jest.fn(async (path: string) => { folders.delete(path); }),
  };
  const app = {
    vault: {
      getMarkdownFiles: jest.fn(() => [...tFiles.values()]),
      getAbstractFileByPath: jest.fn((path: string) => tFiles.get(path) ?? null),
      cachedRead: jest.fn(async (file: TFile) => files.get(file.path) ?? ''),
      read: jest.fn(async (file: TFile) => files.get(file.path) ?? ''),
      adapter,
    },
    workspace: { openLinkText: jest.fn() },
    secretStorage: { getSecret: jest.fn() },
  };
  return {
    app,
    files,
    runtime,
    setFile: upsertFile,
    failNextWrite(path: string) { failPath = path; },
  };
}

function nextActions(task = '- [ ] 完成 Day5 学习验收'): string {
  return [
    '---',
    'type: next-actions',
    'updated: "2026-08-03"',
    '---',
    '# 下一步行动',
    '## 今天',
    '',
    '## 本周',
    '### 职业主线（按顺序做）',
    task,
    '',
    '## 等待之后再做',
    '',
    '## 已完成',
    '',
  ].join('\n');
}

function projectIndex(): string {
  return [
    '---',
    'type: project-index',
    'updated: "2026-08-03"',
    '---',
    '# 项目清单',
    '## 活跃项目',
    '| 项目 | 目标结果 | 下一步 | 关联领域 |',
    '| --- | --- | --- | --- |',
    '| [[入职前能力补强]] | 完成训练 | 完成 Day5 学习验收 | [[职场与硬核技术]] |',
    '',
    '## 等待 / 暂停',
  ].join('\n');
}

function waiting(): string {
  return [
    '# 等待与委托',
    '| 事项 | 对方 / 条件 | 记录日期 | 下次跟进 |',
    '| --- | --- | --- | --- |',
    '',
    '## 已解除',
  ].join('\n');
}

function projectNote(): string {
  return [
    '---',
    'type: project',
    'status: active',
    'updated: "2026-08-03"',
    '---',
    '# 入职前能力补强',
    '## 目标结果',
    '- 完成训练',
    '## 下一步',
    '- [ ] 完成 Day5 学习验收',
    '## 进展记录',
    '',
  ].join('\n');
}

function dailyIdeas(): string {
  return [
    '# 2026-08-03',
    '## 今天做了什么',
    '- 今天在抖音上看到一个博主做了贾维斯 Jarvis 语音助手，闲暇时复刻一下，作为漫威粉丝我一直想拥有自己的贾维斯。',
    '- 下午出去有氧，想买杯瑞幸咖啡，结果重复付了两次钱。',
    '- 后续优化方向在于行动系统使用率过低问题。',
    '## 今天的想法',
    '- 我打算工作之后尽快自己居住，并自己学习做饭。',
  ].join('\n');
}

function progressDaily(): string {
  return '# 2026-08-10\n## 今天做了什么\n- 已经完成 Day5 学习验收，下一步开始 Day6。\n';
}

function pluginStub() {
  return {
    settings: {},
    getResolvedCodexCliPath: jest.fn(),
    getActiveEnvironmentVariables: jest.fn(() => ''),
  } as never;
}

function extractPromptArray(prompt: string, label: string, nextLabel: string): Array<Record<string, unknown>> {
  const start = prompt.indexOf(`${label}：`);
  const end = prompt.indexOf(`\n${nextLabel}：`, start);
  if (start < 0 || end < 0) throw new Error(`missing payload: ${label}`);
  return JSON.parse(prompt.slice(start + label.length + 1, end)) as Array<Record<string, unknown>>;
}

function discoveryRunner(counter?: { calls: number }) {
  return async (prompt: string) => {
    if (counter) counter.calls += 1;
    const signals = extractPromptArray(prompt, '候选片段', '当前行动');
    const jarvis = signals.find((item) => String(item.quote).includes('贾维斯'));
    if (!jarvis) return '[]';
    return JSON.stringify([{
      candidateId: jarvis.candidateId,
      type: 'discovery',
      title: '复刻贾维斯语音助手',
      summary: '这是长期兴趣，适合先做一次小验证，不应直接塞入今天。',
      rationale: '原文表达了持续兴趣，但没有截止时间。',
      evidenceQuote: '闲暇时复刻一下',
      confidence: 0.91,
      temporalScope: 'inspiration',
      actionText: '用 25 分钟列出贾维斯语音助手的最小可行功能',
      projectName: '贾维斯语音助手',
      nextActionText: '列出最小可行功能',
      matchedActionId: '',
      matchedProjectPath: '',
    }]);
  };
}

function progressRunner(status: ActionProgressStatus, withProject: boolean) {
  return async (prompt: string) => {
    const signals = extractPromptArray(prompt, '候选片段', '当前行动');
    const actions = extractPromptArray(prompt, '当前行动', '活跃项目');
    const signal = signals.find((item) => String(item.quote).includes('完成 Day5'));
    const action = actions.find((item) => String(item.text).includes('Day5')
      && Array.isArray(item.paths) && item.paths.includes(NEXT_ACTIONS));
    if (!signal || !action) return '[]';
    return JSON.stringify([{
      candidateId: signal.candidateId,
      type: 'progress',
      title: 'Day5 学习进度',
      summary: '日志明确记录了 Day5 的状态变化。',
      rationale: '原文与当前行动直接对应。',
      evidenceQuote: '已经完成 Day5 学习验收',
      confidence: 0.98,
      temporalScope: 'now',
      actionText: '开始 Day6 学习',
      projectName: '入职前能力补强',
      nextActionText: '开始 Day6 学习',
      progressStatus: status,
      matchedActionId: action.id,
      matchedProjectPath: withProject ? PROJECT : '',
    }]);
  };
}

function createService(
  vault: ReturnType<typeof createVault>,
  runner: (prompt: string, mode: 'fast' | 'deep') => Promise<string>,
): ActionLifecycleService {
  return new ActionLifecycleService(
    vault.app as never,
    pluginStub(),
    () => ({ enabled: true, viewportItems: 3 }),
    runner,
  );
}

async function createProgressRecord(status: ActionProgressStatus, withProject = false) {
  const initial: Record<string, string> = {
    [NEXT_ACTIONS]: nextActions(),
    [PROJECT_INDEX]: projectIndex(),
    [WAITING]: waiting(),
    [DAILY]: progressDaily(),
  };
  if (withProject) initial[PROJECT] = projectNote();
  const vault = createVault(initial);
  const service = createService(vault, progressRunner(status, withProject));
  const result = await service.analyze(true, NOW);
  expect(result.records).toHaveLength(1);
  return { vault, service, record: result.records[0], initial };
}

describe('ActionLifecycleService', () => {
  it('keeps the Jarvis idea while allowing the model to reject coffee and resolved-system anecdotes', () => {
    const content = dailyIdeas();
    const signals = extractLocalActionSignals(DAILY, content);
    expect(signals.some((item) => item.quote.includes('贾维斯'))).toBe(true);
    expect(signals.some((item) => item.quote.includes('咖啡'))).toBe(false);

    const jarvis = signals.find((item) => item.quote.includes('贾维斯'))!;
    const records = extractActionLifecycleJson(JSON.stringify([{
      candidateId: jarvis.id,
      type: 'discovery',
      title: '复刻贾维斯语音助手',
      summary: '先保留兴趣，再做最小验证。',
      rationale: '有持续兴趣但没有时限。',
      evidenceQuote: '闲暇时复刻一下',
      confidence: 0.9,
      temporalScope: 'inspiration',
      actionText: '用 25 分钟列出最小功能',
      projectName: '贾维斯语音助手',
      nextActionText: '列出最小功能',
    }]), new Map(signals.map((item) => [item.id, item])), new Map<string, ActionCatalogItem>(), new Map<string, ActiveProjectSummary>(), NOW);

    expect(records).toHaveLength(1);
    expect(records[0].title).toContain('贾维斯');
    expect(records[0].suggestions.map((item) => item.kind)).toEqual(['keep', 'add-week', 'create-project', 'dismiss']);
    expect(records[0].suggestions.some((item) => item.kind === 'add-today')).toBe(false);
  });

  it('treats post-employment independent living as conditional instead of a today task', () => {
    const signals = extractLocalActionSignals(DAILY, dailyIdeas());
    const conditional = signals.find((item) => item.quote.includes('工作之后'))!;
    const records = extractActionLifecycleJson(JSON.stringify([{
      candidateId: conditional.id,
      type: 'discovery',
      title: '工作后独立居住并学习做饭',
      summary: '依赖入职和住址条件。',
      rationale: '原文明确带有条件。',
      evidenceQuote: '工作之后尽快自己居住',
      confidence: 0.88,
      temporalScope: 'conditional',
      actionText: '定岗后核对通勤与租房条件',
      projectName: '独立居住准备',
      nextActionText: '核对通勤与租房条件',
    }]), new Map(signals.map((item) => [item.id, item])), new Map(), new Map(), NOW);
    expect(records[0].suggestions[0].kind).toBe('remind');
    expect(records[0].suggestions.some((item) => item.kind === 'add-today')).toBe(false);
  });

  it('does not re-bill unchanged historical notes', async () => {
    const counter = { calls: 0 };
    const vault = createVault({
      [NEXT_ACTIONS]: nextActions('- [ ] 其他行动'),
      [PROJECT_INDEX]: projectIndex(),
      [WAITING]: waiting(),
      [DAILY]: dailyIdeas(),
    });
    const service = createService(vault, discoveryRunner(counter));
    expect((await service.analyze(true, NOW)).generated).toBe(1);
    expect((await service.analyze(true, NOW)).generated).toBe(0);
    expect(counter.calls).toBe(1);
  });

  it('passes an action status decision to the model instead of only its old title', async () => {
    let currentActions: Array<Record<string, unknown>> = [];
    const actionPath = '020_行动系统/行动记录/进行中/A-20260811-517.md';
    const vault = createVault({
      [NEXT_ACTIONS]: nextActions('- [ ] 其他行动'),
      [PROJECT_INDEX]: projectIndex(),
      [WAITING]: waiting(),
      [DAILY]: dailyIdeas(),
      [actionPath]: [
        '---',
        'type: action',
        'id: "A-20260811-517"',
        'status: waiting',
        'priority: none',
        'due: ""',
        'reminder: ""',
        'project: "岗位适应"',
        'source: ""',
        'decision: "waiting-condition"',
        'decision_conclusion: "等待公司统一组织高压取证。"',
        'decision_reason: "当前尚未取得高压证。"',
        'decision_evidence: "应急〔2026〕45号"',
        'reopen_condition: "公司发布统一报名通知。"',
        'decision_effective: "2026-08-29"',
        'decision_updated: "2026-08-29T08:00:00"',
        'previous_status: planned',
        'created: "2026-08-11T08:00:00"',
        'updated: "2026-08-29T08:00:00"',
        'completed: ""',
        '---',
        '# 证书核验',
      ].join('\n'),
    });
    const service = createService(vault, async (prompt) => {
      currentActions = extractPromptArray(prompt, '当前行动', '活跃项目');
      return '[]';
    });

    await service.analyze(true, NOW);

    const action = currentActions.find((item) => item.id === 'A-20260811-517');
    expect(action?.context).toContain('等待条件');
    expect(action?.context).toContain('等待公司统一组织高压取证');
    expect(action?.context).toContain('公司发布统一报名通知');
  });

  it('limits the first historical pass to 20 notes and keeps the remainder queued', async () => {
    const initial: Record<string, string> = {
      [NEXT_ACTIONS]: nextActions('- [ ] 其他行动'),
      [PROJECT_INDEX]: projectIndex(),
      [WAITING]: waiting(),
    };
    for (let index = 1; index <= 25; index++) {
      initial[`300_复盘与日志/测试记录/${String(index).padStart(2, '0')}.md`] = `# 记录 ${index}\n- 计划完成测试事项 ${index}`;
    }
    const vault = createVault(initial);
    const service = createService(vault, async () => '[]');
    const result = await service.analyze(true, NOW);

    expect(result.processedNotes).toBe(20);
    expect(result.remainingNotes).toBe(5);
  });

  it('adds a confirmed 25-minute validation to this week with a stable id and snapshot', async () => {
    const vault = createVault({
      [NEXT_ACTIONS]: nextActions('- [ ] 其他行动'),
      [PROJECT_INDEX]: projectIndex(),
      [WAITING]: waiting(),
      [DAILY]: dailyIdeas(),
    });
    const service = createService(vault, discoveryRunner());
    const record = (await service.analyze(true, NOW)).records[0];
    const plan = await service.preparePlan(record.id, 'add-week', {}, NOW);
    const result = await service.applyPlan(plan, NOW);

    expect(vault.files.get(NEXT_ACTIONS)).toContain('### 复盘新增');
    expect(vault.files.get(NEXT_ACTIONS)).toContain('sb-action:A-20260810-001');
    expect(vault.files.get(NEXT_ACTIONS)).toContain('2026-08-03|来源');
    expect(result.snapshotPath).toContain('.second-brain/snapshots/');
    expect(vault.runtime.has(`${result.snapshotPath}/manifest.json`)).toBe(true);
  });

  it('rejects an approved preview when its evidence changes before execution', async () => {
    const vault = createVault({
      [NEXT_ACTIONS]: nextActions('- [ ] 其他行动'),
      [PROJECT_INDEX]: projectIndex(),
      [WAITING]: waiting(),
      [DAILY]: dailyIdeas(),
    });
    const service = createService(vault, discoveryRunner());
    const record = (await service.analyze(true, NOW)).records[0];
    const plan = await service.preparePlan(record.id, 'add-week', {}, NOW);
    vault.setFile(DAILY, `${dailyIdeas()}\n- 后续补充`);

    await expect(service.applyPlan(plan, NOW)).rejects.toThrow('来源笔记内容已经变化');
    expect(vault.files.get(NEXT_ACTIONS)).not.toContain('贾维斯');
  });

  it('syncs a confirmed completion into action, project, and project index in one transaction', async () => {
    const { vault, service, record } = await createProgressRecord('completed', true);
    const plan = await service.preparePlan(record.id, 'complete', {
      statusNote: '已完成 Day5 验收',
      nextActionText: '开始 Day6 学习',
    }, NOW);
    const result = await service.applyPlan(plan, NOW);

    expect(vault.files.get(NEXT_ACTIONS)).toContain('- [x] 完成 Day5 学习验收');
    expect(vault.files.get(NEXT_ACTIONS)).toContain('sb-action:A-20260810-001');
    expect(vault.files.get(PROJECT)).toContain('完成“完成 Day5 学习验收”');
    expect(vault.files.get(PROJECT_INDEX)).toContain('| 开始 Day6 学习 |');
    expect(result.changedPaths).toEqual(expect.arrayContaining([NEXT_ACTIONS, PROJECT, PROJECT_INDEX]));
  });

  it('rolls every visible file back when a later write fails', async () => {
    const { vault, service, record, initial } = await createProgressRecord('completed', true);
    const plan = await service.preparePlan(record.id, 'complete', {
      statusNote: '已完成 Day5 验收',
      nextActionText: '开始 Day6 学习',
    }, NOW);
    vault.failNextWrite(PROJECT_INDEX);

    await expect(service.applyPlan(plan, NOW)).rejects.toThrow('injected write failure');
    expect(vault.files.get(NEXT_ACTIONS)).toBe(initial[NEXT_ACTIONS]);
    expect(vault.files.get(PROJECT)).toBe(initial[PROJECT]);
    expect(vault.files.get(PROJECT_INDEX)).toBe(initial[PROJECT_INDEX]);
  });

  it('does not undo the successful apply when the same preview is confirmed twice concurrently', async () => {
    const { vault, service, record } = await createProgressRecord('completed', true);
    const plan = await service.preparePlan(record.id, 'complete', {
      statusNote: '已完成 Day5 验收', nextActionText: '开始 Day6 学习',
    }, NOW);
    const outcomes = await Promise.allSettled([service.applyPlan(plan, NOW), service.applyPlan(plan, NOW)]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'rejected']);
    expect(vault.files.get(NEXT_ACTIONS)).toContain('- [x] 完成 Day5 学习验收');
    expect(vault.files.get(PROJECT_INDEX)).toContain('| 开始 Day6 学习 |');
  });

  it.each<{
    modelStatus: ActionProgressStatus;
    suggestion: ActionSuggestionKind;
    expectedPath: string;
    expectedText: string;
  }>([
    { modelStatus: 'partial', suggestion: 'partial', expectedPath: NEXT_ACTIONS, expectedText: 'sb-status:partial' },
    { modelStatus: 'partial', suggestion: 'adjust', expectedPath: NEXT_ACTIONS, expectedText: '开始 Day6 学习' },
    { modelStatus: 'partial', suggestion: 'postpone', expectedPath: NEXT_ACTIONS, expectedText: 'sb-status:postponed' },
    { modelStatus: 'waiting', suggestion: 'waiting', expectedPath: WAITING, expectedText: '完成 Day5 学习验收 <!-- sb-action:' },
    { modelStatus: 'waiting', suggestion: 'abandon', expectedPath: NEXT_ACTIONS, expectedText: 'sb-status:abandoned' },
  ])('applies $suggestion without manual editing of the action system', async ({ modelStatus, suggestion: kind, expectedPath, expectedText }) => {
    const { vault, service, record } = await createProgressRecord(modelStatus);
    const plan = await service.preparePlan(record.id, kind, {
      actionText: '开始 Day6 学习',
      statusNote: '根据日志确认',
      nextActionText: '开始 Day6 学习',
    }, NOW);
    await service.applyPlan(plan, NOW);
    expect(vault.files.get(expectedPath)).toContain(expectedText);
  });

  it('refuses to add a fourth unfinished item to today', async () => {
    const todayFull = nextActions('- [ ] 其他行动').replace(
      '## 今天\n',
      '## 今天\n- [ ] 事项一\n- [ ] 事项二\n- [ ] 事项三\n',
    );
    const vault = createVault({
      [NEXT_ACTIONS]: todayFull,
      [PROJECT_INDEX]: projectIndex(),
      [WAITING]: waiting(),
      [DAILY]: dailyIdeas(),
    });
    const service = createService(vault, discoveryRunner());
    const record = (await service.analyze(true, NOW)).records[0];
    record.suggestions = [{ kind: 'add-today', label: '加入今天', actionText: record.actionText }];
    await expect(service.preparePlan(record.id, 'add-today', {}, NOW)).rejects.toThrow('已有 3 项未完成行动');
  });

  it('updates a pending suggestion locally without another model call or visible note write', async () => {
    const counter = { calls: 0 };
    const vault = createVault({
      [NEXT_ACTIONS]: nextActions('- [ ] 其他行动'),
      [PROJECT_INDEX]: projectIndex(),
      [WAITING]: waiting(),
      [DAILY]: dailyIdeas(),
    });
    const service = createService(vault, discoveryRunner(counter));
    const record = (await service.analyze(true, NOW)).records[0];
    const originalDaily = vault.files.get(DAILY);

    const updated = await service.updateRecord(record.id, {
      title: '复刻一个最小版贾维斯',
      summary: '先做语音唤醒验证，不建立长期项目。',
      rationale: '这是兴趣验证，不是当前主线。',
      actionText: '用 25 分钟验证语音唤醒',
      projectName: '',
      nextActionText: '记录验证结果',
    }, NOW);

    expect(updated.title).toBe('复刻一个最小版贾维斯');
    expect(updated.projectName).toBe('贾维斯语音助手');
    expect(updated.suggestions.find((item) => item.kind === 'add-week')?.actionText).toBe('用 25 分钟验证语音唤醒');
    expect(vault.files.get(DAILY)).toBe(originalDaily);
    expect(counter.calls).toBe(1);
    expect(vault.runtime.get('.second-brain/runtime/action-lifecycle-state.json')).toContain('复刻一个最小版贾维斯');
  });

  it('applies quick feedback immediately and supports a local undo', async () => {
    const vault = createVault({
      [NEXT_ACTIONS]: nextActions('- [ ] 其他行动'),
      [PROJECT_INDEX]: projectIndex(),
      [WAITING]: waiting(),
      [DAILY]: dailyIdeas(),
    });
    const service = createService(vault, discoveryRunner());
    const record = (await service.analyze(true, NOW)).records[0];

    await service.dismissRecord(record.id, 'outdated', '', NOW);
    expect((await service.getCenter(NOW)).discoveries).toHaveLength(0);
    expect(vault.runtime.get('.second-brain/runtime/action-lifecycle-state.json')).toContain('"feedbackReason": "outdated"');

    await service.restoreRecord(record.id, NOW);
    expect((await service.getCenter(NOW)).discoveries).toHaveLength(1);
    expect(vault.runtime.get('.second-brain/runtime/action-lifecycle-state.json')).not.toContain('feedbackReason');
  });
});

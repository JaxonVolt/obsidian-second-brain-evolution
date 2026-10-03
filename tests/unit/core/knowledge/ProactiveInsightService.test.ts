import { TFile } from 'obsidian';

import {
  computeInsightContentSignature,
  extractInsightJson,
  extractObservationMatchJson,
  type InsightRecord,
  type LocalInsightCandidate,
  ProactiveInsightService,
  type ProactiveInsightSettings,
} from '../../../../src/core/knowledge/ProactiveInsightService';

const STATE_PATH = '.second-brain/runtime/insight-state.json';
const NEXT_ACTIONS = '020_行动系统/下一步行动.md';

function createVault(initial: Record<string, { content: string; mtime?: number }>) {
  const files = new Map<string, string>();
  const tFiles = new Map<string, TFile>();
  const runtime = new Map<string, string>();

  const addFile = (path: string, content: string, mtime = Date.now()) => {
    files.set(path, content);
    const file = new TFile();
    const name = path.split('/').pop() ?? '';
    Object.assign(file, {
      path,
      name,
      basename: name.replace(/\.md$/iu, ''),
      extension: 'md',
      stat: { mtime, ctime: mtime, size: content.length },
    });
    tFiles.set(path, file);
    return file;
  };

  for (const [path, value] of Object.entries(initial)) {
    addFile(path, value.content, value.mtime);
  }

  const app = {
    metadataCache: { resolvedLinks: {} },
    secretStorage: { getSecret: jest.fn(() => null) },
    vault: {
      getMarkdownFiles: jest.fn(() => [...tFiles.values()]),
      cachedRead: jest.fn(async (file: TFile) => files.get(file.path) ?? ''),
      read: jest.fn(async (file: TFile) => files.get(file.path) ?? ''),
      modify: jest.fn(async (file: TFile, content: string) => {
        files.set(file.path, content);
        Object.assign(file.stat, { mtime: file.stat.mtime + 1, size: content.length });
      }),
      create: jest.fn(async (path: string, content: string) => addFile(path, content)),
      getAbstractFileByPath: jest.fn((path: string) => tFiles.get(path) ?? null),
      adapter: {
        exists: jest.fn(async (path: string) => runtime.has(path)
          || tFiles.has(path)
          || path === '.second-brain'
          || path === '.second-brain/runtime'
          || path === '.second-brain/snapshots'
          || path === '500_永久笔记与知识资产'),
        read: jest.fn(async (path: string) => runtime.get(path) ?? files.get(path) ?? ''),
        write: jest.fn(async (path: string, content: string) => { runtime.set(path, content); }),
        mkdir: jest.fn(),
      },
    },
  };

  const update = (path: string, content: string, mtime: number) => {
    files.set(path, content);
    const file = tFiles.get(path);
    if (!file) throw new Error(`missing ${path}`);
    Object.assign(file.stat, { mtime, size: content.length });
  };

  const remove = (path: string) => {
    files.delete(path);
    tFiles.delete(path);
  };

  const move = (from: string, to: string, mtime = Date.now()) => {
    const content = files.get(from);
    if (content === undefined) throw new Error(`missing ${from}`);
    remove(from);
    addFile(to, content, mtime);
  };

  return { app, files, runtime, tFiles, update, remove, move };
}

function settings(overrides: Partial<ProactiveInsightSettings> = {}): ProactiveInsightSettings {
  return {
    enabled: true,
    autoAnalyze: true,
    minChangedNotes: 3,
    dailyLimit: 3,
    viewportItems: 3,
    startupNotice: true,
    ...overrides,
  };
}

function pluginStub() {
  return {
    settings: {},
    getResolvedCodexCliPath: jest.fn(() => ''),
    getActiveEnvironmentVariables: jest.fn(() => ''),
  };
}

function processableInsight(id = 'insight-test'): InsightRecord {
  return {
    id,
    candidateId: 'candidate-test',
    kind: 'repeat-pattern',
    title: '形成可验证的学习循环',
    summary: '多次记录都指向先做最小实践再补理论。',
    rationale: '三篇学习笔记出现相同模式。',
    evidence: [{ sourcePath: '100_领域与职责/学习一.md', quote: '先做一个最小实践。' }],
    counterEvidence: '尚未覆盖长期复杂任务。',
    confidence: 0.82,
    suggestedAction: '完成一次 25 分钟最小实践并记录结果',
    status: 'pending',
    sourceSignature: 'signature',
    createdAt: '2026-07-25T00:00:00.000Z',
    updatedAt: '2026-07-25T00:00:00.000Z',
  };
}

describe('ProactiveInsightService', () => {
  it('establishes a baseline without queuing old notes and excludes raw inbox files', async () => {
    const vault = createVault({
      '100_领域与职责/学习一.md': { content: '# 学习一\nPLC 学习与现场训练。', mtime: 1 },
      '010_收件箱/原始输入_raw/临时想法.md': { content: '# 原始输入\nPLC 学习。', mtime: 1 },
    });
    const service = new ProactiveInsightService(vault.app as never, pluginStub() as never, () => settings());

    const result = await service.prepare(false, new Date(2026, 6, 25, 9));

    expect(result.baselineEstablished).toBe(true);
    expect(result.pendingNotes).toBe(0);
    const state = JSON.parse(vault.runtime.get(STATE_PATH) ?? '{}') as { notes: Record<string, unknown> };
    expect(Object.keys(state.notes)).toEqual(['100_领域与职责/学习一.md']);
  });

  it('accumulates changed notes and creates local candidates without truncating the batch', async () => {
    const paths = [
      '100_领域与职责/学习一.md',
      '300_复盘与日志/310_每日笔记/2026-07-24.md',
      '500_永久笔记与知识资产/学习方法.md',
    ];
    const vault = createVault(Object.fromEntries(paths.map((path) => [
      path,
      { content: '# 学习\nPLC 学习需要现场训练。', mtime: 1 },
    ])));
    const service = new ProactiveInsightService(vault.app as never, pluginStub() as never, () => settings());
    await service.prepare(false, new Date(2026, 6, 25, 9));
    for (const [index, path] of paths.entries()) {
      vault.update(path, `# 学习\nPLC 学习需要现场训练和项目验证 ${index}。`, 10 + index);
    }

    const result = await service.prepare(false, new Date(2026, 6, 26, 9));

    expect(result.pendingNotes).toBe(3);
    expect(result.candidates.some((candidate) => candidate.kind === 'repeat-pattern')).toBe(true);
    expect(result.candidates.some((candidate) => candidate.kind === 'cross-domain-link')).toBe(true);
  });

  it('validates model evidence against candidate excerpts', () => {
    const candidate: LocalInsightCandidate = {
      id: 'candidate-1',
      kind: 'evidence-gap',
      topic: '学习',
      reason: '存在强结论。',
      sources: [{
        path: '100_领域与职责/学习.md',
        title: '学习',
        excerpt: '必须先完成一次现场验证，再决定是否继续。',
        contentSignature: computeInsightContentSignature('必须先完成一次现场验证，再决定是否继续。'),
      }],
      sourceSignature: 'source-signature',
    };
    const records = extractInsightJson(JSON.stringify([{
      candidateId: candidate.id,
      kind: candidate.kind,
      title: '强结论需要验证',
      summary: '当前判断缺少验证记录。',
      rationale: candidate.reason,
      evidence: [{ sourcePath: candidate.sources[0].path, quote: '模型虚构的句子' }],
      counterEvidence: '可能存在未链接的现场记录。',
      confidence: 0.7,
      suggestedAction: '补充一次现场验证结果。',
    }]), new Map([[candidate.id, candidate]]), new Date('2026-07-25T00:00:00.000Z'));

    expect(records).toHaveLength(1);
    expect(records[0].evidence[0].quote).toBe(candidate.sources[0].excerpt);
    expect(records[0].evidence[0].contentSignature).toBe(candidate.sources[0].contentSignature);
  });

  it('keeps overflow changes queued instead of dropping notes beyond one batch', async () => {
    const initial = Object.fromEntries(Array.from({ length: 35 }, (_, index) => [
      `200 _ 社会基石与宏观认知/普通记录-${index}.md`,
      { content: `# 普通记录 ${index}\n普通内容 ${index}`, mtime: 1 },
    ]));
    const vault = createVault(initial);
    const service = new ProactiveInsightService(vault.app as never, pluginStub() as never, () => settings());
    await service.prepare(false, new Date(2026, 6, 25, 9));
    for (let index = 0; index < 35; index++) {
      const path = `200 _ 社会基石与宏观认知/普通记录-${index}.md`;
      vault.update(path, `# 普通记录 ${index}\n更新后的普通内容 ${index}`, 10 + index);
    }

    const result = await service.analyze(false, new Date(2026, 6, 26, 9));
    const center = await service.getCenter('pending');

    expect(result.candidates).toHaveLength(0);
    expect(result.processedPaths).toHaveLength(28);
    expect(center.pendingNotes).toBe(7);
  });

  it('keeps unchanged evidence pending and backfills signatures on legacy records', async () => {
    const path = '100_领域与职责/学习一.md';
    const content = '# 学习一\n先做一个最小实践。';
    const mtime = Date.parse('2026-07-24T00:00:00.000Z');
    const vault = createVault({ [path]: { content, mtime } });
    const insight = processableInsight();
    insight.status = 'pending';
    insight.evidence = [{ sourcePath: path, quote: '先做一个最小实践。' }];
    vault.runtime.set(STATE_PATH, JSON.stringify({
      version: 1,
      notes: { [path]: { mtime, size: content.length } },
      pendingPaths: [],
      insights: { [insight.id]: insight },
    }));
    const service = new ProactiveInsightService(vault.app as never, pluginStub() as never, () => settings());

    const center = await service.getCenter('pending');

    expect(center.invalidated).toBe(0);
    expect(center.counts.pending).toBe(1);
    const saved = JSON.parse(vault.runtime.get(STATE_PATH) ?? '{}') as {
      insights: Record<string, InsightRecord>;
    };
    expect(saved.insights[insight.id].evidence[0].contentSignature)
      .toBe(computeInsightContentSignature(content));
  });

  it('moves pending insights to history when signed evidence content changes', async () => {
    const path = '100_领域与职责/学习一.md';
    const original = '# 学习一\n先做一个最小实践。';
    const vault = createVault({ [path]: { content: original, mtime: 1 } });
    const insight = processableInsight();
    insight.status = 'pending';
    insight.evidence = [{
      sourcePath: path,
      quote: '先做一个最小实践。',
      contentSignature: computeInsightContentSignature(original),
    }];
    vault.runtime.set(STATE_PATH, JSON.stringify({
      version: 1,
      notes: { [path]: { mtime: 1, size: original.length } },
      pendingPaths: [],
      insights: { [insight.id]: insight },
    }));
    vault.update(path, '# 学习一\n这个判断已经被否决。', 2);
    const service = new ProactiveInsightService(vault.app as never, pluginStub() as never, () => settings());

    const pending = await service.getCenter('pending');
    const history = await service.getCenter('history');

    expect(pending.invalidated).toBe(1);
    expect(pending.counts.pending).toBe(0);
    expect(history.items[0].status).toBe('invalidated');
    expect(history.items[0].invalidEvidence).toEqual([{
      sourcePath: path,
      reason: 'content-changed',
    }]);
  });

  it('keeps pending evidence when the file changes but the quoted evidence remains', async () => {
    const path = '100_领域与职责/学习一.md';
    const original = '# 学习一\n先做一个最小实践。';
    const updated = `${original}\n\n补充一条无关说明。`;
    const vault = createVault({ [path]: { content: original, mtime: 1 } });
    const insight = processableInsight();
    insight.status = 'pending';
    insight.evidence = [{
      sourcePath: path,
      quote: '先做一个最小实践。',
      contentSignature: computeInsightContentSignature(original),
    }];
    vault.runtime.set(STATE_PATH, JSON.stringify({
      version: 3,
      notes: { [path]: { mtime: 1, size: original.length } },
      pendingPaths: [],
      insights: { [insight.id]: insight },
    }));
    vault.update(path, updated, 2);
    const service = new ProactiveInsightService(vault.app as never, pluginStub() as never, () => settings());

    const pending = await service.getCenter('pending');

    expect(pending.invalidated).toBe(0);
    expect(pending.items).toHaveLength(1);
    const state = JSON.parse(vault.runtime.get(STATE_PATH) ?? '{}') as {
      insights: Record<string, InsightRecord>;
    };
    expect(state.insights[insight.id].evidence[0].contentSignature)
      .toBe(computeInsightContentSignature(updated));
  });

  it('keeps an approved observation active when its original source later disappears', async () => {
    const insight = processableInsight('insight-observing-source-change');
    insight.status = 'observing';
    insight.resolution = 'observation';
    insight.evidence = [{ sourcePath: '已删除.md', quote: '原始依据' }];
    insight.observation = {
      path: '500_永久笔记与知识资产/待验证经验/测试观察.md',
      hypothesis: '这是待验证假设。',
      recordFields: ['场景', '结果'],
      targetEvidenceCount: 3,
      matches: [],
      startedAt: '2026-08-13T00:00:00.000Z',
    };
    const vault = createVault({});
    vault.runtime.set(STATE_PATH, JSON.stringify({
      version: 3,
      notes: {},
      pendingPaths: [],
      insights: { [insight.id]: insight },
    }));
    const service = new ProactiveInsightService(vault.app as never, pluginStub() as never, () => settings());

    const observing = await service.getCenter('observing');

    expect(observing.invalidated).toBe(0);
    expect(observing.items).toHaveLength(1);
    expect(observing.items[0].invalidEvidence).toEqual([{
      sourcePath: '已删除.md',
      reason: 'source-missing-or-moved',
    }]);
  });

  it.each([
    ['deleted', (vault: ReturnType<typeof createVault>, path: string) => vault.remove(path)],
    ['moved', (vault: ReturnType<typeof createVault>, path: string) => vault.move(path, '900_归档/学习一.md', 2)],
  ])('invalidates evidence when its source is %s', async (_label, changeSource) => {
    const path = '100_领域与职责/学习一.md';
    const content = '# 学习一\n先做一个最小实践。';
    const vault = createVault({ [path]: { content, mtime: 1 } });
    const insight = processableInsight();
    insight.status = 'pending';
    insight.evidence = [{
      sourcePath: path,
      quote: '先做一个最小实践。',
      contentSignature: computeInsightContentSignature(content),
    }];
    vault.runtime.set(STATE_PATH, JSON.stringify({
      version: 1,
      notes: { [path]: { mtime: 1, size: content.length } },
      pendingPaths: [],
      insights: { [insight.id]: insight },
    }));
    changeSource(vault, path);
    const service = new ProactiveInsightService(vault.app as never, pluginStub() as never, () => settings());

    const center = await service.getCenter('history');

    expect(center.invalidated).toBe(1);
    expect(center.items[0].invalidEvidence).toEqual([{
      sourcePath: path,
      reason: 'source-missing-or-moved',
    }]);
  });

  it('revalidates pending evidence after a scan finishes', async () => {
    const path = '100_领域与职责/学习一.md';
    const original = '# 学习一\n先做一个最小实践。';
    const vault = createVault({ [path]: { content: original, mtime: 1 } });
    const insight = processableInsight();
    insight.status = 'pending';
    insight.evidence = [{
      sourcePath: path,
      quote: '先做一个最小实践。',
      contentSignature: computeInsightContentSignature(original),
    }];
    vault.runtime.set(STATE_PATH, JSON.stringify({
      version: 1,
      notes: { [path]: { mtime: 1, size: original.length } },
      pendingPaths: [],
      insights: { [insight.id]: insight },
    }));
    vault.update(path, '# 学习一\n普通更新，不再保留原判断。', 2);
    const service = new ProactiveInsightService(vault.app as never, pluginStub() as never, () => settings());

    const result = await service.analyze(false, new Date('2026-07-26T00:00:00.000Z'));

    expect(result.generated).toBe(0);
    expect(result.invalidated).toBe(1);
    const state = JSON.parse(vault.runtime.get(STATE_PATH) ?? '{}') as {
      insights: Record<string, InsightRecord>;
    };
    expect(state.insights[insight.id].status).toBe('invalidated');
  });

  it('creates snapshots for explicit insight conversions and avoids duplicate actions', async () => {
    const vault = createVault({
      [NEXT_ACTIONS]: { content: '# 下一步行动\n\n## 本周\n\n- [ ] 原有任务\n', mtime: 1 },
      '100_领域与职责/学习一.md': { content: '# 学习一\n先做一个最小实践。', mtime: 1 },
    });
    vault.runtime.set(STATE_PATH, JSON.stringify({
      version: 1,
      notes: {},
      pendingPaths: [],
      insights: { 'insight-test': processableInsight() },
    }));
    const service = new ProactiveInsightService(vault.app as never, pluginStub() as never, () => settings());

    const actionPath = await service.convertToAction('insight-test', new Date(2026, 6, 25, 9));
    expect(actionPath).toBe(NEXT_ACTIONS);
    expect(vault.files.get(NEXT_ACTIONS)?.match(/insight:insight-test/gu)).toHaveLength(1);
    expect([...vault.runtime.keys()].some((path) => path.endsWith('insight-action/manifest.json'))).toBe(true);

    const stateAfterAction = JSON.parse(vault.runtime.get(STATE_PATH) ?? '{}') as {
      insights: Record<string, InsightRecord>;
    };
    stateAfterAction.insights['insight-test'].status = 'pending';
    vault.runtime.set(STATE_PATH, JSON.stringify(stateAfterAction));
    const freshService = new ProactiveInsightService(vault.app as never, pluginStub() as never, () => settings());
    await freshService.convertToAction('insight-test', new Date(2026, 6, 25, 10));
    expect(vault.files.get(NEXT_ACTIONS)?.match(/insight:insight-test/gu)).toHaveLength(1);

    const second = processableInsight('insight-permanent');
    const current = JSON.parse(vault.runtime.get(STATE_PATH) ?? '{}') as {
      insights: Record<string, InsightRecord>;
    };
    current.insights[second.id] = second;
    vault.runtime.set(STATE_PATH, JSON.stringify(current));
    const permanentService = new ProactiveInsightService(vault.app as never, pluginStub() as never, () => settings());
    const permanentPath = await permanentService.convertToPermanent(second.id, undefined, new Date(2026, 6, 25, 11));
    expect(permanentPath).toMatch(/^500_永久笔记与知识资产\//u);
    expect(vault.files.get(permanentPath)).toContain('## 例外与失效条件');
    expect([...vault.runtime.keys()].some((path) => path.endsWith('insight-permanent/manifest.json'))).toBe(true);
  });

  it('migrates legacy accepted records back to pending instead of hiding them', async () => {
    const sourcePath = '100_领域与职责/学习一.md';
    const sourceContent = '# 学习一\n先做一个最小实践。';
    const vault = createVault({ [sourcePath]: { content: sourceContent, mtime: 1 } });
    const legacy = processableInsight('insight-legacy');
    legacy.evidence = [{
      sourcePath,
      quote: '先做一个最小实践。',
      contentSignature: computeInsightContentSignature(sourceContent),
    }];
    (legacy as unknown as { status: string }).status = 'accepted';
    vault.runtime.set(STATE_PATH, JSON.stringify({
      version: 1,
      notes: { [sourcePath]: { mtime: 1, size: sourceContent.length } },
      pendingPaths: [],
      insights: { [legacy.id]: legacy },
    }));
    const service = new ProactiveInsightService(vault.app as never, pluginStub() as never, () => settings());

    const center = await service.getCenter('pending');

    expect(center.items).toHaveLength(1);
    expect(center.items[0].status).toBe('pending');
    expect(center.items[0].migratedFromAccepted).toBe(true);
    expect(JSON.parse(vault.runtime.get(STATE_PATH) ?? '{}').version).toBe(3);
  });

  it('repairs a uniquely moved source while migrating a legacy accepted record', async () => {
    const oldPath = '100_领域与职责/旧标题.md';
    const newPath = '100_领域与职责/新标题.md';
    const content = '# 新标题\n仍然保留这条关键证据。';
    const vault = createVault({ [newPath]: { content, mtime: 2 } });
    const legacy = processableInsight('insight-moved-legacy');
    legacy.evidence = [{ sourcePath: oldPath, quote: '仍然保留这条关键证据。' }];
    (legacy as unknown as { status: string }).status = 'accepted';
    vault.runtime.set(STATE_PATH, JSON.stringify({
      version: 1,
      notes: {},
      pendingPaths: [],
      insights: { [legacy.id]: legacy },
    }));
    const service = new ProactiveInsightService(vault.app as never, pluginStub() as never, () => settings());

    const center = await service.getCenter('pending');

    expect(center.items).toHaveLength(1);
    expect(center.items[0].evidence[0].sourcePath).toBe(newPath);
  });

  it('creates a durable observation note and preserves user additions when evidence is refreshed', async () => {
    const sourcePath = '300_复盘与日志/310_每日笔记/2026-08-13.md';
    const sourceContent = '# 日记\n今天和同事发生冲突，我先澄清事实，结果问题得到解决。';
    const vault = createVault({ [sourcePath]: { content: sourceContent, mtime: 1 } });
    const insight = processableInsight('insight-observe');
    insight.evidence = [{ sourcePath, quote: '今天和同事发生冲突' }];
    vault.runtime.set(STATE_PATH, JSON.stringify({
      version: 2,
      notes: { [sourcePath]: { mtime: 1, size: sourceContent.length } },
      pendingPaths: [],
      insights: { [insight.id]: insight },
    }));
    const service = new ProactiveInsightService(vault.app as never, pluginStub() as never, () => settings());

    const observationPath = await service.startObservation(insight.id, {
      title: '人际冲突回应方式',
      hypothesis: '先澄清事实可能比立即反击更有效。',
      recordFields: '场景\n回应\n结果',
      targetEvidenceCount: 1,
    }, new Date('2026-08-13T01:00:00.000Z'));
    const observationFile = vault.tFiles.get(observationPath)!;
    await vault.app.vault.modify(observationFile, `${vault.files.get(observationPath)}\n我的手工补充。\n`);
    const state = JSON.parse(vault.runtime.get(STATE_PATH) ?? '{}') as {
      insights: Record<string, InsightRecord>;
      pendingPaths: string[];
    };
    state.pendingPaths = [sourcePath];
    vault.runtime.set(STATE_PATH, JSON.stringify(state));
    const freshService = new ProactiveInsightService(vault.app as never, pluginStub() as never, () => settings());
    jest.spyOn(freshService as unknown as { askModel: () => Promise<string> }, 'askModel').mockResolvedValue(JSON.stringify([{
      observationId: insight.id,
      sourcePath,
      quote: '今天和同事发生冲突，我先澄清事实，结果问题得到解决。',
      relation: 'supports',
      note: '一次支持性案例。',
    }]));

    const matched = await (freshService as any).evaluateObservations([sourcePath], new Date('2026-08-13T02:00:00.000Z'));

    expect(matched).toBe(1);
    const updated = JSON.parse(vault.runtime.get(STATE_PATH) ?? '{}') as { insights: Record<string, InsightRecord> };
    expect(updated.insights[insight.id].status).toBe('pending');
    expect(updated.insights[insight.id].observation?.readyForReview).toBe(true);
    expect(vault.files.get(observationPath)).toContain('我的手工补充。');
    expect(vault.files.get(observationPath)).toContain('一次支持性案例。');
  });

  it('rejects fabricated observation quotes', () => {
    const insight = processableInsight('insight-observe');
    insight.status = 'observing';
    insight.observation = {
      path: '500_永久笔记与知识资产/待验证经验/测试.md',
      hypothesis: '需要验证。',
      recordFields: ['场景'],
      targetEvidenceCount: 3,
      matches: [],
      startedAt: '2026-08-13T00:00:00.000Z',
    };
    const signal = {
      path: '300_复盘与日志/日志.md',
      title: '日志',
      domain: '300_复盘与日志',
      content: '真实记录。',
      excerpt: '真实记录。',
      terms: [],
      contentSignature: 'signature',
    };
    const matches = extractObservationMatchJson(JSON.stringify([{
      observationId: insight.id,
      sourcePath: signal.path,
      quote: '模型虚构的事件。',
      relation: 'supports',
      note: '不应采纳。',
    }]), new Map([[insight.id, insight]]), new Map([[signal.path, signal]]));

    expect(matches).toEqual([]);
  });

  it('restores an observing item from its durable Markdown note when runtime state is missing', async () => {
    const observationPath = '500_永久笔记与知识资产/待验证经验/人际回应.md';
    const content = [
      '---',
      'type: experience-hypothesis',
      'status: observing',
      'knowledge_stage: hypothesis',
      'insight_id: "insight-durable"',
      '---',
      '',
      '# 人际回应',
      '',
      '<!-- second-brain:observation:start -->',
      '> [!warning] 待验证经验 · 观察中，已记录 0/3',
      '',
      '## 待验证假设',
      '',
      '先澄清事实可能比立即反击更有效。',
      '',
      '## 每次记录',
      '',
      '- [ ] 场景',
      '- [ ] 回应',
      '',
      '## 新增证据（0/3）',
      '',
      '- 尚未发现新的真实事件。',
      '<!-- second-brain:observation:end -->',
    ].join('\n');
    const vault = createVault({ [observationPath]: { content, mtime: 10 } });
    const service = new ProactiveInsightService(vault.app as never, pluginStub() as never, () => settings());

    const center = await service.getCenter('observing');

    expect(center.items).toHaveLength(1);
    expect(center.items[0]).toEqual(expect.objectContaining({
      id: 'insight-durable',
      title: '人际回应',
      status: 'observing',
    }));
    expect(center.items[0].observation?.recordFields).toEqual(['场景', '回应']);
    expect(vault.runtime.has(STATE_PATH)).toBe(true);
  });

  it('repairs v2 observations that were incorrectly invalidated during accepted migration', async () => {
    const sourcePath = '300_复盘与日志/日志.md';
    const observationPath = '500_永久笔记与知识资产/待验证经验/人际回应.md';
    const observationContent = [
      '---',
      'type: experience-hypothesis',
      'status: invalidated',
      'knowledge_stage: hypothesis',
      'insight_id: "insight-v2-observation"',
      '---',
      '',
      '# 人际回应',
      '',
      '<!-- second-brain:observation:start -->',
      '> [!warning] 待验证经验 · 观察中，已记录 0/3',
      '',
      '## 待验证假设',
      '',
      '先核对真实结果再形成长期判断。',
      '',
      '## 每次记录',
      '',
      '- [ ] 场景',
      '- [ ] 结果',
      '',
      '## 新增证据（0/3）',
      '',
      '- 尚未发现新的真实事件。',
      '<!-- second-brain:observation:end -->',
      '',
      '> [!info] 观察结束 · 证据失效',
    ].join('\n');
    const vault = createVault({
      [sourcePath]: { content: '# 日志\n先核对真实结果。', mtime: 1 },
      [observationPath]: { content: observationContent, mtime: 2 },
    });
    const insight = processableInsight('insight-v2-observation');
    insight.status = 'invalidated';
    insight.migratedFromAccepted = true;
    insight.resolution = 'observation';
    insight.evidence = [{ sourcePath, quote: '先核对真实结果。' }];
    insight.observation = {
      path: observationPath,
      hypothesis: '先核对真实结果再形成长期判断。',
      recordFields: ['场景', '结果'],
      targetEvidenceCount: 3,
      matches: [],
      startedAt: '2026-08-13T00:00:00.000Z',
    };
    insight.invalidatedAt = '2026-08-13T00:01:00.000Z';
    insight.invalidEvidence = [{ sourcePath, reason: 'content-changed' }];
    vault.runtime.set(STATE_PATH, JSON.stringify({
      version: 2,
      notes: {},
      pendingPaths: [],
      insights: { [insight.id]: insight },
    }));
    const service = new ProactiveInsightService(vault.app as never, pluginStub() as never, () => settings());

    const center = await service.getCenter('observing');

    expect(center.items).toHaveLength(1);
    expect(center.items[0].status).toBe('observing');
    expect(vault.files.get(observationPath)).toContain('status: observing');
    expect(vault.files.get(observationPath)).not.toContain('观察结束 · 证据失效');
    expect(JSON.parse(vault.runtime.get(STATE_PATH) ?? '{}').version).toBe(3);
  });
});

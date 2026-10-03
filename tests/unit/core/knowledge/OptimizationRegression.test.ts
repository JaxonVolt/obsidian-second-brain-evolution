import type { App, TFile } from 'obsidian';

import { ActionReminderService } from '../../../../src/core/knowledge/ActionReminderService';
import { ActionWorkbenchService } from '../../../../src/core/knowledge/ActionWorkbenchService';
import { runAnalysisJob } from '../../../../src/core/knowledge/AnalysisJobCoordinator';
import { resolveDailyNote } from '../../../../src/core/knowledge/DailyNotePath';
import { InboxCaptureService, parseDailyRawInboxEntries } from '../../../../src/core/knowledge/InboxCaptureService';
import { InboxDigestService, type RoutingProposal } from '../../../../src/core/knowledge/InboxDigestService';
import { LlmWikiService } from '../../../../src/core/knowledge/LlmWikiService';
import { ProactiveInsightService } from '../../../../src/core/knowledge/ProactiveInsightService';
import { commitStagedWrites, stageVaultWrites, writeTextIfUnchanged } from '../../../../src/core/knowledge/VaultMutation';
import { DEFAULT_SETTINGS } from '../../../../src/core/types';
import { WeChatActionExecutor } from '../../../../src/core/wechat/WeChatCollaborationService';

const now = new Date('2026-09-06T12:00:00');

function memoryVault() {
  const files = new Map<string, string>();
  const refs = new Map<string, TFile>();
  const folders = new Set<string>();
  let revision = 1;
  const put = (path: string, content: string) => {
    files.set(path, content);
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index++) folders.add(parts.slice(0, index).join('/'));
    const ref = { path, basename: path.split('/').pop()!.replace(/\.md$/u, ''), extension: 'md',
      stat: { mtime: revision++, size: content.length, ctime: 1 } } as TFile;
    refs.set(path, ref);
    return ref;
  };
  const adapter = {
    exists: async (path: string) => files.has(path) || folders.has(path),
    read: jest.fn(async (path: string) => {
      if (!files.has(path)) throw new Error(`Missing: ${path}`);
      return files.get(path)!;
    }),
    write: jest.fn(async (path: string, content: string) => { put(path, content); }),
    mkdir: async (path: string) => { folders.add(path); },
    remove: async (path: string) => { files.delete(path); refs.delete(path); },
    list: async (path: string) => ({
      files: [...files.keys()].filter((item) => item.slice(0, item.lastIndexOf('/')) === path),
      folders: [...folders].filter((item) => item.slice(0, item.lastIndexOf('/')) === path),
    }),
  };
  const app = { vault: {
    adapter,
    getMarkdownFiles: () => [...refs.values()].filter((file) => file.path.endsWith('.md') && !file.path.startsWith('.')),
    getAbstractFileByPath: (path: string) => refs.get(path) ?? null,
    cachedRead: jest.fn(async (file: TFile) => adapter.read(file.path)),
    read: async (file: TFile) => adapter.read(file.path),
    create: async (path: string, content: string) => {
      if (files.has(path)) throw new Error('Already exists');
      await adapter.write(path, content);
      return refs.get(path)!;
    },
    process: jest.fn(async (file: TFile, transform: (value: string) => string) => {
      const after = transform(files.get(file.path)!);
      await adapter.write(file.path, after);
      return after;
    }),
  } } as unknown as App;
  return { files, refs, put, adapter, app };
}

function proposal(id: string, category: RoutingProposal['category']): RoutingProposal {
  return { id, category, sourcePath: `010_收件箱/原始输入_raw/${id}.md`, title: id,
    content: `Unique content ${id}`, rationale: 'test', confidence: 1, selected: true };
}

describe('second brain optimization regressions', () => {
  it('retains 100 interleaved captures from two instances and deduplicates a retried message', async () => {
    const v = memoryVault();
    const services = [new InboxCaptureService(v.app), new InboxCaptureService(v.app)];
    const paths = await Promise.all(Array.from({ length: 100 }, (_, index) => services[index % 2].capture(
      `INPUT_${index}`, now, { metadata: { wechat_message_id: `message-${index}` } },
    )));
    expect(new Set(paths).size).toBe(100);
    expect(await services[1].capture('INPUT_3', now, { metadata: { wechat_message_id: 'message-3' } })).toBe(paths[3]);
    const path = paths[0].split('#')[0];
    expect(parseDailyRawInboxEntries(path, v.files.get(path)!)).toHaveLength(100);
  });

  it('patches action metadata while preserving unknown fields, custom sections and CRLF', async () => {
    const v = memoryVault();
    const service = new ActionWorkbenchService(v.app);
    const action = await service.createAction({ title: 'Preserve me' }, now);
    const custom = v.files.get(action.path)!.replace('type: action', 'custom: "kept"\ntype: action')
      + '\n## Manual section\nDo not delete\n';
    v.put(action.path, custom.replace(/\n/gu, '\r\n'));
    await service.updateAction(action.id, { priority: 'high' }, now);
    expect(v.files.get(action.path)).toContain('custom: "kept"');
    expect(v.files.get(action.path)).toContain('## Manual section\r\nDo not delete');
    expect(v.files.get(action.path)).not.toMatch(/(?<!\r)\n/u);
    expect(v.files.get(action.path)).toContain('priority: high');
  });

  it('stages updates without calling the live process and rejects changed baselines', async () => {
    const v = memoryVault();
    v.put('notes/a.md', 'before');
    const staged = stageVaultWrites(v.app);
    await writeTextIfUnchanged(staged.app, 'notes/a.md', 'before', 'after');
    expect(v.files.get('notes/a.md')).toBe('before');
    expect(v.app.vault.process).not.toHaveBeenCalled();
    v.put('notes/a.md', 'manual edit');
    await expect(commitStagedWrites(v.app, staged, '.second-brain/snapshots/test')).rejects.toThrow('变化');
    expect(v.files.get('notes/a.md')).toBe('manual edit');
  });

  it('routes daily and action through the configured paths exactly once', async () => {
    const v = memoryVault();
    v.put('.obsidian/daily-notes.json', JSON.stringify({ folder: 'daily', format: 'YYYY-MM/YYYY-MM-DD', template: 'templates/daily' }));
    v.put('templates/daily.md', '# Template\n');
    const service = new InboxDigestService(v.app, {} as never);
    const batch = [proposal('daily-entry', 'daily'), proposal('action-entry', 'next-action')];
    await service.apply(batch, now);
    await service.apply(batch, now);
    expect(v.files.get('daily/2026-09/2026-09-06.md')).toContain('# Template');
    expect(v.files.get('daily/2026-09/2026-09-06.md')!.split('Unique content daily-entry')).toHaveLength(2);
    expect(await new ActionWorkbenchService(v.app).listActions()).toHaveLength(1);
    expect(v.files.has('020_行动系统/下一步行动.md')).toBe(false);
  });

  it('honors the core daily-note defaults and an explicitly empty template', async () => {
    const v = memoryVault();
    v.put('.obsidian/daily-notes.json', '{}');
    v.put('900_模板/00_每日笔记模板.md', 'MUST_NOT_APPLY');
    const resolved = await resolveDailyNote(v.app, now);
    expect(resolved.path).toBe('2026-09-06.md');
    expect(resolved.initial).not.toContain('MUST_NOT_APPLY');
    v.put('.obsidian/daily-notes.json', JSON.stringify({ folder: '../outside' }));
    await expect(resolveDailyNote(v.app, now)).rejects.toThrow('当前笔记库');
  });

  it('rolls back the first routed note when the following action write fails', async () => {
    const v = memoryVault();
    const original = v.adapter.write.getMockImplementation()!;
    v.adapter.write.mockImplementation(async (path, content) => {
      if (path.includes('/行动记录/进行中/')) throw new Error('Injected action write failure');
      return original(path, content);
    });
    const service = new InboxDigestService(v.app, {} as never);
    await expect(service.apply([proposal('daily', 'daily'), proposal('task', 'next-action')], now)).rejects.toThrow('已回滚');
    expect([...v.files.keys()].filter((path) => !path.startsWith('.'))).toEqual([]);
    const journal = [...v.files].find(([path]) => path.endsWith('/transaction.json'));
    expect(JSON.parse(journal![1]).state).toBe('rolled-back');
    expect(v.files.has('.second-brain/runtime/routing-ledger.json')).toBe(false);
  });

  it('validates the full source, including text beyond the model excerpt', async () => {
    const v = memoryVault();
    const sourcePath = '010_收件箱/原始输入_raw/long.md';
    v.put(sourcePath, 'a'.repeat(8100));
    const service = new InboxDigestService(v.app, {} as never);
    jest.spyOn(service as unknown as { askCodex: (prompt: string) => Promise<string> }, 'askCodex')
      .mockResolvedValue(JSON.stringify([{ ...proposal('long', 'retain'), sourcePath }]));
    const proposals = await service.analyze();
    expect(proposals[0].sourceSignature).toMatch(/^[a-f0-9]{64}$/u);
    await expect(service.apply(proposals, now)).resolves.toMatchObject({ retained: [sourcePath] });
    v.put(sourcePath, 'a'.repeat(8100) + 'changed tail');
    await expect(service.apply(proposals, now)).rejects.toThrow('来源在分析后已变化');
    expect(v.files.get(sourcePath)).toContain('changed tail');
  });

  it('preserves a manual edit made between a successful write and a failed write', async () => {
    const v = memoryVault();
    v.put('notes/a.md', 'base A');
    v.put('notes/b.md', 'base B');
    const executor = new WeChatActionExecutor({ app: v.app } as never);
    const plan = await executor.prepare({ title: 'test', summary: 'test', changes: [
      { operation: 'append', path: 'notes/a.md', content: 'bot A' },
      { operation: 'append', path: 'notes/b.md', content: 'bot B' },
    ] }, 'test', now);
    const original = v.adapter.write.getMockImplementation()!;
    v.adapter.write.mockImplementation(async (path, content) => {
      if (path === 'notes/b.md') {
        v.put('notes/a.md', v.files.get('notes/a.md')! + '\nUSER_EDIT');
        throw new Error('Injected failure');
      }
      return original(path, content);
    });
    await expect(executor.apply(plan, now)).rejects.toThrow();
    expect(v.files.get('notes/a.md')).toContain('USER_EDIT');
    expect(v.files.get('notes/b.md')).toBe('base B');
  });

  it('undoes the first same-file step when its second step fails before writing', async () => {
    const v = memoryVault();
    v.put('notes/a.md', 'base');
    const executor = new WeChatActionExecutor({ app: v.app } as never);
    const plan = await executor.prepare({ title: 'test', summary: 'test', changes: [
      { operation: 'append', path: 'notes/a.md', content: 'one' },
      { operation: 'append', path: 'notes/a.md', content: 'two' },
    ] }, 'test', now);
    const original = v.adapter.write.getMockImplementation()!;
    v.adapter.write.mockImplementation(async (path, content) => {
      if (path === 'notes/a.md' && content.includes('two')) throw new Error('Injected second step failure');
      return original(path, content);
    });
    await expect(executor.apply(plan, now)).rejects.toThrow();
    expect(v.files.get('notes/a.md')).toBe('base');
  });

  it('does not reread warm action records and invalidates same-size manual edits', async () => {
    const v = memoryVault();
    const service = new ActionWorkbenchService(v.app);
    const action = await service.createAction({ title: 'One' }, now);
    await service.listActions();
    const reads = (v.app.vault.cachedRead as jest.Mock).mock.calls.length;
    await service.getAction(action.id);
    await service.listActions();
    expect(v.app.vault.cachedRead).toHaveBeenCalledTimes(reads);
    v.files.set(action.path, v.files.get(action.path)!.replace('# One', '# Two'));
    service.invalidate(action.path);
    expect((await service.getAction(action.id))?.title).toBe('Two');
  });

  it('does not redeliver more than 300 active reminder occurrences', async () => {
    const v = memoryVault();
    for (let index = 0; index < 301; index++) v.put(`020_行动系统/行动记录/进行中/${index}.md`,
      `---\ntype: action\nid: A-${index}\nstatus: planned\nreminder: 2026-09-05T08:00:00\n---\n# Task ${index}\n`);
    const service = new ActionReminderService(v.app, new ActionWorkbenchService(v.app), () => undefined);
    expect(await service.check(now)).toBe(301);
    expect(await service.check(now)).toBe(0);
    expect(await service.check(now)).toBe(0);
  });

  it('coalesces duplicate analysis, serializes different jobs and records failures', async () => {
    const v = memoryVault();
    const order: string[] = [];
    const first = jest.fn(async () => { order.push('first'); return 1; });
    expect(await Promise.all([runAnalysisJob(v.app, 'a', first), runAnalysisJob(v.app, 'a', first),
      runAnalysisJob(v.app, 'b', async () => { order.push('second'); return 2; })])).toEqual([1, 1, 2]);
    expect(first).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['first', 'second']);
    await expect(runAnalysisJob(v.app, 'b', async () => { throw new Error('offline'); })).rejects.toThrow('offline');
    expect(JSON.parse(v.files.get('.second-brain/analysis-jobs/b.json')!).state).toBe('failed');
  });

  it('persists one automatic analysis attempt per day, including across service restarts', async () => {
    const v = memoryVault();
    const settings = () => ({ enabled: true, autoAnalyze: true, minChangedNotes: 1, dailyLimit: 1, viewportItems: 3, startupNotice: false });
    const service = new ProactiveInsightService(v.app, {} as never, settings);
    expect(await Promise.all([service.claimAutomaticAttempt(now), service.claimAutomaticAttempt(now)])).toEqual([true, false]);
    const restarted = new ProactiveInsightService(v.app, {} as never, settings);
    expect(await restarted.claimAutomaticAttempt(now)).toBe(false);
    expect(await restarted.claimAutomaticAttempt(new Date('2026-09-07T12:00:00'))).toBe(true);
  });

  it('retrieves dated work logs and allows professional Wiki lookups without personal keywords', async () => {
    const v = memoryVault();
    const path = '100_领域与职责/140_工作日志/2026-09-06.md';
    v.put(path, '# 电气工作日志\n今天学习电气巡检。');
    v.put('100_领域与职责/140_工作日志/2026-08-06.md', '# 电气工作日志\n上个月学习电气巡检。');
    const service = new LlmWikiService(v.app, () => ({ ...DEFAULT_SETTINGS, llmWikiEnabled: true, llmWikiAutoRetrieve: true }), () => null);
    const search = jest.spyOn(service, 'search').mockResolvedValue([]);
    expect(await service.buildContext('你好')).toBe('');
    expect(search).not.toHaveBeenCalled();
    await service.buildContext('解释欧姆定律');
    expect(search).toHaveBeenCalledWith('解释欧姆定律', 6);
    const context = await service.buildContext('我在2026-09-06的电气巡检记录');
    expect(context).toContain(path);
    expect(context).toContain('stage="record"');
    expect(context).not.toContain('2026-08-06.md');
    const reads = (v.app.vault.cachedRead as jest.Mock).mock.calls.length;
    await service.buildContext('我在2026-09-06的电气巡检记录');
    expect(v.app.vault.cachedRead).toHaveBeenCalledTimes(reads);
  });

  it('bounds optional remote waiting and does not accumulate hanging searches', async () => {
    jest.useFakeTimers();
    try {
      const v = memoryVault();
      const service = new LlmWikiService(v.app, () => ({ ...DEFAULT_SETTINGS, llmWikiEnabled: true, llmWikiAutoRetrieve: true }), () => null);
      const search = jest.spyOn(service, 'search').mockImplementation(() => new Promise(() => undefined));
      const first = service.buildContext('我的历史笔记');
      await jest.advanceTimersByTimeAsync(1200);
      expect(await first).toContain('LLM Wiki检索超时');
      expect(await service.buildContext('我的另一条记录')).toContain('LLM Wiki本次检索暂未执行');
      expect(search).toHaveBeenCalledTimes(1);
    } finally { jest.useRealTimers(); }
  });
});

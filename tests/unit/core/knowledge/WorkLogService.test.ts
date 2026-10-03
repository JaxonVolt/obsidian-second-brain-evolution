import {
  DEFAULT_WORK_LOG_TEMPLATE,
  formatWorkLogPath,
  WORK_LOG_INDEX,
  WORK_LOG_TEMPLATE,
  WorkLogService,
} from '@/core/knowledge/WorkLogService';

function createApp(initialFiles: Record<string, string> = {}) {
  const files = new Map(Object.entries(initialFiles));
  const folders = new Set<string>();
  const adapter = {
    exists: jest.fn(async (path: string) => files.has(path) || folders.has(path)),
    mkdir: jest.fn(async (path: string) => { folders.add(path); }),
    read: jest.fn(async (path: string) => files.get(path) ?? ''),
    write: jest.fn(async (path: string, content: string) => { files.set(path, content); }),
  };
  const workspace = { openLinkText: jest.fn(async () => undefined) };
  return { app: { vault: { adapter }, workspace }, files, folders, workspace };
}

describe('WorkLogService', () => {
  it('creates a dated work log from the dedicated template and opens it', async () => {
    const fixture = createApp({ [WORK_LOG_TEMPLATE]: DEFAULT_WORK_LOG_TEMPLATE });
    const service = new WorkLogService(fixture.app as never);

    const result = await service.openOrCreate(new Date(2026, 7, 24, 8, 0, 0));

    expect(result).toEqual({
      path: '100_领域与职责/140_工作日志/2026-08/2026-08-24.md',
      created: true,
    });
    expect(fixture.files.get(result.path)).toContain('# 2026-08-24 工作日志');
    expect(fixture.files.get(result.path)).toContain('参与程度：旁观 / 协助 / 在指导下完成 / 独立完成');
    expect(fixture.files.get(result.path)).toContain('300_复盘与日志/310_每日笔记/2026-08/2026-08-24');
    expect(fixture.files.get(result.path)).not.toContain('{{date:');
    expect(fixture.files.has(WORK_LOG_INDEX)).toBe(true);
    expect(fixture.workspace.openLinkText).toHaveBeenCalledWith(result.path, '', false);
  });

  it('opens an existing work log without overwriting user content', async () => {
    const path = formatWorkLogPath(new Date(2026, 7, 24));
    const fixture = createApp({
      [WORK_LOG_TEMPLATE]: DEFAULT_WORK_LOG_TEMPLATE,
      [WORK_LOG_INDEX]: '# 工作日志\n',
      [path]: '# 用户已经填写的工作日志\n',
    });
    const service = new WorkLogService(fixture.app as never);

    const result = await service.openOrCreate(new Date(2026, 7, 24, 23, 59, 59));

    expect(result.created).toBe(false);
    expect(fixture.files.get(path)).toBe('# 用户已经填写的工作日志\n');
  });

  it('restores the built-in template when the Vault template is missing', async () => {
    const fixture = createApp();
    const service = new WorkLogService(fixture.app as never);

    await service.openOrCreate(new Date(2026, 8, 1));

    expect(fixture.files.get(WORK_LOG_TEMPLATE)).toBe(DEFAULT_WORK_LOG_TEMPLATE);
    expect(fixture.files.get('100_领域与职责/140_工作日志/2026-09/2026-09-01.md'))
      .toContain('## 沉淀与回流');
  });
});

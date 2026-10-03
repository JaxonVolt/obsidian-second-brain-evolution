import {
  InboxCaptureService,
  parseDailyRawInboxEntries,
  sourcePathToWikiTarget,
} from '../../../../src/core/knowledge/InboxCaptureService';

function createApp() {
  const files = new Map<string, string>();
  const folders = new Set<string>();
  const adapter = {
    exists: jest.fn(async (path: string) => files.has(path) || folders.has(path)),
    mkdir: jest.fn(async (path: string) => { folders.add(path); }),
    read: jest.fn(async (path: string) => files.get(path) ?? ''),
    write: jest.fn(async (path: string, content: string) => { files.set(path, content); }),
  };
  return { app: { vault: { adapter } }, files, folders, adapter };
}

describe('InboxCaptureService', () => {
  it('appends mixed input to one daily raw file and returns a block reference', async () => {
    const { app, files } = createApp();
    const service = new InboxCaptureService(app as never);
    const sourcePath = await service.capture(
      '今天调试了变频器\n又想到要复盘沟通。',
      new Date(2026, 6, 15, 8, 9, 10, 12),
    );

    expect(sourcePath).toBe('010_收件箱/原始输入_raw/2026/07/2026-07-15.md#^raw-20260715-080910-012');
    const filePath = sourcePath.split('#')[0];
    const content = files.get(filePath) ?? '';
    expect(content).toContain('今天调试了变频器\n又想到要复盘沟通。');
    expect(content).toContain('type: inbox-capture-day');
    expect(content).toContain('%% second-brain:raw-entry:start');
    expect(content).not.toContain('<!-- second-brain:raw-entry:start');
    expect(content).not.toContain('status: unprocessed');
    expect(parseDailyRawInboxEntries(filePath, content)).toHaveLength(1);
  });

  it('rejects empty input', async () => {
    const service = new InboxCaptureService({ vault: { adapter: {} } } as never);
    await expect(service.capture('   ')).rejects.toThrow('没有可保存的内容');
  });

  it('serializes same-time captures into one file with distinct block ids', async () => {
    const { app, files } = createApp();
    const service = new InboxCaptureService(app as never);
    const now = new Date(2026, 6, 16, 8, 0, 0, 1);
    const [first, second] = await Promise.all([
      service.capture('第一条', now),
      service.capture('第二条', now, {
        source: 'wechat-ilink',
        metadata: { wechat_message_id: '42' },
      }),
    ]);

    expect(first.split('#')[0]).toBe(second.split('#')[0]);
    expect(first).not.toBe(second);
    const filePath = first.split('#')[0];
    const entries = parseDailyRawInboxEntries(filePath, files.get(filePath) ?? '');
    expect(entries.map((entry) => entry.content)).toEqual(['第一条', '第二条']);
    expect(entries[1]).toMatchObject({ source: 'wechat-ilink', metadata: { wechat_message_id: '42' } });
  });

  it('converts legacy and anchored source paths into valid Obsidian wiki targets', () => {
    expect(sourcePathToWikiTarget('010_收件箱/原始输入_raw/legacy.md'))
      .toBe('010_收件箱/原始输入_raw/legacy');
    expect(sourcePathToWikiTarget('010_收件箱/原始输入_raw/2026/08/2026-08-23.md#^raw-1'))
      .toBe('010_收件箱/原始输入_raw/2026/08/2026-08-23#^raw-1');
  });

  it('continues parsing legacy HTML markers during format migration', () => {
    const filePath = '010_收件箱/原始输入_raw/2026/07/2026-07-15.md';
    const content = `<!-- second-brain:raw-entry:start {"id":"raw-1","created":"2026-07-15T08:00:00","source":"wechat-ilink","metadata":{}} -->
## 08:00:00 · 微信

旧格式原文保持可读取。

^raw-1
<!-- second-brain:raw-entry:end -->`;

    expect(parseDailyRawInboxEntries(filePath, content)).toEqual([expect.objectContaining({
      sourcePath: `${filePath}#^raw-1`,
      blockId: 'raw-1',
      content: '旧格式原文保持可读取。',
    })]);
  });
});

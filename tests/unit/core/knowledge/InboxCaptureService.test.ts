import { InboxCaptureService } from '../../../../src/core/knowledge/InboxCaptureService';

describe('InboxCaptureService', () => {
  it('stores mixed input unchanged in the raw inbox', async () => {
    const files = new Map<string, string>();
    const folders = new Set<string>();
    const app = {
      vault: {
        adapter: {
          exists: jest.fn(async (path: string) => files.has(path) || folders.has(path)),
          mkdir: jest.fn(async (path: string) => { folders.add(path); }),
          write: jest.fn(async (path: string, content: string) => { files.set(path, content); }),
        },
      },
    };
    const service = new InboxCaptureService(app as never);

    const path = await service.capture('今天调试了变频器\n又想到要复盘沟通。', new Date(2026, 6, 15, 8, 9, 10, 12));

    expect(path).toBe('010_收件箱/原始输入_raw/20260715-080910-012.md');
    expect(files.get(path)).toContain('今天调试了变频器\n又想到要复盘沟通。');
    expect(files.get(path)).toContain('status: unprocessed');
  });

  it('rejects empty input', async () => {
    const service = new InboxCaptureService({ vault: { adapter: {} } } as never);
    await expect(service.capture('   ')).rejects.toThrow('没有可保存的内容');
  });

  it('records a controlled source and avoids overwriting an existing capture', async () => {
    const files = new Map<string, string>();
    const folders = new Set<string>(['010_收件箱/原始输入_raw']);
    const app = {
      vault: {
        adapter: {
          exists: jest.fn(async (path: string) => files.has(path) || folders.has(path)),
          mkdir: jest.fn(async (path: string) => { folders.add(path); }),
          write: jest.fn(async (path: string, content: string) => { files.set(path, content); }),
        },
      },
    };
    const service = new InboxCaptureService(app as never);
    const now = new Date(2026, 6, 16, 8, 0, 0, 1);
    await service.capture('第一条', now);
    const second = await service.capture('第二条', now, {
      source: 'wechat-ilink',
      metadata: { wechat_message_id: '42' },
    });

    expect(second.endsWith('-2.md')).toBe(true);
    expect(files.get(second)).toContain('source: "wechat-ilink"');
    expect(files.get(second)).toContain('wechat_message_id: "42"');
  });
});

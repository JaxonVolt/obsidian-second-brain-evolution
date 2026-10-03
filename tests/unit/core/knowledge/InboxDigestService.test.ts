import {
  extractRoutingJson,
  hasMeaningfulSourceContent,
  InboxDigestService,
  isEquivalentRoutedNote,
} from '../../../../src/core/knowledge/InboxDigestService';

describe('extractRoutingJson', () => {
  const sources = new Set(['010_收件箱/原始输入_raw/a.md']);

  it('parses fenced JSON and preserves multiple suggestions for one source', () => {
    const result = extractRoutingJson(`\n\`\`\`json\n[
      {"sourcePath":"010_收件箱/原始输入_raw/a.md","category":"next-action","title":"练习变频器","content":"完成一次参数设置实操","rationale":"可直接执行","confidence":0.9},
      {"sourcePath":"010_收件箱/原始输入_raw/a.md","category":"reflection","title":"沟通复盘","content":"记录提问前准备是否充分","rationale":"属于心智复盘","confidence":0.7}
    ]\n\`\`\``, sources);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ category: 'next-action', selected: true, confidence: 0.9 });
    expect(result[1]).toMatchObject({ category: 'reflection', selected: true });
  });

  it('drops unknown sources and defaults invalid categories to inbox', () => {
    const result = extractRoutingJson(JSON.stringify([
      { sourcePath: 'unknown.md', category: 'project', title: '未知', content: '忽略' },
      { sourcePath: '010_收件箱/原始输入_raw/a.md', category: 'personality', title: '待判断', content: '不要固化单次状态', confidence: 4 },
    ]), sources);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ category: 'inbox', selected: false, confidence: 1 });
  });
});

describe('isEquivalentRoutedNote', () => {
  const note = `---
type: permanent
status: active
created: 2026-08-12T23:45:20
source_note: "[[010_收件箱/原始输入_raw/20260719-191515-912]]"
---

# 平等相处

交往不放低自己的姿态，平等相处。

## 分流依据

是可复用的人际边界判断候选。
`;

  it('recognizes the same routed source, title and content', () => {
    expect(isEquivalentRoutedNote(
      note,
      '平等相处',
      '010_收件箱/原始输入_raw/20260719-191515-912',
      '交往不放低自己的姿态，平等相处。',
    )).toBe(true);
  });

  it('does not merge changed content or another source', () => {
    expect(isEquivalentRoutedNote(
      note,
      '平等相处',
      '010_收件箱/原始输入_raw/another',
      '交往不放低自己的姿态，平等相处。',
    )).toBe(false);
    expect(isEquivalentRoutedNote(
      note,
      '平等相处',
      '010_收件箱/原始输入_raw/20260719-191515-912',
      '交往中保持平等，同时尊重情境。',
    )).toBe(false);
  });
});

describe('source routing policy', () => {
  it('rejects attachment-only shells and accepts a meaningful source summary', () => {
    expect(hasMeaningfulSourceContent('微信附件：[[010_收件箱/微信附件/2026/08/a.jpg]]')).toBe(false);
    expect(hasMeaningfulSourceContent('https://example.com/file.pdf')).toBe(false);
    expect(hasMeaningfulSourceContent('这是一份变频器参数设置手册，保留用于核对故障代码和恢复步骤。')).toBe(true);
  });
});

describe('InboxDigestService duplicate routing', () => {
  it('reuses the same permanent note on repeated apply instead of creating a numbered copy', async () => {
    const files = new Map<string, string>();
    const folders = new Set<string>();
    const adapter = {
      exists: async (path: string) => files.has(path) || folders.has(path),
      mkdir: async (path: string) => { folders.add(path); },
      read: async (path: string) => {
        const value = files.get(path);
        if (value === undefined) throw new Error(`Missing file: ${path}`);
        return value;
      },
      write: async (path: string, content: string) => { files.set(path, content); },
      list: async (folder: string) => ({
        files: [...files.keys()].filter((path) => path.startsWith(`${folder}/`)
          && !path.slice(folder.length + 1).includes('/')),
        folders: [],
      }),
    };
    const app = { vault: { adapter } };
    const service = new InboxDigestService(app as never, {} as never);
    const proposal = {
      id: '1-source',
      sourcePath: '010_收件箱/原始输入_raw/source.md',
      category: 'permanent' as const,
      title: '平等相处',
      content: '交往不放低自己的姿态，平等相处。',
      rationale: '可复用原则候选',
      confidence: 0.9,
      selected: true,
    };

    const first = await service.apply([proposal], new Date('2026-08-13T10:00:00'));
    const second = await service.apply([proposal], new Date('2026-08-13T10:01:00'));

    expect(first.created).toHaveLength(1);
    expect(first.reused).toHaveLength(0);
    expect(second.created).toHaveLength(0);
    expect(second.reused).toEqual(first.created);
    expect([...files.keys()].some((path) => path.endsWith('/平等相处 2.md'))).toBe(false);
  });

  it('marks an anchored daily entry processed without creating a shell note', async () => {
    const files = new Map<string, string>();
    const folders = new Set<string>();
    const adapter = {
      exists: async (path: string) => files.has(path) || folders.has(path),
      mkdir: async (path: string) => { folders.add(path); },
      read: async (path: string) => files.get(path) ?? '',
      write: async (path: string, content: string) => { files.set(path, content); },
      list: async () => ({ files: [], folders: [] }),
    };
    const service = new InboxDigestService({ vault: { adapter } } as never, {} as never);
    const sourcePath = '010_收件箱/原始输入_raw/2026/08/2026-08-23.md#^raw-1';

    const result = await service.apply([{
      id: 'retain-1',
      sourcePath,
      category: 'retain',
      title: '仅保留图片原始记录',
      content: '[[010_收件箱/微信附件/2026/08/a.jpg]]',
      rationale: '没有足够上下文生成资料卡片',
      confidence: 0.9,
      selected: true,
    }], new Date('2026-08-23T10:00:00'));

    expect(result.retained).toEqual([sourcePath]);
    expect(result.created).toHaveLength(0);
    expect(result.processedSources).toEqual([sourcePath]);
    const ledger = JSON.parse(files.get('.second-brain/runtime/routing-ledger.json') ?? '{}');
    expect(ledger.processedSources[sourcePath].outputs).toEqual([sourcePath]);
  });
});

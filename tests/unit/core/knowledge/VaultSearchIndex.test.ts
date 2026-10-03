import type { App, TFile } from 'obsidian';

import { buildRetrievalContext, RETRIEVAL_CONTEXT_LIMIT } from '@/core/knowledge/RetrievalContext';
import { relevantExcerpt, retrievalTokens, VaultSearchIndex } from '@/core/knowledge/VaultSearchIndex';

function fixture(paths: string[]) {
  const bodies = new Map(paths.map((path) => [path, '# Note\nUnrelated content']));
  const files = paths.map((path) => ({ path, basename: path.split('/').pop()!.replace(/\.[^.]+$/u, ''),
    extension: path.split('.').pop(), stat: { mtime: 1, size: 100 } } as TFile));
  const cache = new Map<string, unknown>();
  const read = jest.fn(async (file: TFile) => bodies.get(file.path)!);
  const app = { vault: { getMarkdownFiles: () => files.filter((file) => file.extension === 'md'), getFiles: () => files,
    cachedRead: read }, metadataCache: { getFileCache: (file: TFile) => cache.get(file.path) } } as unknown as App;
  return { bodies, files, cache, read, app, index: new VaultSearchIndex(app) };
}

describe('metadata-first Vault retrieval', () => {
  it('finds a technical folder outside old fixed roots and reads only shortlisted bodies', async () => {
    const folder = '100_领域与职责/示例电站主接线图与详解';
    const note = `${folder}/07_35kV母线与光伏集电线路.md`;
    const image = `${folder}/电站主接线图.jpg`;
    const f = fixture([...Array.from({ length: 1000 }, (_, i) => `notes/无关内容${i}.md`), note, image]);
    f.bodies.set(note, '# 35kV母线\n光伏发电馈线汇集逆变器。数量需核对原图。');
    const result = await f.index.search('查一下主接线图中的发电馈线每个都连接了几个逆变器', () => true, true);
    expect(result.hits[0].file.path).toBe(note);
    expect(result.assets.map((file) => file.path)).toContain(image);
    expect(result.fileReads).toBeLessThanOrEqual(16);
    expect(f.read).not.toHaveBeenCalledWith(expect.objectContaining({ path: 'notes/无关内容0.md' }));
  });

  it('uses aliases and headings, retains numeric identifiers, and invalidates edited and deleted evidence', async () => {
    const f = fixture(['notes/设备记录.md', 'notes/普通笔记.md']);
    const file = f.files[0];
    f.cache.set(file.path, { frontmatter: { aliases: ['311馈线'] }, headings: [{ heading: '逆变器数量' }] });
    f.bodies.set(file.path, '# 311馈线\n逆变器数量待核对');
    expect(retrievalTokens('311接了几台')).toContain('311');
    expect((await f.index.search('311逆变器', () => true)).hits[0].file.path).toBe(file.path);
    expect((await f.index.search('311逆变器', () => true)).fileReads).toBe(0);
    f.bodies.set(file.path, '# 311馈线\n新资料为已核对');
    file.stat.mtime++;
    f.index.invalidate(file.path);
    const changed = await f.index.search('311逆变器', () => true);
    expect(changed.fileReads).toBe(1);
    expect(changed.hits[0].content).toContain('新资料');
    f.files.splice(0, 1);
    expect((await f.index.search('311逆变器', () => true)).hits.map((hit) => hit.file.path)).not.toContain(file.path);
  });

  it('shares concurrent reads and recovers from a failed read', async () => {
    const f = fixture(['notes/311馈线.md']);
    const file = f.files[0];
    await Promise.all([f.index.read(file), f.index.read(file)]);
    expect(f.read).toHaveBeenCalledTimes(1);
    f.index.invalidate(file.path);
    f.read.mockRejectedValueOnce(new Error('offline'));
    expect((await f.index.search('311馈线', () => true)).skippedFiles).toBe(1);
    expect((await f.index.search('311馈线', () => true)).hits).toHaveLength(1);
  });

  it('skips oversized bodies and supplies available asset paths without claiming their content was read', async () => {
    const f = fixture(['notes/主接线图.md', 'notes/主接线图.pdf']);
    f.files[0].stat.size = 2_000_000;
    const result = await f.index.search('主接线图', () => true, true);
    expect(result.skippedFiles).toBe(1);
    expect(f.read).not.toHaveBeenCalled();
    expect(result.assets).toHaveLength(1);
  });

  it('selects a relevant body passage with an exact source line rather than the beginning of the file', () => {
    const lines = ['---', 'tags: [光伏]', '---', '# 主接线图', ...Array.from({ length: 150 }, () => '其他资料'),
      '## 馈线', '311馈线的逆变器编号需要逐项核对。', '原文结束'];
    const excerpt = relevantExcerpt(lines.join('\n'), retrievalTokens('311馈线逆变器'), 300);
    expect(excerpt.text).toContain('311馈线');
    expect(excerpt.line).toBeGreaterThan(140);
    expect(lines.slice(excerpt.line - 1).join('\n').startsWith(excerpt.text)).toBe(true);
  });

  it('deduplicates both paths and repeated text and bounds total context after XML escaping', () => {
    const context = buildRetrievalContext([
      { kind: 'vault-memory', path: 'notes/a.md', text: '相同证据' },
      { kind: 'memory', path: 'notes\\a.md', text: '重复路径' },
      { kind: 'memory', path: 'wiki/b.md', text: '相同证据' },
      { kind: 'asset', path: 'diagram.jpg', text: '图件路径候选' },
      { kind: 'asset', path: 'diagram.pdf', text: '图件路径候选' },
      ...Array.from({ length: 30 }, (_, i) => ({ kind: 'memory' as const, path: `wiki/${i}.md`, text: `${i}${'<>&'.repeat(3000)}` })),
    ], '候选检索不是完整清单。');
    expect(context.length).toBeLessThanOrEqual(RETRIEVAL_CONTEXT_LIMIT);
    expect(context.match(/相同证据/gu)).toHaveLength(1);
    expect(context).not.toContain('重复路径');
    expect(context).not.toContain('wiki/b.md');
    expect(context).toContain('候选检索不是完整清单');
    expect(context).toContain('diagram.jpg');
    expect(context).toContain('diagram.pdf');
  });
});

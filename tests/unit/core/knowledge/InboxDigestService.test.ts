import { extractRoutingJson } from '../../../../src/core/knowledge/InboxDigestService';

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

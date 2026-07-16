import {
  formatDigestDraftMessages,
  isDigestDraftExpired,
  parseRoutingCategory,
  parseWechatDigestCommand,
} from '../../../../src/core/wechat/WeChatDigestCommands';

describe('WeChatDigestCommands', () => {
  it('recognizes only explicit digest and confirmation commands', () => {
    expect(parseWechatDigestCommand('消化这批')).toEqual({ kind: 'analyze', force: false });
    expect(parseWechatDigestCommand('重新消化')).toEqual({ kind: 'analyze', force: true });
    expect(parseWechatDigestCommand('确认归位 FL-20260716-1120')).toEqual({
      kind: 'confirm',
      batchId: 'FL-20260716-1120',
    });
    expect(parseWechatDigestCommand('我想消化一下这篇文章')).toBeNull();
  });

  it('parses deterministic edits and Chinese category aliases', () => {
    expect(parseWechatDigestCommand('修改 2 分类 永久笔记')).toEqual({
      kind: 'edit',
      index: 2,
      field: 'category',
      value: '永久笔记',
    });
    expect(parseWechatDigestCommand('暂不归位 3')).toEqual({ kind: 'select', index: 3, selected: false });
    expect(parseRoutingCategory('来源资料')).toBe('source');
    expect(parseRoutingCategory('未知类别')).toBeNull();
  });

  it('formats every proposal into reviewable messages and expires drafts after 24 hours', () => {
    const draft = {
      id: 'FL-20260716-1120',
      createdAt: '2026-07-16T03:20:00.000Z',
      proposals: Array.from({ length: 3 }, (_, index) => ({
        id: String(index),
        sourcePath: `raw/${index}.md`,
        category: 'source' as const,
        title: `资料 ${index + 1}`,
        content: '需要保留的事实内容',
        rationale: '外部材料',
        confidence: 0.8,
        selected: true,
      })),
    };

    const messages = formatDigestDraftMessages(draft, 220);
    expect(messages.join('\n')).toContain('1. [归位][来源资料] 资料 1');
    expect(messages.join('\n')).toContain('3. [归位][来源资料] 资料 3');
    expect(messages.join('\n')).toContain('确认归位');
    expect(isDigestDraftExpired(draft, Date.parse('2026-07-17T02:00:00.000Z'))).toBe(false);
    expect(isDigestDraftExpired(draft, Date.parse('2026-07-17T04:00:01.000Z'))).toBe(true);
  });
});

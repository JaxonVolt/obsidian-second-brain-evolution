import type { ChatMessage } from '@/core/types';
import { buildBoundedHistory, cleanHistoryMessage, historySourcePath, RECOVERY_CONTEXT_LIMIT } from '@/utils/boundedHistory';

describe('bounded conversation recovery', () => {
  it('keeps recent decisions and source IDs while removing old injected evidence', () => {
    const messages: ChatMessage[] = Array.from({ length: 100 }, (_, i) => ({ id: `msg-${i}`,
      role: i % 2 ? 'assistant' : 'user', timestamp: i, content: `消息${i} ${'正文'.repeat(3000)}` }));
    messages[0].content = '主目标：整理主接线图；未经确认不要修改原图。';
    messages[98].content = '最新约束：只读核对311馈线，不要推算数量。\n<source_assets>OLD_ASSET</source_assets>';
    const before = JSON.stringify(messages);
    const text = buildBoundedHistory(messages, '311馈线', historySourcePath('conv-123')!);
    expect(text.length).toBeLessThanOrEqual(RECOVERY_CONTEXT_LIMIT);
    expect(text).toContain('主目标');
    expect(text).toContain('最新约束');
    expect(text).toContain('msg-98');
    expect(text).toContain('.second-brain/runtime/sessions/conv-123.jsonl');
    expect(text).not.toContain('OLD_ASSET');
    expect(text).toContain('不是完整对话');
    expect(JSON.stringify(messages)).toBe(before);
  });

  it('uses exact display text and preserves user instructions without auto summaries', () => {
    const message: ChatMessage = { id: 'u1', role: 'user', timestamp: 1,
      displayContent: '我原先说错了，请按最新图纸。', content: '我原先说错了\n<long_term_memory>过期数值</long_term_memory>' };
    expect(cleanHistoryMessage(message)).toBe(message.displayContent);
    expect(historySourcePath('../secrets')).toBeUndefined();
    expect(historySourcePath(null)).toBeUndefined();
  });
});

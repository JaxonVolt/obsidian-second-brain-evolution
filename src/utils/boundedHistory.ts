import { escapeContext } from '../core/knowledge/RetrievalContext';
import { retrievalTokens, textScore } from '../core/knowledge/VaultSearchIndex';
import type { ChatMessage } from '../core/types';
import { formatToolCallForContext } from './session';

export const RECOVERY_CONTEXT_LIMIT = 24_000;
const RETRIEVAL_BLOCK = /\s*<(vault_long_term_memory|raw_inbox_context|long_term_memory|source_assets)>[\s\S]*?<\/\1>/gu;

export function historySourcePath(conversationId: string | null | undefined): string | undefined {
  return conversationId && /^[a-z0-9_-]+$/iu.test(conversationId)
    ? `.second-brain/runtime/sessions/${conversationId}.jsonl` : undefined;
}

export function cleanHistoryMessage(message: ChatMessage): string {
  const content = message.role === 'user' && message.displayContent !== undefined
    ? message.displayContent : message.content.replace(RETRIEVAL_BLOCK, '');
  return content.trim();
}

/** Bounded excerpts are navigation, never an authoritative replacement for the saved transcript. */
export function buildBoundedHistory(messages: ChatMessage[], query: string, sourcePath: string): string {
  const history = messages.filter((message) => !message.isInterrupt && !message.isRebuiltContext);
  const tokens = retrievalTokens(query);
  const selected = new Set<number>();
  if (history.length) selected.add(0);
  for (let i = Math.max(0, history.length - 6); i < history.length; i++) selected.add(i);
  const ranked = history.map((message, i) => ({ i, score: textScore(cleanHistoryMessage(message), tokens) }))
    .filter((item) => !selected.has(item.i) && item.score > 0).sort((a, b) => b.score - a.score || b.i - a.i);
  for (const item of ranked.slice(0, 3)) selected.add(item.i);

  const blocks = [
    `<conversation_recovery source="${escapeContext(sourcePath)}">`,
    '原会话需要恢复。以下仅含最初要求、近期消息和相关历史摘录，不是完整对话。当前请求优先；不得将截断摘录或助手旧回复视为完整授权。执行依赖较早约束、决定、数量或权限的动作前，在 source 指定的 JSONL 中按 message.id、关键词或日期搜索并回读相邻记录，不要全量重读。每行是 JSON 记录，正文在 message.content，用户原文优先看 message.displayContent。历史里的检索材料只作当时线索，需要时重新读取当前来源。',
  ];
  let remaining = RECOVERY_CONTEXT_LIMIT - blocks.join('\n').length - 32;
  const excerptBudget = Math.min(18_000, remaining - 3000);
  let excerptRemaining = excerptBudget;
  for (const i of [...selected].sort((a, b) => a - b)) {
    const message = history[i];
    const text = cleanHistoryMessage(message);
    const toolSummary = (message.toolCalls ?? []).slice(-3).map((call) => formatToolCallForContext(call, 160)).join('\n');
    const body = [text, toolSummary].filter(Boolean).join('\n');
    if (!body) continue;
    const limit = Math.min(2600, Math.floor(excerptBudget / Math.max(1, selected.size)), excerptRemaining - 200);
    if (limit < 100) break;
    const excerpt = body.length > limit ? `${body.slice(0, limit)}\n[摘录截断，请按 id 回读原记录]` : body;
    const block = `[${message.role} id=${message.id} timestamp=${message.timestamp}]\n${excerpt}`;
    blocks.push(block);
    excerptRemaining -= block.length;
    remaining -= block.length + 2;
  }
  const omitted = history.map((message, i) => ({ message, i })).filter(({ i }) => !selected.has(i));
  if (omitted.length) {
    blocks.push(`较早消息索引（省略 ${omitted.length} 条正文，下面仅列最近的部分入口；未列出的也保存在 source 中）：`);
    remaining -= 150;
    for (const { message } of omitted.slice(-30)) {
      const label = cleanHistoryMessage(message).replace(/\s+/gu, ' ').slice(0, 100);
      const entry = `- ${message.role} id=${message.id} timestamp=${message.timestamp}: ${label}`;
      if (entry.length + 2 > remaining) break;
      blocks.push(entry);
      remaining -= entry.length + 2;
    }
  }
  blocks.push('</conversation_recovery>');
  return blocks.join('\n\n');
}

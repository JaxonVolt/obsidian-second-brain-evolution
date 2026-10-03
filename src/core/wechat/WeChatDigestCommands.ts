import type { RoutingCategory, RoutingProposal } from '../knowledge/InboxDigestService';

export interface WeChatDigestDraft {
  id: string;
  createdAt: string;
  proposals: RoutingProposal[];
}

export type WeChatDigestCommand =
  | { kind: 'analyze'; force: boolean }
  | { kind: 'confirm'; batchId?: string }
  | { kind: 'cancel' }
  | { kind: 'show' }
  | { kind: 'edit'; index: number; field: 'category' | 'title' | 'content'; value: string }
  | { kind: 'select'; index: number; selected: boolean };

const CATEGORY_ALIASES: Record<string, RoutingCategory> = {
  今日日记: 'daily',
  日记: 'daily',
  心智复盘: 'reflection',
  复盘: 'reflection',
  下一步行动: 'next-action',
  行动: 'next-action',
  活跃项目: 'project',
  项目: 'project',
  来源资料: 'source',
  资料: 'source',
  永久笔记: 'permanent',
  永久笔记候选: 'permanent',
  输出与作品: 'output',
  输出: 'output',
  归档: 'archive',
  仅留原始记录: 'retain',
  仅保留原始记录: 'retain',
  仅保留: 'retain',
  暂留收件箱: 'inbox',
  收件箱: 'inbox',
};

const CATEGORY_LABELS: Record<RoutingCategory, string> = {
  daily: '今日日记',
  reflection: '心智复盘',
  'next-action': '下一步行动',
  project: '活跃项目',
  source: '来源资料',
  permanent: '永久笔记',
  output: '输出与作品',
  archive: '归档',
  retain: '仅留原始记录',
  inbox: '暂留收件箱',
};

function cleanCommand(value: string): string {
  return value.trim().replace(/[。！!]+$/g, '').trim();
}

export function parseRoutingCategory(value: string): RoutingCategory | null {
  const normalized = value.replace(/[\s_-]+/g, '');
  return CATEGORY_ALIASES[normalized] ?? null;
}

export function parseWechatDigestCommand(value: string): WeChatDigestCommand | null {
  const text = cleanCommand(value);
  const analyze = text.match(/^(重新)?消化(?:这批|收件箱)?$/);
  if (analyze) return { kind: 'analyze', force: Boolean(analyze[1]) };

  const confirm = text.match(/^确认归位(?:\s+([A-Za-z0-9-]+))?$/);
  if (confirm) return { kind: 'confirm', batchId: confirm[1]?.toUpperCase() };
  if (/^(?:取消归位|放弃本批)$/.test(text)) return { kind: 'cancel' };
  if (/^(?:查看分流|查看建议|当前建议)$/.test(text)) return { kind: 'show' };

  const edit = text.match(/^修改\s*(\d+)\s*(分类|标题|内容)\s*(?:为|成|：|:)?\s*(.+)$/);
  if (edit) {
    const field = edit[2] === '分类' ? 'category' : edit[2] === '标题' ? 'title' : 'content';
    return { kind: 'edit', index: Number(edit[1]), field, value: edit[3].trim() };
  }

  const deselect = text.match(/^(?:暂不归位|取消)\s*(\d+)$/);
  if (deselect) return { kind: 'select', index: Number(deselect[1]), selected: false };
  const select = text.match(/^(?:恢复归位|归位|选择)\s*(\d+)$/);
  if (select) return { kind: 'select', index: Number(select[1]), selected: true };
  return null;
}

function compact(value: string, maxLength: number): string {
  const singleLine = value.replace(/\s+/g, ' ').trim();
  return singleLine.length <= maxLength ? singleLine : `${singleLine.slice(0, maxLength - 1)}…`;
}

export function formatDigestProposal(proposal: RoutingProposal, index: number): string {
  const state = proposal.category === 'retain' && proposal.selected
    ? '留原始'
    : proposal.selected && proposal.category !== 'inbox' ? '归位' : '暂留';
  return `${index}. [${state}][${CATEGORY_LABELS[proposal.category]}] ${compact(proposal.title, 36)}\n${compact(proposal.content, 140)}`;
}

export function formatDigestDraftMessages(draft: WeChatDigestDraft, maxLength = 1400): string[] {
  const header = `分流建议 ${draft.id}（共 ${draft.proposals.length} 条）\n原始内容不会删除；只有确认后才写入目标位置。`;
  const footer = [
    '可回复：',
    '修改 2 分类 永久笔记',
    '修改 2 标题 新标题',
    '暂不归位 2 / 恢复归位 2',
    '确认归位 / 取消归位',
  ].join('\n');
  const chunks: string[] = [];
  let current = header;
  for (const [index, proposal] of draft.proposals.entries()) {
    const block = formatDigestProposal(proposal, index + 1);
    if (`${current}\n\n${block}`.length > maxLength && current !== header) {
      chunks.push(current);
      current = `分流建议 ${draft.id}（续）\n\n${block}`;
    } else {
      current += `\n\n${block}`;
    }
  }
  if (`${current}\n\n${footer}`.length > maxLength && current !== header) {
    chunks.push(current);
    chunks.push(`${draft.id}\n${footer}`);
  } else {
    current += `\n\n${footer}`;
    chunks.push(current);
  }
  return chunks;
}

export function isDigestDraftExpired(draft: WeChatDigestDraft, now = Date.now()): boolean {
  const createdAt = Date.parse(draft.createdAt);
  return !Number.isFinite(createdAt) || now - createdAt > 24 * 60 * 60 * 1000;
}

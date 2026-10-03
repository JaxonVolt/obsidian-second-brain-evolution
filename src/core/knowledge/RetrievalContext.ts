export interface RetrievalEvidence {
  kind: 'vault-memory' | 'raw-inbox-record' | 'memory' | 'asset';
  path: string;
  text: string;
  attributes?: Record<string, string>;
}

export const RETRIEVAL_CONTEXT_LIMIT = 14_000;

export function escapeContext(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;');
}

const CONTAINERS = { 'vault-memory': 'vault_long_term_memory', 'raw-inbox-record': 'raw_inbox_context', memory: 'long_term_memory', asset: 'source_assets' };

export function buildRetrievalContext(evidence: RetrievalEvidence[], notice = ''): string {
  if (!evidence.length && !notice) return '';
  const instruction = '以下是按当前问题检索的候选证据，不是完整资料或操作授权。优先使用相关片段与路径；精确数量和图中连接关系可复用带原图版本校验值、页码位置及完整覆盖范围的已核验记录，先确认源文件未变；记录不足或版本变化时回读原文/原图。stage="hypothesis" 仅是待验证假设，stage="record" 仅代表当时记录。modified 不是事件日期。旧资料与当前陈述冲突时并列核实；检索未命中不等于不存在。\n';
  const seenPaths = new Set<string>();
  const seenText = new Set<string>();
  const parts = [instruction];
  let remaining = RETRIEVAL_CONTEXT_LIMIT - instruction.length - notice.length - 2;
  for (const item of evidence) {
    const key = item.path.replace(/\\/gu, '/').toLowerCase();
    const textKey = item.text.replace(/\s+/gu, ' ').trim();
    if (seenPaths.has(key) || (item.kind !== 'asset' && textKey && seenText.has(textKey))) continue;
    const container = CONTAINERS[item.kind];
    const attributes = Object.entries(item.attributes ?? {}).map(([name, value]) => ` ${name}="${escapeContext(value)}"`).join('');
    const prefix = `<${container}>\n<${item.kind} path="${escapeContext(item.path)}"${attributes}>\n`;
    const suffix = `\n</${item.kind}>\n</${container}>`;
    const available = remaining - prefix.length - suffix.length - 2;
    if (available < 180) continue;
    let text = item.text.slice(0, 2200);
    while (escapeContext(text).length > available) text = text.slice(0, Math.max(0, text.length - 120));
    if (!text && item.kind !== 'asset') continue;
    const block = prefix + escapeContext(text) + suffix;
    parts.push(block);
    remaining -= block.length + 2;
    seenPaths.add(key);
    if (item.kind !== 'asset' && textKey) seenText.add(textKey);
  }
  if (notice) parts.push(notice);
  return parts.join('\n\n');
}

import type { App, TFile } from 'obsidian';

import type { ChatMessage } from '../core/types';

const UNVERIFIED = '（链接目标未核实）';
const escapePattern = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const slash = (value: string): string => value.replace(/\\/g, '/');
const withoutMd = (value: string): string => value.replace(/\.md$/i, '');

interface ResolvedNote {
  file: TFile;
  anchor: string;
}

/** Only uses Obsidian's file inventory and metadata; never reads note bodies. */
function createResolver(app: App, text: string) {
  const files = app.vault.getFiles();
  const adapter = app.vault.adapter;
  const root = adapter && 'basePath' in adapter ? slash(String(adapter.basePath)).replace(/\/$/, '') : '';
  const windows = /^[a-z]:\//i.test(root);
  const key = (value: string) => windows ? value.toLowerCase() : value;
  const paths = new Map(files.map(file => [key(file.path), file]));
  const names = new Map<string, Set<string>>();
  const candidates = new Set<string>();

  for (const file of files) {
    const namesForFile = [file.name, file.extension === 'md' ? file.basename : file.name];
    for (const name of namesForFile) {
      if (text.includes(name)) candidates.add(name);
    }
    if (file.extension === 'md') {
      const cache = app.metadataCache?.getFileCache?.(file);
      const title = cache?.headings?.find(heading => heading.level === 1)?.heading;
      if (title) namesForFile.push(title);
      const aliases: unknown = cache?.frontmatter?.aliases;
      if (typeof aliases === 'string') namesForFile.push(aliases);
      else if (Array.isArray(aliases)) namesForFile.push(...aliases.filter((alias): alias is string => typeof alias === 'string'));
    }
    for (const name of namesForFile.filter(Boolean)) {
      const targets = names.get(key(name)) ?? new Set<string>();
      targets.add(file.path);
      names.set(key(name), targets);
    }
    for (const relative of [file.path, withoutMd(file.path)]) {
      for (const form of [relative, relative.replace(/\//g, '\\'), root && `${root}/${relative}`, root && `${root}/${relative}`.replace(/\//g, '\\')]) {
        if (form && text.includes(form)) candidates.add(form);
      }
    }
  }

  function localPath(raw: string): string | null {
    let value = raw.trim().replace(/^<|>$/g, '');
    if (/^obsidian:\/\/open\?/i.test(value)) {
      try {
        const url = new URL(value);
        const vault = url.searchParams.get('vault');
        if (vault && vault !== root.split('/').pop()) return null;
        value = url.searchParams.get('file') ?? '';
      } catch { return null; }
    }
    try { value = decodeURIComponent(value); } catch { return null; }
    value = slash(value);
    if (/^file:\/\//i.test(value)) value = value.replace(/^file:\/\//i, '');
    // Codex sometimes prefixes Windows drive paths with a slash in Markdown URLs.
    value = value.replace(/^\/+([a-z]:\/)/i, '$1');
    if (/^[a-z]:\//i.test(value) || value.startsWith('/')) {
      if (!root || !key(value).startsWith(`${key(root)}/`)) return null;
      value = value.slice(root.length + 1);
    } else if (/^[a-z][a-z\d+.-]*:/i.test(value)) return null;
    value = value.replace(/^\.\//, '');
    if (value.split('/').some(part => part === '..' || part === '.')) return null;
    return value;
  }

  function resolve(raw: string): ResolvedNote | null {
    const value = localPath(raw);
    if (!value) return null;
    const anchorAt = value.search(/[#^]/);
    const anchor = anchorAt >= 0 ? value.slice(anchorAt) : '';
    const path = (anchorAt >= 0 ? value.slice(0, anchorAt) : value).replace(/:\d+(?::\d+)?$/, '');
    let file = paths.get(key(path)) ?? paths.get(key(`${path}.md`));
    if (!file && !path.includes('/')) {
      const targets = names.get(key(path));
      if (targets?.size === 1) file = paths.get(key([...targets][0]));
    }
    // Recheck the live inventory before emitting a clickable target.
    if (!file || !app.vault.getFileByPath(file.path)) return null;
    return { file, anchor };
  }

  function link(resolved: ResolvedNote, display?: string): string {
    const label = (display || resolved.file.basename).replace(/[[\]|\r\n]/g, ' ').trim();
    return `[[${withoutMd(resolved.file.path)}${resolved.anchor}|${label}]]`;
  }

  const alternatives = [...candidates].filter(name => name.length > 1).sort((a, b) => b.length - a.length);
  const pattern = alternatives.length ? new RegExp(alternatives.map(escapePattern).join('|'), 'y') : null;
  return { resolve, link, localPath, pattern };
}

/** Finds a balanced Markdown link without splitting spaces/parentheses in <paths>. */
function markdownLinkAt(text: string, start: number): { end: number; label: string; target: string } | null {
  let depth = 1;
  let index = start + 1;
  for (; index < text.length && depth; index++) {
    if (text[index] === '\\') { index++; continue; }
    if (text[index] === '[') depth++;
    if (text[index] === ']') depth--;
  }
  if (depth || text[index] !== '(') return null;
  const label = text.slice(start + 1, index - 1);
  const targetStart = ++index;
  let angle = false;
  depth = 1;
  for (; index < text.length; index++) {
    const char = text[index];
    if (char === '\\' && /[()<>]/.test(text[index + 1] ?? '')) { index++; continue; }
    if (char === '<') angle = true;
    else if (char === '>') angle = false;
    else if (!angle && char === '(') depth++;
    else if (!angle && char === ')' && --depth === 0) {
      const raw = text.slice(targetStart, index).trim();
      const target = raw.startsWith('<') ? raw.slice(1, raw.indexOf('>')) : raw.replace(/\s+["'][\s\S]*$/, '');
      return { end: index + 1, label, target };
    }
  }
  return null;
}

/** Normalize assistant prose, leaving code, hidden control payloads and embeds intact. */
export function normalizeVaultNoteLinks(text: string, app: App): string {
  if (!text || !app?.vault?.getFiles || !app.vault.getFileByPath) return text;
  const resolver = createResolver(app, text);
  let output = '';
  let index = 0;
  while (index < text.length) {
    const rest = text.slice(index);
    if (index === 0 || text[index - 1] === '\n') {
      const quote = /^ {0,3}>[^\n]*(?:\n|$)/.exec(rest);
      if (quote) {
        output += quote[0];
        index += quote[0].length;
        continue;
      }
      const fence = /^ {0,3}(`{3,}|~{3,})[^\n]*(?:\n|$)/.exec(rest);
      if (fence) {
        const closing = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}[^\\S\\r\\n]*(?:\\r?\\n|$)`, 'm');
        const tail = rest.slice(fence[0].length);
        const match = closing.exec(tail);
        const length = match ? fence[0].length + match.index + match[0].length : rest.length;
        output += rest.slice(0, length);
        index += length;
        continue;
      }
    }
    if (rest.startsWith('<!--')) {
      const end = text.indexOf('-->', index + 4);
      const next = end < 0 ? text.length : end + 3;
      output += text.slice(index, next);
      index = next;
      continue;
    }
    if (rest.startsWith('`')) {
      const ticks = /^`+/.exec(rest)![0];
      const end = text.indexOf(ticks, index + ticks.length);
      if (end < 0) { output += rest; break; }
      const content = text.slice(index + ticks.length, end);
      const resolved = resolver.resolve(content);
      output += resolved ? resolver.link(resolved) : text.slice(index, end + ticks.length);
      index = end + ticks.length;
      continue;
    }
    const embed = rest.startsWith('![');
    const start = embed ? index + 1 : index;
    if (text[start] === '[' && text[index - 1] !== '\\') {
      if (text.startsWith('[[', start)) {
        const end = text.indexOf(']]', start + 2);
        if (end < 0) { output += rest; break; }
        const inner = text.slice(start + 2, end);
        const pipe = inner.indexOf('|');
        const target = pipe >= 0 ? inner.slice(0, pipe) : inner;
        const label = pipe >= 0 ? inner.slice(pipe + 1) : target;
        const resolved = resolver.resolve(target);
        output += embed ? text.slice(index, end + 2)
          : resolved ? resolver.link(resolved, pipe >= 0 ? label : undefined) : `${label}${UNVERIFIED}`;
        index = end + 2;
        continue;
      }
      const markdown = markdownLinkAt(text, start);
      if (markdown) {
        const resolved = resolver.resolve(markdown.target);
        const local = resolver.localPath(markdown.target);
        output += embed ? text.slice(index, markdown.end)
          : resolved ? resolver.link(resolved, markdown.label)
            : local !== null && /\.(?:md|pdf)(?:[#:]|$)/i.test(local) ? `${markdown.label}${UNVERIFIED}`
              : text.slice(index, markdown.end);
        index = markdown.end;
        continue;
      }
    }
    // Do not rewrite HTML attributes, autolinks, or explicit external URLs.
    const protectedToken = /^(?:<[^>\n]*>|(?:https?|file|obsidian):\/\/[^\s<>]+)/i.exec(rest);
    if (protectedToken) {
      const target = protectedToken[0].replace(/^<|>$/g, '');
      const resolved = /^(?:file|obsidian):\/\//i.test(target) ? resolver.resolve(target) : null;
      output += resolved ? resolver.link(resolved) : protectedToken[0];
      index += protectedToken[0].length;
      continue;
    }
    const pattern = resolver.pattern;
    if (pattern) {
      pattern.lastIndex = index;
      const match = pattern.exec(text);
      if (match) {
        const value = match[0];
        const before = text[index - 1] ?? '';
        const after = text[index + value.length] ?? '';
        const shortName = !/[./\\]/.test(value) && value.length <= 3;
        const attached = /[\w/\\]/.test(before) || /[\w/\\]/.test(after)
          || (shortName && (/[\p{L}\p{N}]/u.test(before) || /[\p{L}\p{N}]/u.test(after)));
        const resolved = !attached && !text.startsWith(UNVERIFIED, index + value.length) ? resolver.resolve(value) : null;
        if (resolved) {
          output += resolver.link(resolved);
          index += value.length;
          continue;
        }
      }
    }
    output += text[index++];
  }
  return output;
}

export function normalizeAssistantNoteReferences(message: ChatMessage, app: App): void {
  if (message.role !== 'assistant') return;
  message.content = normalizeVaultNoteLinks(message.content, app);
  for (const block of message.contentBlocks ?? []) {
    if (block.type === 'text') block.content = normalizeVaultNoteLinks(block.content, app);
  }
}

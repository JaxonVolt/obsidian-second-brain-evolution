import type { App, TFile } from 'obsidian';

import type { ChatMessage } from '@/core/types';
import { normalizeAssistantNoteReferences, normalizeVaultNoteLinks } from '@/utils/vaultNoteLinks';

function createApp(paths: string[], aliases: Record<string, string[]> = {}) {
  const files = paths.map(path => {
    const name = path.split('/').pop()!;
    const dot = name.lastIndexOf('.');
    return { path, name, basename: name.slice(0, dot), extension: name.slice(dot + 1) } as TFile;
  });
  const app = {
    vault: {
      adapter: { basePath: 'F:/Example Vault' },
      getFiles: jest.fn(() => files),
      getFileByPath: jest.fn((path: string) => files.find(file => file.path === path) ?? null),
    },
    metadataCache: { getFileCache: jest.fn((file: TFile) => ({ frontmatter: { aliases: aliases[file.path] ?? [] } })) },
  };
  return app as unknown as App;
}

const guide = '000_元数据/LLM Wiki使用指南.md';
const linked = '[[000_元数据/LLM Wiki使用指南|LLM Wiki使用指南]]';

describe('normalizeVaultNoteLinks', () => {
  let app: App;
  beforeEach(() => { app = createApp([guide, '工作/运行规程.pdf', '甲/同名笔记.md', '乙/同名笔记.md', '000_元数据/现状.md']); });

  it.each([
    ['LLM Wiki使用指南', linked],
    ['请打开《LLM Wiki使用指南》。', `请打开《${linked}》。`],
    ['000_元数据/LLM Wiki使用指南.md', linked],
    ['000_元数据\\LLM Wiki使用指南.md', linked],
    ['`000_元数据/LLM Wiki使用指南.md`', linked],
    ['``F:\\Example Vault\\000_元数据\\LLM Wiki使用指南.md``', linked],
    ['F:/Example Vault/000_元数据/LLM Wiki使用指南.md', linked],
    ['[[LLM Wiki使用指南]]', linked],
    ['[[000_元数据/LLM Wiki使用指南.md]]', linked],
    ['[[LLM Wiki使用指南#导入|导入方法]]', '[[000_元数据/LLM Wiki使用指南#导入|导入方法]]'],
    ['[[LLM Wiki使用指南^block|段落]]', '[[000_元数据/LLM Wiki使用指南^block|段落]]'],
    ['[指南](</F:/Example Vault/000_元数据/LLM Wiki使用指南.md>)', '[[000_元数据/LLM Wiki使用指南|指南]]'],
    ['[指南](F:/Example%20Vault/000_元数据/LLM%20Wiki使用指南.md)', '[[000_元数据/LLM Wiki使用指南|指南]]'],
    ['[指南](file:///F:/Example%20Vault/000_元数据/LLM%20Wiki使用指南.md)', '[[000_元数据/LLM Wiki使用指南|指南]]'],
    ['[指南](</F:/Example Vault/000_元数据/LLM Wiki使用指南.md:12>)', '[[000_元数据/LLM Wiki使用指南|指南]]'],
    ['[指南](000_元数据/LLM%20Wiki使用指南.md "title")', '[[000_元数据/LLM Wiki使用指南|指南]]'],
    ['[规程](工作/运行规程.pdf)', '[[工作/运行规程.pdf|规程]]'],
    ['现状', '[[000_元数据/现状|现状]]'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeVaultNoteLinks(input, app)).toBe(expected);
    expect(normalizeVaultNoteLinks(expected, app)).toBe(expected);
  });

  it('resolves explicit aliases without reading file bodies', () => {
    app = createApp([guide], { [guide]: ['Wiki资料导入与检索指南'] });
    expect(normalizeVaultNoteLinks('Wiki资料导入与检索指南', app)).toBe('Wiki资料导入与检索指南');
    expect(normalizeVaultNoteLinks('[[Wiki资料导入与检索指南]]', app)).toBe(linked);
  });

  it('resolves a unique heading title from the metadata cache', () => {
    (app.metadataCache.getFileCache as jest.Mock).mockImplementation((file: TFile) => file.path === guide
      ? { headings: [{ level: 1, heading: 'Wiki操作手册' }] } : null);
    expect(normalizeVaultNoteLinks('Wiki操作手册', app)).toBe('Wiki操作手册');
    expect(normalizeVaultNoteLinks('[[Wiki操作手册]]', app)).toBe(linked);
  });

  it('does not turn product names used as aliases into implicit note references', () => {
    app = createApp(['长期记忆入口.md', '欢迎笔记.md'], { '长期记忆入口.md': ['LLM Wiki'], '欢迎笔记.md': ['第二大脑'] });
    const text = '在 LLM Wiki 里搜索，没有修改第二大脑笔记。';
    expect(normalizeVaultNoteLinks(text, app)).toBe(text);
  });

  it('does not guess duplicate names or aliases', () => {
    expect(normalizeVaultNoteLinks('同名笔记', app)).toBe('同名笔记');
    expect(normalizeVaultNoteLinks('[[同名笔记|资料]]', app)).toBe('资料（链接目标未核实）');
    expect(normalizeVaultNoteLinks('[[甲/同名笔记|资料]]', app)).toBe('[[甲/同名笔记|资料]]');
    app = createApp(['甲/一.md', '乙/二.md'], { '甲/一.md': ['共同名称'], '乙/二.md': ['共同名称'] });
    expect(normalizeVaultNoteLinks('共同名称', app)).toBe('共同名称');
  });

  it('does not fall back to basename when a qualified target is wrong', () => {
    expect(normalizeVaultNoteLinks('[[不存在/LLM Wiki使用指南|指南]]', app)).toBe('指南（链接目标未核实）');
    expect(normalizeVaultNoteLinks('[指南](missing/LLM%20Wiki使用指南.md)', app)).toBe('指南（链接目标未核实）');
  });

  it('rechecks deleted and newly-created files', () => {
    (app.vault.getFileByPath as jest.Mock).mockReturnValue(null);
    expect(normalizeVaultNoteLinks('[[LLM Wiki使用指南|指南]]', app)).toBe('指南（链接目标未核实）');
    app = createApp(['新建笔记.md']);
    expect(normalizeVaultNoteLinks('新建笔记', app)).toBe('[[新建笔记|新建笔记]]');
  });

  it.each([
    '[指南](F:/codex/wiki/LLM%20Wiki使用指南.md)',
    '[指南](file:///F:/codex/wiki/LLM%20Wiki使用指南.md)',
    'F:/codex/wiki/LLM Wiki使用指南.md',
    '[指南](https://example.com/LLM%20Wiki使用指南.md)',
    'https://example.com/LLM%20Wiki使用指南.md',
    '[网页](https://example.com/a(b)c)',
    '[另一个库](obsidian://open?vault=Other&file=000_元数据%2FLLM%20Wiki使用指南.md)',
  ])('preserves external reference %s', (input) => {
    expect(normalizeVaultNoteLinks(input, app)).toBe(input);
  });

  it('rejects root-prefix collisions and traversal', () => {
    expect(normalizeVaultNoteLinks('[[F:/Example Vault Other/000_元数据/LLM Wiki使用指南.md|指南]]', app)).toBe('指南（链接目标未核实）');
    expect(normalizeVaultNoteLinks('[[../000_元数据/LLM Wiki使用指南|指南]]', app)).toBe('指南（链接目标未核实）');
  });

  it('normalizes an Obsidian URI only for the current Vault', () => {
    const input = '[指南](obsidian://open?vault=Example%20Vault&file=000_元数据%2FLLM%20Wiki使用指南.md)';
    expect(normalizeVaultNoteLinks(input, app)).toBe('[[000_元数据/LLM Wiki使用指南|指南]]');
  });

  it.each([
    '```text\nLLM Wiki使用指南\n[[missing]]\n```',
    '~~~powershell\nGet-Content "000_元数据/LLM Wiki使用指南.md"\n~~~',
    '```ts\nconst p = "LLM Wiki使用指南";',
    '`Get-Content "000_元数据/LLM Wiki使用指南.md"`',
    '`[[笔记相对路径|显示名称]]`',
    '> 用户原话：LLM Wiki使用指南',
    '![截图](工作/运行规程.pdf)',
    '![[工作/运行规程.pdf]]',
    '<!-- second-brain-custom-instructions:append\nLLM Wiki使用指南\n-->',
    '<span data-note="LLM Wiki使用指南">示例</span>',
    '当前现状不明',
    'myLLM Wiki使用指南Suffix',
  ])('preserves literal content %s', (input) => {
    expect(normalizeVaultNoteLinks(input, app)).toBe(input);
  });

  it('does not expose a half-formed link during a split stream', () => {
    expect(normalizeVaultNoteLinks('请看 [[000_元数据/LLM Wiki使用指南', app)).toBe('请看 [[000_元数据/LLM Wiki使用指南');
    expect(normalizeVaultNoteLinks('请看 [[000_元数据/LLM Wiki使用指南]]', app)).toBe(`请看 ${linked}`);
  });

  it('is idempotent even when an invalid target has a valid note as its label', () => {
    const once = normalizeVaultNoteLinks('[[missing|LLM Wiki使用指南]]', app);
    expect(once).toBe('LLM Wiki使用指南（链接目标未核实）');
    expect(normalizeVaultNoteLinks(once, app)).toBe(once);
  });

  it('handles a filename containing parentheses and spaces in a Markdown link', () => {
    app = createApp(['资料/接线图 (完整版).md']);
    expect(normalizeVaultNoteLinks('[接线图](<F:/Example Vault/资料/接线图 (完整版).md>)', app)).toBe('[[资料/接线图 (完整版)|接线图]]');
  });

  it('normalizes assistant text for persistence without altering tools or user messages', () => {
    const assistant = { role: 'assistant', content: 'LLM Wiki使用指南', contentBlocks: [{ type: 'text', content: 'LLM Wiki使用指南' }, { type: 'thinking', content: 'LLM Wiki使用指南' }] } as ChatMessage;
    normalizeAssistantNoteReferences(assistant, app);
    expect(assistant.content).toBe(linked);
    expect(assistant.contentBlocks?.[0]).toEqual({ type: 'text', content: linked });
    expect(assistant.contentBlocks?.[1]).toEqual({ type: 'thinking', content: 'LLM Wiki使用指南' });
    const user = { role: 'user', content: 'LLM Wiki使用指南' } as ChatMessage;
    normalizeAssistantNoteReferences(user, app);
    expect(user.content).toBe('LLM Wiki使用指南');
  });
});

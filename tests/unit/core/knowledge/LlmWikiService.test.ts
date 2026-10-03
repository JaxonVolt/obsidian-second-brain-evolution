import { promises as fs } from 'fs';
import { type App, requestUrl } from 'obsidian';
import * as path from 'path';

import {
  ensureLlmWikiProjectScaffold,
  isAbsoluteWikiPath,
  LlmWikiService,
  resolveWikiEvidencePath,
  shouldSearchRawInbox,
} from '@/core/knowledge/LlmWikiService';
import { DEFAULT_SETTINGS } from '@/core/types';

describe('LlmWikiService', () => {
  const scaffoldRoot = path.join(process.cwd(), '.test-output', 'llm-wiki-scaffold');

  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(scaffoldRoot, { recursive: true, force: true });
  });

  it('accepts user-selected absolute paths without binding to a drive', () => {
    expect(isAbsoluteWikiPath('F:\\Tools\\LLM Wiki')).toBe(true);
    expect(isAbsoluteWikiPath('D:/Knowledge/Wiki')).toBe(true);
    expect(isAbsoluteWikiPath('C:\\Users\\example\\Knowledge')).toBe(true);
    expect(isAbsoluteWikiPath('/home/example/wiki')).toBe(true);
    expect(isAbsoluteWikiPath('.\\memory')).toBe(false);
    expect(isAbsoluteWikiPath('')).toBe(false);
  });

  it('repairs missing project scaffold without overwriting existing wiki content', async () => {
    const wikiPath = path.join(scaffoldRoot, 'wiki');
    await fs.mkdir(wikiPath, { recursive: true });
    await fs.writeFile(path.join(wikiPath, 'index.md'), '# 用户现有索引\n', 'utf8');

    await ensureLlmWikiProjectScaffold(scaffoldRoot);

    await expect(fs.readFile(path.join(wikiPath, 'index.md'), 'utf8'))
      .resolves.toBe('# 用户现有索引\n');
    await expect(fs.readFile(path.join(wikiPath, 'overview.md'), 'utf8'))
      .resolves.toContain('# 知识库概览');
    await expect(fs.readFile(path.join(wikiPath, 'log.md'), 'utf8'))
      .resolves.toBe('# Wiki Log\n');
    await expect(fs.stat(path.join(scaffoldRoot, 'raw', 'sources')))
      .resolves.toMatchObject({});
  });

  it('reports the missing executable path immediately instead of timing out', async () => {
    const missingPath = 'F:\\definitely-missing-llm-wiki\\LLM Wiki.exe';
    const service = new LlmWikiService(
      {} as App,
      () => ({
        ...DEFAULT_SETTINGS,
        llmWikiEnabled: true,
        llmWikiExecutablePath: missingPath,
        llmWikiProjectPath: 'F:/example/wiki',
      }),
      () => null,
    );

    const status = await service.start();

    expect(status.connected).toBe(false);
    expect(status.detail).toBe(`未找到长期知识库便携程序：${missingPath}`);
  });

  it('rejects incomplete runtime paths before trying to launch', async () => {
    const service = new LlmWikiService(
      {} as App,
      () => ({
        ...DEFAULT_SETTINGS,
        llmWikiEnabled: true,
        llmWikiExecutablePath: 'C:\\LLM Wiki\\LLM Wiki.exe',
      }),
      () => null,
    );

    const status = await service.start();

    expect(status.connected).toBe(false);
    expect(status.detail).toBe('请填写LLM Wiki程序和知识项目的绝对路径。');
  });

  it('builds bounded, escaped evidence context and keeps empty retrieval silent', async () => {
    const service = new LlmWikiService(
      {} as App,
      () => ({
        ...DEFAULT_SETTINGS,
        llmWikiEnabled: true,
        llmWikiAutoRetrieve: true,
        llmWikiTopK: 6,
        llmWikiProjectPath: 'F:/example/wiki',
      }),
      () => null,
    );
    const search = jest.spyOn(service, 'search').mockResolvedValueOnce([{
      path: 'wiki/concepts/a&b.md',
      title: '<关键结论>',
      snippet: 'fallback',
      score: 0.9,
      content: '证据 < 结论 & 仍需核实',
    }]).mockResolvedValueOnce([]);

    const context = await service.buildContext('我的问题记录');
    expect(context).toContain('/wiki/concepts/a&amp;b.md"');
    expect(context).toContain('title="&lt;关键结论&gt;"');
    expect(context).toContain('证据 &lt; 结论 &amp; 仍需核实');
    expect(await service.buildContext('我的无结果记录')).toBe('');
    expect(search).toHaveBeenCalledTimes(2);
  });

  it('distinguishes failed retrieval from a successful empty result', async () => {
    const service = new LlmWikiService(
      {} as App,
      () => ({ ...DEFAULT_SETTINGS, llmWikiEnabled: true, llmWikiAutoRetrieve: true }),
      () => null,
    );
    jest.spyOn(service, 'search').mockRejectedValue(new Error('offline'));

    await expect(service.buildContext('问题')).resolves.toContain('LLM Wiki检索未完成');
  });

  it('resolves source paths only within the configured Wiki project', () => {
    expect(resolveWikiEvidencePath('F:/wiki', 'wiki/sources/a.md')).toBe('F:/wiki/wiki/sources/a.md');
    expect(resolveWikiEvidencePath('F:/wiki', 'sources/a.md')).toBe('F:/wiki/wiki/sources/a.md');
    expect(resolveWikiEvidencePath('F:/wiki', 'index.md')).toBe('F:/wiki/wiki/index.md');
    expect(resolveWikiEvidencePath('F:/wiki', 'raw/sources/a.pdf')).toBe('F:/wiki/raw/sources/a.pdf');
    expect(resolveWikiEvidencePath('F:/wiki', 'F:/wiki/wiki/sources/a.md')).toBe('F:/wiki/wiki/sources/a.md');
    expect(resolveWikiEvidencePath('F:/wiki', '../other/a.md')).toBeNull();
    expect(resolveWikiEvidencePath('F:/wiki', 'C:/private/a.md')).toBeNull();
    expect(resolveWikiEvidencePath('F:/wiki', 'F:/wiki2/a.md')).toBeNull();
  });

  it('pins API retrieval to the configured project instead of the UI current project', async () => {
    const request = requestUrl as jest.Mock;
    request.mockResolvedValueOnce({ status: 200 }).mockResolvedValueOnce({ status: 200, json: { results: [] } });
    const projectPath = 'F:/wiki/expected';
    const app = { secretStorage: { getSecret: () => 'test-token' } } as unknown as App;
    const service = new LlmWikiService(app,
      () => ({ ...DEFAULT_SETTINGS, llmWikiProjectPath: projectPath }), () => null);
    await expect(service.search('发电馈线')).resolves.toEqual([]);
    expect(request).toHaveBeenLastCalledWith(expect.objectContaining({
      url: `http://127.0.0.1:19828/api/v1/projects/${encodeURIComponent(projectPath)}/search`,
    }));
  });

  it('reads bounded Markdown evidence when the API returns only snippets', async () => {
    const request = requestUrl as jest.Mock;
    request.mockResolvedValueOnce({ status: 200 }).mockResolvedValueOnce({ status: 200, json: { results: [
      { path: 'sources/diagram.md', title: 'Diagram', snippet: 'short', score: 1 },
      { path: 'sources/large.md', title: 'Large', snippet: 'large fallback', score: 1 },
      { path: '../private.md', title: 'Outside', snippet: 'outside', score: 1 },
      { path: 'raw/sources/diagram.pdf', title: 'PDF', snippet: 'PDF fallback', score: 1 },
    ] } });
    jest.spyOn(fs, 'realpath').mockImplementation(async (value) => String(value));
    jest.spyOn(fs, 'stat').mockImplementation(async (value) => ({
      isFile: () => true, size: String(value).includes('large') ? 1_000_001 : 100,
    }) as Awaited<ReturnType<typeof fs.stat>>);
    const read = jest.spyOn(fs, 'readFile').mockResolvedValue('# Verified feeder facts');
    const app = { secretStorage: { getSecret: () => 'test-token' } } as unknown as App;
    const service = new LlmWikiService(app,
      () => ({ ...DEFAULT_SETTINGS, llmWikiProjectPath: 'F:/wiki' }), () => null);
    const results = await service.search('feeders');
    expect(results[0].content).toBe('# Verified feeder facts');
    expect(results[1].content).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith('F:/wiki/wiki/sources/diagram.md', 'utf8');
  });

  it('combines strong local diagram matches with Wiki evidence for professional questions', async () => {
    const note = { path: '100_技术/主接线图发电馈线.md', basename: '主接线图发电馈线', stat: { mtime: 1, size: 100 } };
    const asset = { path: '100_技术/主接线图.pdf', basename: '主接线图', extension: 'pdf', stat: { mtime: 1, size: 100 } };
    const app = { vault: { getMarkdownFiles: () => [note], getFiles: () => [note, asset],
      cachedRead: async () => '# 主接线图发电馈线\n发电馈线连接逆变器。' } } as unknown as App;
    const service = new LlmWikiService(app,
      () => ({ ...DEFAULT_SETTINGS, llmWikiEnabled: true, llmWikiAutoRetrieve: true,
        llmWikiProjectPath: 'F:/example/wiki' }), () => null);
    const search = jest.spyOn(service, 'search').mockResolvedValue([{ path: 'wiki/sources/馈线核验.md',
      title: '馈线核验', snippet: '已有解析结果：发电馈线与逆变器数量仍需原图核实。', score: 1 }]);
    const query = '主接线图中的发电馈线每个连接几个逆变器';
    const context = await service.buildContext(query);
    expect(search).toHaveBeenCalledWith(query, 6);
    expect(context).toContain(note.path);
    expect(context).toContain(asset.path);
    expect(context).toContain('已有解析结果');
    expect(context).toContain('source_system="llm-wiki"');
    expect(service.lastRetrievalDiagnostics?.wikiSearched).toBe(true);
  });

  it('retrieves relevant Vault experiences even when LLM Wiki is disabled', async () => {
    const files = [{
      path: '500_永久笔记与知识资产/人际沟通.md',
      basename: '人际沟通',
      stat: { mtime: 2 },
    }, {
      path: '500_永久笔记与知识资产/待验证经验/冲突回应.md',
      basename: '冲突回应',
      stat: { mtime: 3 },
    }, {
      path: '300_复盘与日志/日志.md',
      basename: '日志',
      stat: { mtime: 4 },
    }];
    const contents: Record<string, string> = {
      [files[0].path]: '---\ntype: permanent-note\nknowledge_stage: established\n---\n# 人际沟通\n发生冲突时先澄清事实，再表达边界。',
      [files[1].path]: '---\ntype: experience-hypothesis\nstatus: observing\n---\n# 冲突回应\n当场回应是否有效仍需结合关系验证。',
      [files[2].path]: '# 日志\n与同事沟通。',
    };
    const app = {
      vault: {
        getMarkdownFiles: jest.fn(() => files),
        cachedRead: jest.fn(async (file: { path: string }) => contents[file.path]),
      },
    } as unknown as App;
    const service = new LlmWikiService(
      app,
      () => ({ ...DEFAULT_SETTINGS, llmWikiEnabled: false, llmWikiAutoRetrieve: false }),
      () => null,
    );

    const context = await service.buildContext('遇到人际冲突时应该怎么回应');

    expect(context).toContain('<vault_long_term_memory>');
    expect(context).toContain('stage="established"');
    expect(context).toContain('发生冲突时先澄清事实');
    expect(context).toContain('stage="hypothesis"');
    expect(context).not.toContain('300_复盘与日志/日志.md');
  });

  it('retrieves only relevant raw inbox records when the query explicitly refers to WeChat history', async () => {
    expect(shouldSearchRawInbox('解释一下变频器故障')).toBe(false);
    expect(shouldSearchRawInbox('帮我找以前在微信发过的PLC故障图片')).toBe(true);
    const dailyPath = '010_收件箱/原始输入_raw/2026/08/2026-08-23.md';
    const files = [{
      path: dailyPath,
      basename: '2026-08-23',
      stat: { mtime: 10 },
    }];
    const content = `---
type: inbox-capture-day
---
# 2026-08-23 原始输入

<!-- second-brain:raw-entry:start {"id":"raw-1","created":"2026-08-23T08:00:00","source":"wechat-ilink","metadata":{}} -->
## 08:00:00 · 微信

这张图片记录了PLC故障定位过程。

^raw-1
<!-- second-brain:raw-entry:end -->

<!-- second-brain:raw-entry:start {"id":"raw-2","created":"2026-08-23T09:00:00","source":"wechat-ilink","metadata":{}} -->
## 09:00:00 · 微信

今晚买水果。

^raw-2
<!-- second-brain:raw-entry:end -->
`;
    const app = {
      vault: {
        getMarkdownFiles: jest.fn(() => files),
        cachedRead: jest.fn(async () => content),
      },
    } as unknown as App;
    const service = new LlmWikiService(
      app,
      () => ({ ...DEFAULT_SETTINGS, llmWikiAutoRetrieve: false }),
      () => null,
    );

    const context = await service.buildContext('帮我找以前在微信发过的PLC故障图片');

    expect(context).toContain('<raw_inbox_context>');
    expect(context).toContain(`${dailyPath}#^raw-1`);
    expect(context).toContain('PLC故障定位过程');
    expect(context).not.toContain('今晚买水果');
  });
});

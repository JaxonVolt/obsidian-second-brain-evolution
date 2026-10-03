import { promises as fs } from 'fs';
import * as path from 'path';

import { isAbsoluteWikiPath, resolveWikiEvidencePath } from '@/core/knowledge/LlmWikiService';
import { SECOND_BRAIN_PATHS, SKELETON_FILES } from '@/core/knowledge/SecondBrainInitializer';
import { DEFAULT_SETTINGS } from '@/core/types';

describe('public distribution defaults and path boundary', () => {
  it('starts without personal paths or background model and message jobs', () => {
    expect(DEFAULT_SETTINGS.llmWikiEnabled).toBe(false);
    expect(DEFAULT_SETTINGS.llmWikiAutoStart).toBe(false);
    expect(DEFAULT_SETTINGS.llmWikiAutoRetrieve).toBe(false);
    expect(DEFAULT_SETTINGS.llmWikiExecutablePath).toBe('');
    expect(DEFAULT_SETTINGS.llmWikiProjectPath).toBe('');
    expect(DEFAULT_SETTINGS.proactiveInsightsAutoAnalyze).toBe(false);
    expect(DEFAULT_SETTINGS.wechatButlerEnabled).toBe(false);
    expect(DEFAULT_SETTINGS.systemPrompt).toBe('');
    expect(DEFAULT_SETTINGS.wechatAdditionalInstructions).toBe('');
    expect(DEFAULT_SETTINGS.codexProviderBaseUrl).toBe('');
    expect(DEFAULT_SETTINGS.codexProviderSecretId).toBe('');
  });

  it.each(['C:/Knowledge/Wiki', 'D:/Knowledge/Wiki', '/home/example/wiki', '/Users/example/wiki'])(
    'scopes evidence to the selected project %s', (root) => {
    expect(isAbsoluteWikiPath(root)).toBe(true);
    expect(resolveWikiEvidencePath(root, 'sources/manual.md')).toBe(`${root}/wiki/sources/manual.md`);
    expect(resolveWikiEvidencePath(root, 'raw/sources/manual.pdf')).toBe(`${root}/raw/sources/manual.pdf`);
    expect(resolveWikiEvidencePath(root, '../other.md')).toBeNull();
    expect(resolveWikiEvidencePath(root, `${root}-other/manual.md`)).toBeNull();
    expect(resolveWikiEvidencePath(root, '/outside/manual.md')).toBeNull();
    });

  it('rejects incomplete and foreign-drive evidence roots', () => {
    expect(resolveWikiEvidencePath('', 'sources/a.md')).toBeNull();
    expect(resolveWikiEvidencePath('relative/wiki', 'sources/a.md')).toBeNull();
    expect(resolveWikiEvidencePath('/home/example/wiki', 'C:/outside/a.md')).toBeNull();
    expect(resolveWikiEvidencePath('D:/Knowledge/Wiki', 'C:/outside/a.md')).toBeNull();
  });

  it('initializes a generic daily template with the four routing destinations', () => {
    expect(SECOND_BRAIN_PATHS.dailyNotes).toBe('300_复盘与日志/310_每日笔记');
    const template = SKELETON_FILES['900_模板/00_每日笔记模板.md'];
    for (const label of ['永久笔记', '回到项目、领域或旧笔记', '需要继续消化或核实', '可以发展成输出']) {
      expect(template).toContain(`- ${label}：`);
    }
  });

  it('renders current-status without requiring an unshipped Skill', async () => {
    const { KNOWLEDGE_COMMANDS } = await import('@/core/commands/knowledgeCommands');
    const command = KNOWLEDGE_COMMANDS.find((item) => item.name === 'current-status')!;
    expect(command.content).toContain('不依赖额外Skill');
    expect(command.content).toContain('不修改任何文件');
  });

  it('the distributable metadata matches the maintained version', async () => {
    const read = async (name: string) => JSON.parse(await fs.readFile(path.join(process.cwd(), name), 'utf8'));
    const [manifest, pkg, versions] = await Promise.all([read('manifest.json'), read('package.json'), read('versions.json')]);
    expect(manifest.version).toBe(pkg.version);
    expect(versions[manifest.version]).toBe(manifest.minAppVersion);
    expect(manifest.isDesktopOnly).toBe(true);
  });
});

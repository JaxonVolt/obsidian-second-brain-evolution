import type { App, DataAdapter } from 'obsidian';

import {
  SECOND_BRAIN_PATHS,
  SecondBrainInitializer,
  SKELETON_FILES,
} from '@/core/knowledge/SecondBrainInitializer';

function createFixture(initialFiles: Record<string, string> = {}) {
  const files = new Map(Object.entries(initialFiles));
  const folders = new Set<string>(['.second-brain']);
  const adapter = {
    exists: jest.fn(async (path: string) => files.has(path) || folders.has(path)),
    read: jest.fn(async (path: string) => files.get(path) ?? ''),
    write: jest.fn(async (path: string, content: string) => { files.set(path, content); }),
    mkdir: jest.fn(async (path: string) => { folders.add(path); }),
  } as unknown as DataAdapter;
  const app = { vault: { adapter } } as unknown as App;
  return { adapter, files, folders, initializer: new SecondBrainInitializer(app) };
}

describe('SecondBrainInitializer', () => {
  it('creates the generic skeleton and records completion', async () => {
    const fixture = createFixture();

    const result = await fixture.initializer.initialize();

    expect(result.createdFiles).toHaveLength(Object.keys(SKELETON_FILES).length);
    expect(fixture.files.has(SECOND_BRAIN_PATHS.coreCoordinate)).toBe(true);
    expect(fixture.files.has(`${SECOND_BRAIN_PATHS.templates}/每日笔记模板.md`)).toBe(true);
    expect(await fixture.initializer.getStatus()).toBe('completed');
  });

  it('does not overwrite an existing user file', async () => {
    const fixture = createFixture({
      [SECOND_BRAIN_PATHS.coreCoordinate]: '# 用户自己的核心坐标\n',
    });

    const result = await fixture.initializer.initialize();

    expect(fixture.files.get(SECOND_BRAIN_PATHS.coreCoordinate)).toBe('# 用户自己的核心坐标\n');
    expect(result.existingFiles).toContain(SECOND_BRAIN_PATHS.coreCoordinate);
  });

  it('is idempotent after the first initialization', async () => {
    const fixture = createFixture();
    await fixture.initializer.initialize();

    const second = await fixture.initializer.initialize();

    expect(second.createdFiles).toHaveLength(0);
    expect(second.missingFiles).toHaveLength(0);
  });

  it('remembers when first-run initialization is dismissed', async () => {
    const fixture = createFixture();

    await fixture.initializer.dismiss();

    expect(await fixture.initializer.getStatus()).toBe('dismissed');
  });
});

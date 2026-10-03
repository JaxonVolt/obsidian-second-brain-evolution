import type { App, TFile } from 'obsidian';

const queues = new WeakMap<object, Map<string, Promise<unknown>>>();

export function serializeVaultOperation<T>(app: App, key: string, operation: () => Promise<T>): Promise<T> {
  let pending = queues.get(app.vault);
  if (!pending) queues.set(app.vault, pending = new Map());
  const result = (pending.get(key) ?? Promise.resolve()).catch(() => undefined).then(operation);
  pending.set(key, result);
  void result.finally(() => {
    if (pending.get(key) === result) pending.delete(key);
  }).catch(() => undefined);
  return result;
}

export async function readOptionalText(app: App, path: string): Promise<string | null> {
  return await app.vault.adapter.exists(path) ? app.vault.adapter.read(path) : null;
}

export async function ensureVaultFolder(app: App, path: string): Promise<void> {
  let current = '';
  for (const part of path.split('/').filter(Boolean)) {
    current = current ? `${current}/${part}` : part;
    if (!(await app.vault.adapter.exists(current))) {
      try { await app.vault.adapter.mkdir(current); } catch (error) {
        if (!(await app.vault.adapter.exists(current))) throw error;
      }
    }
  }
}

export async function writeTextIfUnchanged(app: App, path: string, before: string | null, after: string): Promise<void> {
  const file = app.vault.getAbstractFileByPath?.(path);
  if (before !== null && file && 'extension' in file && typeof app.vault.process === 'function') {
    await app.vault.process(file as TFile, (current) => {
      if (current !== before) throw new Error(`文件已发生变化，已停止写入：${path}`);
      return after;
    });
    return;
  }
  if (await readOptionalText(app, path) !== before) throw new Error(`文件已发生变化，已停止写入：${path}`);
  if (before === null && path.endsWith('.md') && !path.startsWith('.') && typeof app.vault.create === 'function') {
    await app.vault.create(path, after);
  } else {
    await app.vault.adapter.write(path, after);
  }
}

export interface OwnedTextChange {
  path: string;
  before: string | null;
  after: string;
}

/** Never restore a snapshot over edits made after this operation. */
export async function rollbackOwnedChanges(app: App, changes: OwnedTextChange[]): Promise<string[]> {
  const conflicts: string[] = [];
  for (const change of [...changes].reverse()) {
    try {
      const current = await readOptionalText(app, change.path);
      if (current === change.before) continue;
      if (current !== change.after) {
        conflicts.push(`${change.path}（保留执行期间的新修改）`);
        continue;
      }
      if (change.before !== null) await writeTextIfUnchanged(app, change.path, change.after, change.before);
      else await app.vault.adapter.remove(change.path);
    } catch (error) {
      conflicts.push(`${change.path}：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return conflicts;
}

/** Prepare a batch against an overlay; no live content changes until every proposal is valid. */
export function stageVaultWrites(app: App): { app: App; changes: Map<string, OwnedTextChange>; folders: Set<string> } {
  const changes = new Map<string, OwnedTextChange>();
  const folders = new Set<string>();
  const original = app.vault.adapter;
  const read = async (path: string) => changes.get(path)?.after ?? original.read(path);
  const exists = async (path: string) => changes.has(path) || folders.has(path) || original.exists(path);
  const write = async (path: string, after: string) => {
    const previous = changes.get(path);
    const before = previous ? previous.before : (await original.exists(path) ? await original.read(path) : null);
    changes.set(path, { path, before, after });
  };
  const toFile = (path: string): TFile => ({
    path, name: path.split('/').pop()!, basename: path.split('/').pop()!.replace(/\.md$/u, ''), extension: 'md',
    stat: { ctime: 0, mtime: 0, size: changes.get(path)!.after.length },
  }) as TFile;
  const adapter = new Proxy(original, { get(target, key) {
    if (key === 'read') return read;
    if (key === 'write') return write;
    if (key === 'exists') return exists;
    if (key === 'mkdir') return async (path: string) => { folders.add(path); };
    if (['remove', 'rmdir', 'rename', 'copy', 'append', 'writeBinary'].includes(String(key))) {
      return () => { throw new Error(`Unsupported staged operation: ${String(key)}`); };
    }
    if (key === 'list') return async (path: string) => {
      const listing = await original.exists(path) ? await original.list(path) : { files: [], folders: [] };
      const child = (item: string) => item.slice(0, item.lastIndexOf('/')) === path;
      return { files: [...new Set([...listing.files, ...[...changes.keys()].filter(child)])],
        folders: [...new Set([...listing.folders, ...[...folders].filter(child)])] };
    };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const vault = Object.assign(Object.create(app.vault), {
    adapter,
    getMarkdownFiles: () => {
      const files = new Map((app.vault.getMarkdownFiles?.() ?? []).map((file) => [file.path, file]));
      for (const path of changes.keys()) if (path.endsWith('.md') && !path.startsWith('.')) files.set(path, toFile(path));
      return [...files.values()];
    },
    getAbstractFileByPath: (path: string) => changes.has(path) ? toFile(path) : app.vault.getAbstractFileByPath?.(path),
    cachedRead: (file: TFile) => read(file.path),
    read: (file: TFile) => read(file.path),
    create: async (path: string, content: string) => {
      if (await exists(path)) throw new Error(`目标已存在：${path}`);
      await write(path, content);
      return toFile(path);
    },
    modify: (file: TFile, content: string) => write(file.path, content),
    process: async (file: TFile, transform: (content: string) => string) => {
      const content = transform(await read(file.path));
      await write(file.path, content);
      return content;
    },
    delete: () => { throw new Error('Unsupported staged deletion'); },
    rename: () => { throw new Error('Unsupported staged rename'); },
    createFolder: async (path: string) => { folders.add(path); },
  });
  return { app: Object.assign(Object.create(app), { vault }), changes, folders };
}

export async function commitStagedWrites(app: App, staged: ReturnType<typeof stageVaultWrites>, snapshotPath: string): Promise<void> {
  const changes = [...staged.changes.values()].filter((change) => change.before !== change.after);
  await serializeVaultOperation(app, 'batch-commit', async () => {
    for (const change of changes) {
      if (await readOptionalText(app, change.path) !== change.before) throw new Error(`目标在准备期间变化，未执行：${change.path}`);
    }
    await ensureVaultFolder(app, snapshotPath);
    const manifestPath = `${snapshotPath}/transaction.json`;
    await app.vault.adapter.write(manifestPath, JSON.stringify({ state: 'prepared', changes }, null, 2));
    const attempted: OwnedTextChange[] = [];
    try {
      for (const folder of staged.folders) await ensureVaultFolder(app, folder);
      for (const change of changes) {
        const separator = change.path.lastIndexOf('/');
        await ensureVaultFolder(app, separator >= 0 ? change.path.slice(0, separator) : '');
        attempted.push(change);
        await writeTextIfUnchanged(app, change.path, change.before, change.after);
      }
      await app.vault.adapter.write(manifestPath, JSON.stringify({ state: 'committed', changes }, null, 2));
    } catch (error) {
      const conflicts = await rollbackOwnedChanges(app, attempted);
      await app.vault.adapter.write(manifestPath, JSON.stringify({ state: conflicts.length ? 'conflict' : 'rolled-back', changes, conflicts }, null, 2));
      throw new Error(`${error instanceof Error ? error.message : String(error)}；${conflicts.length ? `保留同期修改，需核对：${conflicts.join('；')}` : '本批次已回滚'}。恢复记录：${manifestPath}`);
    }
  });
}

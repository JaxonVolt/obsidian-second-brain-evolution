import type { App } from 'obsidian';

import { ensureVaultFolder, serializeVaultOperation } from './VaultMutation';

const active = new WeakMap<object, Map<string, Promise<unknown>>>();

/** Coalesce duplicate requests and run expensive background analysis one job at a time. */
export function runAnalysisJob<T>(app: App, key: string, operation: () => Promise<T>): Promise<T> {
  let jobs = active.get(app.vault);
  if (!jobs) active.set(app.vault, jobs = new Map());
  const previous = jobs.get(key);
  if (previous) return previous as Promise<T>;
  const result = serializeVaultOperation(app, 'background-analysis', async () => {
    const startedAt = new Date().toISOString();
    const record = async (state: string, error?: unknown) => {
      try {
        await ensureVaultFolder(app, '.second-brain/analysis-jobs');
        await app.vault.adapter.write(`.second-brain/analysis-jobs/${key}.json`, JSON.stringify({
          key, state, startedAt, updatedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : error === undefined ? undefined : String(error),
        }, null, 2));
      } catch (failure) { console.warn('Could not record analysis status:', failure); }
    };
    await record('running');
    try {
      const value = await operation();
      await record('completed');
      return value;
    } catch (error) {
      await record('failed', error);
      throw error;
    }
  });
  jobs.set(key, result);
  void result.finally(() => {
    if (jobs.get(key) === result) jobs.delete(key);
  }).catch(() => undefined);
  return result;
}

export interface PluginDataHost {
  loadData(): Promise<Record<string, unknown> | null>;
  saveData(data: Record<string, unknown>): Promise<void>;
}

const queues = new WeakMap<PluginDataHost, Promise<void>>();

// All data.json writers must read and mutate within the same per-plugin queue.
export function mutatePluginData(
  host: PluginDataHost,
  mutate: (data: Record<string, unknown>) => void,
): Promise<void> {
  const operation = (queues.get(host) ?? Promise.resolve()).then(async () => {
    const data = { ...((await host.loadData()) ?? {}) };
    mutate(data);
    await host.saveData(data);
  });
  queues.set(host, operation.catch(() => undefined));
  return operation;
}

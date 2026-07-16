import {
  type SecretProtector,
  WeChatStateStore,
} from '../../../../src/core/wechat/WeChatStateStore';

describe('WeChatStateStore', () => {
  it('never stores the bot token as plaintext', async () => {
    let data: Record<string, unknown> = { tabManagerState: { openTabs: [] } };
    const host = {
      loadData: jest.fn(async () => data),
      saveData: jest.fn(async (next: Record<string, unknown>) => { data = next; }),
    };
    const protector: SecretProtector = {
      protect: jest.fn(async (value) => `protected:${value}`),
      unprotect: jest.fn(async (value) => value.replace(/^protected:/, '')),
    };
    const store = new WeChatStateStore(host, protector);

    await store.saveCredential({
      accountId: 'bot-1',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      userId: 'user-1',
      token: 'plain-secret',
      connectedAt: '2026-07-16T08:00:00.000Z',
    });

    expect(JSON.stringify(data)).not.toContain('"token":"plain-secret"');
    expect(JSON.stringify(data)).toContain('protected:plain-secret');
    expect(data.tabManagerState).toEqual({ openTabs: [] });
    await expect(store.loadCredential()).resolves.toMatchObject({ token: 'plain-secret' });
  });

  it('keeps a bounded message id history for idempotent capture', async () => {
    let data: Record<string, unknown> = {};
    const host = {
      loadData: jest.fn(async () => data),
      saveData: jest.fn(async (next: Record<string, unknown>) => { data = next; }),
    };
    const protector: SecretProtector = {
      protect: async (value) => value,
      unprotect: async (value) => value,
    };
    const store = new WeChatStateStore(host, protector, 3);

    for (const id of ['1', '2', '3', '4']) await store.markProcessed(id);

    await expect(store.hasProcessed('1')).resolves.toBe(false);
    await expect(store.hasProcessed('4')).resolves.toBe(true);
  });

  it('persists and clears a pending digest draft without touching credentials', async () => {
    let data: Record<string, unknown> = {};
    const host = {
      loadData: jest.fn(async () => data),
      saveData: jest.fn(async (next: Record<string, unknown>) => { data = next; }),
    };
    const protector: SecretProtector = {
      protect: async (value) => value,
      unprotect: async (value) => value,
    };
    const store = new WeChatStateStore(host, protector);
    const draft = {
      id: 'FL-1',
      createdAt: '2026-07-16T08:00:00.000Z',
      proposals: [],
    };

    await store.saveDigestDraft(draft);
    await expect(store.loadDigestDraft()).resolves.toEqual(draft);
    await store.clearDigestDraft();
    await expect(store.loadDigestDraft()).resolves.toBeNull();
  });
});

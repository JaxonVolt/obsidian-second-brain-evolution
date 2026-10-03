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

  it('persists independent conversation mode and pending write confirmation', async () => {
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
    const pending = {
      kind: 'files' as const,
      id: 'QR-ABC123',
      title: '测试',
      summary: '追加内容',
      request: '帮我更新',
      createdAt: '2026-08-09T08:00:00.000Z',
      expiresAt: '2026-08-09T08:30:00.000Z',
      changes: [{ operation: 'append' as const, path: '020_行动系统/a.md', content: 'x' }],
      baselines: [{ path: '020_行动系统/a.md', exists: true, sha256: 'hash' }],
    };

    await store.saveConversationPreferences({ conversationId: 'conv-1', mode: 'deep' });
    await store.savePendingAction(pending);
    await expect(store.loadConversationPreferences()).resolves.toEqual({ conversationId: 'conv-1', mode: 'deep' });
    await expect(store.loadPendingAction()).resolves.toEqual(pending);
    await store.clearPendingAction();
    await expect(store.loadPendingAction()).resolves.toBeNull();
  });

  it('encrypts the proactive-send context and persists butler delivery state', async () => {
    let data: Record<string, unknown> = {};
    const host = {
      loadData: jest.fn(async () => data),
      saveData: jest.fn(async (next: Record<string, unknown>) => { data = next; }),
    };
    const protector: SecretProtector = {
      protect: jest.fn(async (value) => `protected:${value}`),
      unprotect: jest.fn(async (value) => value.replace(/^protected:/, '')),
    };
    const store = new WeChatStateStore(host, protector);

    await store.saveOutboundContext({
      userId: 'user-1',
      contextToken: 'context-secret',
      updatedAt: '2026-08-11T08:00:00.000Z',
    });
    await store.saveButlerDelivery({
      lastSentDate: '2026-08-11',
      lastAttemptAt: '2026-08-11T08:00:01.000Z',
      lastBriefActionIds: ['A-1', 'A-2'],
    });

    expect(JSON.stringify(data)).not.toContain('"contextToken":"context-secret"');
    expect(JSON.stringify(data)).toContain('protected:context-secret');
    await expect(store.loadOutboundContext()).resolves.toEqual({
      userId: 'user-1',
      contextToken: 'context-secret',
      updatedAt: '2026-08-11T08:00:00.000Z',
    });
    await expect(store.loadButlerDelivery()).resolves.toEqual({
      lastSentDate: '2026-08-11',
      lastAttemptAt: '2026-08-11T08:00:01.000Z',
      lastBriefActionIds: ['A-1', 'A-2'],
    });
  });
});

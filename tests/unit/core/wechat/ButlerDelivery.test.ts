import { mutatePluginData } from '../../../../src/core/storage/PluginDataMutation';
import { StorageService } from '../../../../src/core/storage/StorageService';
import { IlinkApiError } from '../../../../src/core/wechat/IlinkClient';
import { WeChatChannelService } from '../../../../src/core/wechat/WeChatChannelService';
import { WeChatStateStore } from '../../../../src/core/wechat/WeChatStateStore';
import type SecondBrainPlugin from '../../../../src/main';

const now = new Date(2026, 8, 17, 20, 0);
function fixture() {
  let data: Record<string, any> = { wechat: {} };
  const host = {
    loadData: jest.fn(async () => JSON.parse(JSON.stringify(data))),
    saveData: jest.fn(async (next: Record<string, unknown>) => { data = JSON.parse(JSON.stringify(next)); }),
  };
  const store = new WeChatStateStore(host);
  jest.spyOn(store, 'loadCredential').mockResolvedValue({ accountId: 'a', baseUrl: 'https://test.invalid', token: 't', userId: 'u', connectedAt: '' });
  jest.spyOn(store, 'loadOutboundContext').mockResolvedValue({ userId: 'u', contextToken: 'c', updatedAt: '' });
  const plugin = {
    settings: { wechatButlerEnabled: true, wechatButlerBriefTime: '08:00', wechatButlerCatchUp: true },
    app: {}, getConversationById: jest.fn(),
  };
  const sendText = jest.fn(async () => undefined);
  const recordAssistant = jest.fn(async () => undefined);
  const make = () => {
    const service = new WeChatChannelService(plugin as unknown as SecondBrainPlugin) as any;
    service.stateStore = store;
    service.client = { sendText };
    service.collaboration = { recordAssistant };
    service.buildButlerBrief = jest.fn(async () => ({ text: 'brief', actionIds: ['a'] }));
    return service;
  };
  return { host, store, plugin, sendText, recordAssistant, make, data: () => data };
}

describe('automatic butler delivery', () => {
  it('coalesces competing triggers and persists success before mirroring', async () => {
    const f = fixture();
    f.recordAssistant.mockImplementation(async () => {
      expect(f.data().wechat.butlerDelivery.lastSentDate).toBe('2026-09-17');
    });
    const service = f.make();
    await Promise.all(Array.from({ length: 8 }, () => service.trySendButlerBrief(now)));
    expect(f.sendText).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 3; i++) await f.make().trySendButlerBrief(now);
    expect(f.sendText).toHaveBeenCalledTimes(1);
    await f.make().trySendButlerBrief(new Date(2026, 8, 18, 9));
    expect(f.sendText).toHaveBeenCalledTimes(2);
  });

  it('does not send if intent cannot be persisted, and recovers the write queue', async () => {
    const f = fixture();
    f.host.saveData.mockRejectedValueOnce(new Error('disk full'));
    await f.make().trySendButlerBrief(now);
    expect(f.sendText).not.toHaveBeenCalled();
    await f.make().trySendButlerBrief(now);
    expect(f.sendText).toHaveBeenCalledTimes(1);
  });

  it('blocks retries across restart when the network outcome is unknown', async () => {
    const f = fixture();
    f.sendText.mockRejectedValueOnce(new Error('timeout'));
    await f.make().trySendButlerBrief(now);
    await f.make().trySendButlerBrief(now);
    expect(f.sendText).toHaveBeenCalledTimes(1);
    expect(f.data().wechat.butlerDelivery.pendingDate).toBe('2026-09-17');
  });

  it('preserves intent when saving success fails after the actual send', async () => {
    const f = fixture();
    f.sendText.mockImplementation(async () => { f.host.saveData.mockRejectedValueOnce(new Error('disk full')); });
    await f.make().trySendButlerBrief(now);
    await f.make().trySendButlerBrief(now);
    expect(f.sendText).toHaveBeenCalledTimes(1);
    expect(f.recordAssistant).not.toHaveBeenCalled();
  });

  it('allows retry after an explicitly rejected stale token', async () => {
    const f = fixture();
    f.sendText.mockRejectedValueOnce(new IlinkApiError('expired', -2));
    await f.make().trySendButlerBrief(now);
    await f.make().trySendButlerBrief(now);
    expect(f.sendText).toHaveBeenCalledTimes(2);
    expect(f.data().wechat.butlerDelivery.lastSentDate).toBe('2026-09-17');
  });

  it('repairs an old sent date using the existing same-day assistant brief', async () => {
    const f = fixture();
    await f.store.saveConversationPreferences({ conversationId: 'c' } as any);
    f.plugin.getConversationById.mockResolvedValue({ messages: [{ role: 'assistant', content: '早上好，2026-09-17 的管家简报。', timestamp: now.getTime() }] });
    await f.make().trySendButlerBrief(now);
    expect(f.sendText).not.toHaveBeenCalled();
    expect(f.data().wechat.butlerDelivery.lastSentDate).toBe('2026-09-17');
  });

  it('respects the configured time and disabled catch-up', async () => {
    const f = fixture();
    await f.make().trySendButlerBrief(new Date(2026, 8, 17, 7));
    f.plugin.settings.wechatButlerCatchUp = false;
    await f.make().trySendButlerBrief(now);
    expect(f.sendText).not.toHaveBeenCalled();
    await f.make().trySendButlerBrief(new Date(2026, 8, 17, 8));
    expect(f.sendText).toHaveBeenCalledTimes(1);
  });

  it('serializes tab state and WeChat writes without losing either update', async () => {
    const f = fixture();
    const tabs = { openTabs: [], activeTabId: null };
    await Promise.all([
      f.store.saveButlerDelivery({ lastSentDate: '2026-09-17' }),
      StorageService.prototype.setTabManagerState.call({ plugin: f.host } as any, tabs),
      f.store.saveCursor('next'),
    ]);
    expect(f.data()).toMatchObject({ tabManagerState: tabs, wechat: { cursor: 'next', butlerDelivery: { lastSentDate: '2026-09-17' } } });
    f.host.saveData.mockRejectedValueOnce(new Error('temporary'));
    await expect(mutatePluginData(f.host, () => undefined)).rejects.toThrow('temporary');
    await f.store.saveCursor('recovered');
    expect(f.data().wechat.cursor).toBe('recovered');
  });
});

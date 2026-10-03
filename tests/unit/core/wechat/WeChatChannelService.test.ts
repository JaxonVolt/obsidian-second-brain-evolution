import {
  extractWechatText,
  getWechatMessageKey,
  splitWechatReply,
  WeChatChannelService,
} from '../../../../src/core/wechat/WeChatChannelService';
import {
  classifyWeChatIntent,
  parseWeChatCollaborationCommand,
} from '../../../../src/core/wechat/WeChatCollaborationService';
import type SecondBrainPlugin from '../../../../src/main';

describe('WeChatChannelService helpers', () => {
  it('extracts text and voice transcription without interpreting it', () => {
    expect(extractWechatText({ item_list: [
      { type: 1, text_item: { text: '今天完成了巡检' } },
      { type: 3, voice_item: { text: '明天复查变频器' } },
    ] })).toBe('今天完成了巡检\n\n[语音转文字]\n明天复查变频器');
  });

  it('preserves quoted text and recognizable shared-card fields', () => {
    expect(extractWechatText({ item_list: [
      {
        type: 1,
        text_item: { text: '我的补充' },
        ref_msg: { title: '原消息', message_item: { type: 1, text_item: { text: '被引用的内容' } } },
      },
      {
        type: 49,
        app_item: {
          title: '一篇公众号文章',
          desc: '文章摘要',
          url: 'https://mp.weixin.qq.com/s/example',
        },
      },
    ] })).toBe([
      '[引用]\n原消息\n被引用的内容\n我的补充',
      '[微信分享卡片]\n一篇公众号文章\n文章摘要\nhttps://mp.weixin.qq.com/s/example',
    ].join('\n\n'));
  });

  it('prefers the stable server message id for deduplication', () => {
    expect(getWechatMessageKey({ message_id: 42, item_list: [] })).toBe('42');
  });

  it('splits long replies at paragraph boundaries without losing content', () => {
    const source = `${'甲'.repeat(1000)}\n\n${'乙'.repeat(1000)}`;
    const chunks = splitWechatReply(source, 1200);
    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => chunk.length <= 1200)).toBe(true);
    expect(chunks.join('')).toBe(source.replace(/\n\n/u, ''));
  });

  it('routes all ordinary natural-language inputs into collaboration', () => {
    for (const input of [
      '在学习课程记录中新建一个文件夹叫变频器',
      '我今天有什么事情要做',
      '今天看完了接触器课程',
    ]) {
      expect(classifyWeChatIntent(input)).toMatchObject({ kind: 'chat', forced: false });
    }
  });

  it('mirrors each successfully sent logical reply into the fixed desktop conversation', async () => {
    const service = new WeChatChannelService({ app: {} } as unknown as SecondBrainPlugin);
    const sendText = jest.fn(async (_payload: { text: string }) => undefined);
    const recordAssistant = jest.fn(async () => undefined);
    (service as any).client = { sendText };
    (service as any).collaboration = { recordAssistant };

    await (service as any).sendReplies({
      baseUrl: 'https://example.test',
      token: 'token',
      userId: 'user',
    }, 'context', ['第一条回复', '第二条回复']);

    expect(sendText).toHaveBeenCalledTimes(2);
    expect(recordAssistant).toHaveBeenNthCalledWith(1, '第一条回复', expect.any(Date));
    expect(recordAssistant).toHaveBeenNthCalledWith(2, '第二条回复', expect.any(Date));
  });

  it('answers an on-demand butler brief locally and mirrors it without invoking an agent', async () => {
    const action = {
      id: 'A-1', title: '完成今天的安全培训记录', status: 'today', priority: 'high', dueDate: '', reminderAt: '',
      project: '', note: '', sourcePath: '', recurrence: '', createdAt: '', updatedAt: '', completedAt: '',
      previousStatus: 'today', path: '',
    };
    const plugin = {
      app: {},
      settings: { wechatButlerMaxItems: 8, wechatButlerIncludeInsights: false },
      actionWorkbenchService: {
        getBrief: jest.fn(async () => ({ today: [action], overdue: [], upcoming: [], waiting: [] })),
        listActions: jest.fn(async () => [action]),
      },
    } as unknown as SecondBrainPlugin;
    const service = new WeChatChannelService(plugin);
    const sendText = jest.fn(async (_payload: { text: string }) => undefined);
    const recordAssistant = jest.fn(async () => undefined);
    (service as any).client = { sendText };
    (service as any).collaboration = { recordAssistant };

    const command = parseWeChatCollaborationCommand('管家简报');
    expect(command).toEqual({ kind: 'butler-brief' });
    await (service as any).processCollaborationCommandSafely(
      command,
      '管家简报',
      { context_token: 'context' },
      { baseUrl: 'https://example.test', token: 'token', userId: 'user' },
      new Date(2026, 7, 25, 7, 50),
    );

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText.mock.calls[0][0].text).toContain('2026-08-25 的管家简报');
    expect(sendText.mock.calls[0][0].text).toContain('完成今天的安全培训记录');
    expect(recordAssistant).toHaveBeenCalledWith(expect.stringContaining('今天的任务'), expect.any(Date));
    expect((service as any).collaboration.runChat).toBeUndefined();
  });

  it('applies natural butler feedback by brief number without invoking an agent', async () => {
    const updateAction = jest.fn(async () => undefined);
    const completeAction = jest.fn(async () => undefined);
    const plugin = {
      app: {},
      actionWorkbenchService: {
        listActions: jest.fn(async () => [
          { id: 'A-1', title: '复刻贾维斯最小功能', status: 'planned' },
          { id: 'A-2', title: '完成接触器验收', status: 'today' },
        ]),
        updateAction,
        completeAction,
      },
    } as unknown as SecondBrainPlugin;
    const service = new WeChatChannelService(plugin);
    (service as any).stateStore = {
      loadButlerDelivery: jest.fn(async () => ({ lastBriefActionIds: ['A-1', 'A-2'] })),
    };

    await expect((service as any).tryHandleButlerFeedback('第2项完成，第一项推迟到明天', new Date(2026, 7, 11, 9, 0)))
      .resolves.toContain('电脑端行动工作台已同步');
    expect(completeAction).toHaveBeenCalledWith('A-2', expect.any(Date));
    expect(updateAction).toHaveBeenCalledWith('A-1', { dueDate: '2026-08-12', status: 'planned' }, expect.any(Date));
  });

  it('tries startup catch-up once instead of retrying every few seconds', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(2026, 7, 11, 9, 0, 0));
    Object.defineProperty(globalThis, 'window', { configurable: true, value: globalThis });
    const plugin = {
      app: {},
      settings: {
        wechatButlerEnabled: true,
        wechatButlerBriefTime: '08:00',
        wechatButlerCatchUp: true,
      },
    } as unknown as SecondBrainPlugin;
    const service = new WeChatChannelService(plugin);
    (service as any).controller = { signal: { aborted: false } };
    const attempt = jest.spyOn(service as any, 'trySendButlerBrief').mockResolvedValue(false);

    (service as any).scheduleButlerBrief();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(attempt).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
    delete (globalThis as { window?: unknown }).window;
  });

  it('separates today from other high and medium priority actions without duplicates', async () => {
    const todayHigh = { id: 'A-1', title: '今天高优先事项', status: 'today', priority: 'high', dueDate: '', reminderAt: '', project: '', note: '', sourcePath: '', recurrence: '', createdAt: '', updatedAt: '', completedAt: '', previousStatus: 'today', path: '' };
    const todayLow = { ...todayHigh, id: 'A-2', title: '今天低优先事项', priority: 'low' };
    const plannedHigh = { ...todayHigh, id: 'A-3', title: '计划中的高优先事项', status: 'planned', priority: 'high' };
    const inboxMedium = { ...todayHigh, id: 'A-4', title: '收集箱普通事项', status: 'inbox', priority: 'medium' };
    const waitingLow = { ...todayHigh, id: 'A-5', title: '等待中的低优先事项', status: 'waiting', priority: 'low' };
    const duplicateTitle = { ...todayHigh, id: 'A-6', title: '今天高优先事项', status: 'planned', priority: 'high' };
    const completedHigh = { ...todayHigh, id: 'A-7', title: '已经完成的高优先事项', status: 'completed', priority: 'high' };
    const plugin = {
      app: {},
      settings: { wechatButlerMaxItems: 8, wechatButlerIncludeInsights: false },
      actionWorkbenchService: {
        getBrief: jest.fn(async () => ({ today: [todayLow, todayHigh, todayHigh], overdue: [], upcoming: [], waiting: [] })),
        listActions: jest.fn(async () => [todayHigh, todayLow, plannedHigh, inboxMedium, waitingLow, duplicateTitle, completedHigh]),
      },
    } as unknown as SecondBrainPlugin;
    const service = new WeChatChannelService(plugin);

    const result = await (service as any).buildButlerBrief(new Date(2026, 7, 12, 8, 0));

    expect(result.text).toContain('今天的任务：\n1. 今天高优先事项（高）\n2. 今天低优先事项（低）');
    expect(result.text).toContain('其他高、普通优先级行动：\n3. 计划中的高优先事项（高 · 计划中）\n4. 收集箱普通事项（普通 · 收集箱）');
    expect(result.text).not.toContain('最近');
    expect(result.text).not.toContain('等待中的低优先事项');
    expect(result.text).not.toContain('已经完成的高优先事项');
    expect(result.text.match(/今天高优先事项/gu)).toHaveLength(1);
    expect(result.actionIds).toEqual(['A-1', 'A-2', 'A-3', 'A-4']);
  });

  it('uses remaining brief capacity after today and reports omitted actions', async () => {
    const action = (id: string, title: string, status: 'today' | 'planned', priority: 'high' | 'medium') => ({
      id, title, status, priority, dueDate: '', reminderAt: '', project: '', note: '', sourcePath: '', recurrence: '', createdAt: '', updatedAt: '', completedAt: '', previousStatus: status, path: '',
    });
    const today = action('A-1', '今天任务', 'today', 'medium');
    const high = action('A-2', '高优先事项', 'planned', 'high');
    const medium = action('A-3', '普通优先事项', 'planned', 'medium');
    const plugin = {
      app: {},
      settings: { wechatButlerMaxItems: 2, wechatButlerIncludeInsights: false },
      actionWorkbenchService: {
        getBrief: jest.fn(async () => ({ today: [today], overdue: [], upcoming: [], waiting: [] })),
        listActions: jest.fn(async () => [today, medium, high]),
      },
    } as unknown as SecondBrainPlugin;
    const service = new WeChatChannelService(plugin);

    const result = await (service as any).buildButlerBrief(new Date(2026, 7, 12, 8, 0));

    expect(result.actionIds).toEqual(['A-1', 'A-2']);
    expect(result.text).toContain('2. 高优先事项（高 · 计划中）');
    expect(result.text).toContain('另有 1 项未展示（已达到简报行动上限）');
  });
});

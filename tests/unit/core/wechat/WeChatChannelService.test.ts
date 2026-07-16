import { extractWechatText, getWechatMessageKey } from '../../../../src/core/wechat/WeChatChannelService';

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
});

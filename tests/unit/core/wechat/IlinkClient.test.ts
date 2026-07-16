import { requestUrl } from 'obsidian';

import { IlinkClient } from '../../../../src/core/wechat/IlinkClient';

describe('IlinkClient', () => {
  beforeEach(() => {
    jest.mocked(requestUrl).mockReset();
  });

  it('uses the Obsidian network API by default to avoid renderer CORS restrictions', async () => {
    jest.mocked(requestUrl).mockResolvedValue({
      status: 200,
      text: JSON.stringify({ qrcode: 'qr-id', qrcode_img_content: 'https://example.test/qr' }),
      json: {},
      arrayBuffer: new ArrayBuffer(0),
      headers: {},
    });

    const result = await new IlinkClient().startQrLogin();

    expect(result.qrcode).toBe('qr-id');
    expect(requestUrl).toHaveBeenCalledWith(expect.objectContaining({
      method: 'POST',
      url: expect.stringContaining('/ilink/bot/get_bot_qrcode'),
    }));
  });

  it('starts QR login without an agent runtime dependency', async () => {
    const fetchFn = jest.fn(async (_url: string, init?: RequestInit) => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        qrcode: 'qr-id',
        qrcode_img_content: 'https://example.test/qr',
      }),
      requestInit: init,
    })) as unknown as typeof fetch;
    const client = new IlinkClient(fetchFn);

    const result = await client.startQrLogin();

    expect(result.qrcode).toBe('qr-id');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchFn as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/ilink/bot/get_bot_qrcode?bot_type=3');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ local_token_list: [] });
    expect((init.headers as Record<string, string>)['iLink-App-Id']).toBe('bot');
  });

  it('sends the cursor and a neutral second-brain agent identity when polling', async () => {
    const fetchFn = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ret: 0, msgs: [], get_updates_buf: 'next' }),
    })) as unknown as typeof fetch;
    const client = new IlinkClient(fetchFn);

    const response = await client.getUpdates({
      baseUrl: 'https://ilinkai.weixin.qq.com',
      token: 'secret',
      cursor: 'previous',
    });

    expect(response.get_updates_buf).toBe('next');
    const [, init] = (fetchFn as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      get_updates_buf: 'previous',
      base_info: {
        channel_version: '2.4.6',
        bot_agent: 'SecondBrain/3.3.0',
      },
    });
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret');
  });

  it('echoes the inbound context token in an acknowledgement', async () => {
    const fetchFn = jest.fn(async () => ({ ok: true, status: 200, text: async () => '{"ret":0}' })) as unknown as typeof fetch;
    const client = new IlinkClient(fetchFn);

    await client.sendText({
      baseUrl: 'https://ilinkai.weixin.qq.com',
      token: 'secret',
      toUserId: 'user-1',
      contextToken: 'context-1',
      text: '已收录',
    });

    const [, init] = (fetchFn as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).msg).toMatchObject({
      to_user_id: 'user-1',
      context_token: 'context-1',
      message_type: 2,
      message_state: 2,
      item_list: [{ type: 1, text_item: { text: '已收录' } }],
    });
  });
});

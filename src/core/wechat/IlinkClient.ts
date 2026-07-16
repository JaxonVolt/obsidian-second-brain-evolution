import { randomBytes } from 'crypto';
import { requestUrl } from 'obsidian';

import {
  ILINK_API_BASE_URL,
  ILINK_BOT_TYPE,
  ILINK_CHANNEL_VERSION,
  type IlinkQrStartResponse,
  type IlinkQrStatusResponse,
  type IlinkUpdatesResponse,
} from './types';

const ILINK_APP_ID = 'bot';
const ILINK_CLIENT_VERSION = (2 << 16) | (4 << 8) | 6;
const BOT_AGENT = 'SecondBrain/3.3.0';

interface RequestOptions {
  baseUrl: string;
  endpoint: string;
  method: 'GET' | 'POST';
  token?: string;
  body?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class IlinkApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'IlinkApiError';
  }
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function randomWechatUin(): string {
  const value = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(value), 'utf8').toString('base64');
}

function buildBaseInfo(): { channel_version: string; bot_agent: string } {
  return {
    channel_version: ILINK_CHANNEL_VERSION,
    bot_agent: BOT_AGENT,
  };
}

function abortError(): Error {
  const error = new Error('Request aborted');
  error.name = 'AbortError';
  return error;
}

function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); },
    );
  });
}

export class IlinkClient {
  constructor(private fetchFn?: typeof fetch) {}

  async startQrLogin(): Promise<IlinkQrStartResponse> {
    return this.request<IlinkQrStartResponse>({
      baseUrl: ILINK_API_BASE_URL,
      endpoint: `ilink/bot/get_bot_qrcode?bot_type=${ILINK_BOT_TYPE}`,
      method: 'POST',
      body: { local_token_list: [] },
      timeoutMs: 15_000,
    });
  }

  async pollQrStatus(params: {
    qrcode: string;
    verifyCode?: string;
    baseUrl?: string;
    signal?: AbortSignal;
  }): Promise<IlinkQrStatusResponse> {
    let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(params.qrcode)}`;
    if (params.verifyCode) endpoint += `&verify_code=${encodeURIComponent(params.verifyCode)}`;
    try {
      return await this.request<IlinkQrStatusResponse>({
        baseUrl: params.baseUrl ?? ILINK_API_BASE_URL,
        endpoint,
        method: 'GET',
        timeoutMs: 35_000,
        signal: params.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError' && !params.signal?.aborted) {
        return { status: 'wait' };
      }
      throw error;
    }
  }

  async getUpdates(params: {
    baseUrl: string;
    token: string;
    cursor: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<IlinkUpdatesResponse> {
    try {
      return await this.request<IlinkUpdatesResponse>({
        baseUrl: params.baseUrl,
        endpoint: 'ilink/bot/getupdates',
        method: 'POST',
        token: params.token,
        body: {
          get_updates_buf: params.cursor,
          base_info: buildBaseInfo(),
        },
        timeoutMs: params.timeoutMs ?? 35_000,
        signal: params.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError' && !params.signal?.aborted) {
        return { ret: 0, msgs: [], get_updates_buf: params.cursor };
      }
      throw error;
    }
  }

  async sendText(params: {
    baseUrl: string;
    token: string;
    toUserId: string;
    contextToken: string;
    text: string;
  }): Promise<void> {
    const response = await this.request<{ ret?: number; errmsg?: string }>({
      baseUrl: params.baseUrl,
      endpoint: 'ilink/bot/sendmessage',
      method: 'POST',
      token: params.token,
      timeoutMs: 15_000,
      body: {
        msg: {
          from_user_id: '',
          to_user_id: params.toUserId,
          client_id: `second-brain:${Date.now()}-${randomBytes(4).toString('hex')}`,
          message_type: 2,
          message_state: 2,
          item_list: [{ type: 1, text_item: { text: params.text } }],
          context_token: params.contextToken,
        },
        base_info: buildBaseInfo(),
      },
    });
    if (response.ret && response.ret !== 0) {
      throw new IlinkApiError(`微信回复失败：${response.errmsg ?? response.ret}`);
    }
  }

  async notifyStart(baseUrl: string, token: string): Promise<void> {
    await this.request({
      baseUrl,
      endpoint: 'ilink/bot/msg/notifystart',
      method: 'POST',
      token,
      body: { base_info: buildBaseInfo() },
      timeoutMs: 10_000,
    });
  }

  async notifyStop(baseUrl: string, token: string): Promise<void> {
    await this.request({
      baseUrl,
      endpoint: 'ilink/bot/msg/notifystop',
      method: 'POST',
      token,
      body: { base_info: buildBaseInfo() },
      timeoutMs: 10_000,
    });
  }

  private async request<T>(options: RequestOptions): Promise<T> {
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onExternalAbort, { once: true });
    if (options.signal?.aborted) controller.abort();
    const timer = options.timeoutMs
      ? setTimeout(() => controller.abort(), options.timeoutMs)
      : undefined;
    const headers: Record<string, string> = {
      'iLink-App-Id': ILINK_APP_ID,
      'iLink-App-ClientVersion': String(ILINK_CLIENT_VERSION),
    };
    if (options.method === 'POST') {
      headers['Content-Type'] = 'application/json';
      headers.AuthorizationType = 'ilink_bot_token';
      headers['X-WECHAT-UIN'] = randomWechatUin();
    }
    if (options.token) headers.Authorization = `Bearer ${options.token.trim()}`;

    try {
      const url = new URL(options.endpoint, ensureTrailingSlash(options.baseUrl));
      const body = options.body === undefined ? undefined : JSON.stringify(options.body);
      let status: number;
      let text: string;
      if (this.fetchFn) {
        const response = await this.fetchFn(url.toString(), {
          method: options.method,
          headers,
          body,
          signal: controller.signal,
        });
        status = response.status;
        text = await response.text();
      } else {
        const response = await awaitWithAbort(requestUrl({
          url: url.toString(),
          method: options.method,
          headers,
          body,
          throw: false,
        }), controller.signal);
        status = response.status;
        text = response.text;
      }
      if (status < 200 || status >= 300) throw new IlinkApiError(`iLink 请求失败（${status}）`, status);
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new IlinkApiError('iLink 返回了无法识别的数据。');
      }
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onExternalAbort);
    }
  }
}

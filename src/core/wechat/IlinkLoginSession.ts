import type { IlinkClient } from './IlinkClient';
import { ILINK_API_BASE_URL, type IlinkQrStatusResponse } from './types';

export class IlinkLoginSession {
  private qrcode = '';
  private pollingBaseUrl = ILINK_API_BASE_URL;
  qrcodeUrl = '';

  constructor(private client: IlinkClient) {}

  async start(): Promise<void> {
    const response = await this.client.startQrLogin();
    if (!response.qrcode || !response.qrcode_img_content) throw new Error('微信没有返回可用的连接二维码。');
    this.qrcode = response.qrcode;
    this.qrcodeUrl = response.qrcode_img_content;
  }

  async poll(verifyCode?: string, signal?: AbortSignal): Promise<IlinkQrStatusResponse> {
    if (!this.qrcode) throw new Error('请先生成连接二维码。');
    const response = await this.client.pollQrStatus({
      qrcode: this.qrcode,
      verifyCode,
      baseUrl: this.pollingBaseUrl,
      signal,
    });
    if (response.status === 'scaned_but_redirect' && response.redirect_host) {
      this.pollingBaseUrl = `https://${response.redirect_host}`;
    }
    return response;
  }
}

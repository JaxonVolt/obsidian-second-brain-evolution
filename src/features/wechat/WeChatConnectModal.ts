import { Modal, Notice, Setting } from 'obsidian';
import * as QRCode from 'qrcode';

import type { IlinkLoginSession } from '../../core/wechat/IlinkLoginSession';
import type { IlinkQrStatusResponse } from '../../core/wechat/types';
import type SecondBrainPlugin from '../../main';

export class WeChatConnectModal extends Modal {
  private controller = new AbortController();
  private session: IlinkLoginSession | null = null;
  private statusEl: HTMLElement;
  private verifyEl: HTMLElement;

  constructor(
    app: SecondBrainPlugin['app'],
    private plugin: SecondBrainPlugin,
    private onConnected?: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass('second-brain-wechat-modal');
    this.titleEl.setText('连接微信第二大脑');
    this.contentEl.empty();
    this.contentEl.createEl('p', {
      cls: 'second-brain-wechat-intro',
      text: '使用手机微信扫码。凭据只会加密保存在这台 Windows 电脑上。',
    });
    this.statusEl = this.contentEl.createDiv({ cls: 'second-brain-wechat-status', text: '正在生成二维码…' });
    this.verifyEl = this.contentEl.createDiv({ cls: 'second-brain-wechat-verify' });
    void this.begin();
  }

  onClose(): void {
    this.controller.abort();
    this.contentEl.empty();
  }

  private async begin(): Promise<void> {
    try {
      this.session = this.plugin.weChatService.createLoginSession();
      await this.session.start();
      const dataUrl = await QRCode.toDataURL(this.session.qrcodeUrl, {
        width: 248,
        margin: 1,
        errorCorrectionLevel: 'M',
      });
      const qrWrap = this.contentEl.createDiv({ cls: 'second-brain-wechat-qr' });
      qrWrap.createEl('img', { attr: { src: dataUrl, alt: '微信连接二维码' } });
      this.statusEl.setText('请打开微信“扫一扫”，并在手机上确认连接。');
      await this.poll();
    } catch (error) {
      if (!this.controller.signal.aborted) this.showError(error);
    }
  }

  private async poll(verifyCode?: string): Promise<void> {
    if (!this.session || this.controller.signal.aborted) return;
    try {
      while (!this.controller.signal.aborted) {
        const response = await this.session.poll(verifyCode, this.controller.signal);
        verifyCode = undefined;
        if (await this.handleStatus(response)) return;
        await new Promise((resolve) => window.setTimeout(resolve, 800));
      }
    } catch (error) {
      if (!this.controller.signal.aborted) this.showError(error);
    }
  }

  private async handleStatus(response: IlinkQrStatusResponse): Promise<boolean> {
    switch (response.status) {
      case 'wait':
        return false;
      case 'scaned':
        this.statusEl.setText('二维码已扫描，正在等待手机确认。');
        return false;
      case 'scaned_but_redirect':
        this.statusEl.setText('正在切换到微信分配的连接节点。');
        return false;
      case 'need_verifycode':
        this.statusEl.setText('微信要求核对数字，请输入手机上显示的验证码。');
        this.renderVerifyInput();
        return true;
      case 'verify_code_blocked':
        this.statusEl.setText('验证码错误次数过多，请稍后重新生成二维码。');
        return true;
      case 'expired':
        this.statusEl.setText('二维码已经过期，请关闭窗口后重新连接。');
        return true;
      case 'binded_redirect':
        if (await this.plugin.weChatService.hasCredential()) {
          await this.plugin.weChatService.start();
          new Notice('微信 Bot 已经连接。');
          this.onConnected?.();
          this.close();
        } else {
          this.statusEl.setText('微信提示已经绑定，但本机没有凭据。请先在原设备断开后重试。');
        }
        return true;
      case 'confirmed':
        await this.plugin.weChatService.completeLogin(response);
        new Notice('微信第二大脑已经连接并开始接收消息。');
        this.onConnected?.();
        this.close();
        return true;
    }
  }

  private renderVerifyInput(): void {
    this.verifyEl.empty();
    let value = '';
    new Setting(this.verifyEl)
      .setName('手机验证码')
      .setDesc('只输入微信页面显示的数字。')
      .addText((text) => {
        text.setPlaceholder('输入数字').onChange((next) => { value = next.trim(); });
        text.inputEl.inputMode = 'numeric';
        window.setTimeout(() => text.inputEl.focus(), 0);
      })
      .addButton((button) => button
        .setButtonText('继续连接')
        .setCta()
        .onClick(() => {
          if (!/^\d+$/.test(value)) {
            new Notice('请输入手机上显示的数字验证码。');
            return;
          }
          this.verifyEl.empty();
          this.statusEl.setText('正在核对验证码。');
          void this.poll(value);
        }));
  }

  private showError(error: unknown): void {
    this.statusEl.setText(error instanceof Error ? error.message : '微信连接失败，请稍后重试。');
    this.statusEl.addClass('is-error');
  }
}

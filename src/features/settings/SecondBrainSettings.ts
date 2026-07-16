import * as fs from 'fs';
import type { App } from 'obsidian';
import { PluginSettingTab, Setting } from 'obsidian';

import { CODEX_PERFORMANCE_PROFILES, type CodexPerformanceMode, getHostnameKey } from '../../core/types';
import type SecondBrainPlugin from '../../main';
import { expandHomePath } from '../../utils/path';
import { WeChatConnectModal } from '../wechat/WeChatConnectModal';

export class SecondBrainSettingTab extends PluginSettingTab {
  constructor(app: App, private secondBrainPlugin: SecondBrainPlugin) {
    super(app, secondBrainPlugin);
  }

  display(): void {
    const container = this.containerEl;
    container.empty();

    new Setting(container).setName('第二大脑设置').setHeading();
    new Setting(container)
      .setName('运行引擎')
      .setDesc('固定使用本机 Codex CLI，不会调用其他智能引擎。')
      .addText((text) => text.setValue('Codex').setDisabled(true));

    new Setting(container)
      .setName('响应通道')
      .setDesc('快速适合日常问答和收件箱分流；深度适合复杂分析。')
      .addDropdown((dropdown) => {
        for (const [mode, profile] of Object.entries(CODEX_PERFORMANCE_PROFILES)) {
          dropdown.addOption(mode, `${profile.label} · ${profile.model}`);
        }
        dropdown
          .setValue(this.secondBrainPlugin.settings.codexPerformanceMode ?? 'fast')
          .onChange(async (value) => {
            const mode = value as CodexPerformanceMode;
            const profile = CODEX_PERFORMANCE_PROFILES[mode];
            this.secondBrainPlugin.settings.codexPerformanceMode = mode;
            this.secondBrainPlugin.settings.codexModel = profile.model;
            this.secondBrainPlugin.settings.codexReasoningEffort = profile.reasoningEffort;
            this.secondBrainPlugin.settings.codexPlanModeReasoningEffort = profile.reasoningEffort;
            await this.secondBrainPlugin.saveSettings();
            this.secondBrainPlugin.getView()?.refreshModelSelector();
          });
      });

    const hostname = getHostnameKey();
    const currentPath = this.secondBrainPlugin.settings.codexCliPathsByHost?.[hostname] ?? '';
    const pathSetting = new Setting(container)
      .setName(`Codex CLI 路径（${hostname}）`)
      .setDesc('一般留空自动检测；只有自动检测失败时才填写 codex.exe 的完整路径。');
    pathSetting.addText((text) => {
      text
        .setPlaceholder('C:\\Users\\用户名\\AppData\\Roaming\\npm\\codex.exe')
        .setValue(currentPath)
        .onChange(async (value) => {
          const trimmed = value.trim();
          if (trimmed && (!fs.existsSync(expandHomePath(trimmed)) || !fs.statSync(expandHomePath(trimmed)).isFile())) {
            text.inputEl.style.borderColor = 'var(--text-error)';
            return;
          }
          text.inputEl.style.borderColor = '';
          this.secondBrainPlugin.settings.codexCliPathsByHost ??= {};
          this.secondBrainPlugin.settings.codexCliPathsByHost[hostname] = trimmed;
          await this.secondBrainPlugin.saveSettings();
        });
    });

    const detected = this.secondBrainPlugin.getResolvedCodexCliPath();
    new Setting(container)
      .setName('当前检测结果')
      .setDesc(detected ? `已找到：${detected}` : '尚未找到 Codex CLI。请确认已安装并登录。');

    new Setting(container).setName('微信远程入口').setHeading();
    const wechatContainer = container.createDiv({ cls: 'second-brain-wechat-settings' });
    void this.renderWechatSettings(wechatContainer);
  }

  private async renderWechatSettings(container: HTMLElement): Promise<void> {
    container.empty();
    const status = this.secondBrainPlugin.weChatService.getStatus();
    const hasCredential = await this.secondBrainPlugin.weChatService.hasCredential();

    new Setting(container)
      .setName('当前状态')
      .setDesc(status.detail)
      .addText((text) => text.setValue(status.state).setDisabled(true));

    new Setting(container)
      .setName('开机后自动接收')
      .setDesc('Obsidian 启动后自动连接；电脑关机时无法接收。')
      .addToggle((toggle) => toggle
        .setValue(this.secondBrainPlugin.settings.wechatAutoStart)
        .onChange(async (value) => {
          this.secondBrainPlugin.settings.wechatAutoStart = value;
          await this.secondBrainPlugin.saveSettings();
          if (value && hasCredential) await this.secondBrainPlugin.weChatService.start();
          if (!value) await this.secondBrainPlugin.weChatService.stop();
          await this.renderWechatSettings(container);
        }));

    new Setting(container)
      .setName('接收图片和文件')
      .setDesc('附件解密后保存在“010_收件箱/微信附件”，不发送给其他服务。')
      .addToggle((toggle) => toggle
        .setValue(this.secondBrainPlugin.settings.wechatCaptureMedia)
        .onChange(async (value) => {
          this.secondBrainPlugin.settings.wechatCaptureMedia = value;
          await this.secondBrainPlugin.saveSettings();
        }));

    new Setting(container)
      .setName('单个附件上限')
      .setDesc('允许 1–100 MB；默认 30 MB。')
      .addText((text) => text
        .setValue(String(this.secondBrainPlugin.settings.wechatMaxAttachmentMB))
        .onChange(async (value) => {
          const parsed = Number(value);
          if (!Number.isFinite(parsed) || parsed < 1 || parsed > 100) {
            text.inputEl.addClass('is-invalid');
            return;
          }
          text.inputEl.removeClass('is-invalid');
          this.secondBrainPlugin.settings.wechatMaxAttachmentMB = Math.round(parsed);
          await this.secondBrainPlugin.saveSettings();
        }));

    new Setting(container)
      .setName('微信端消化与归位')
      .setDesc('发送“消化这批”生成建议；可按序号修改，发送“确认归位”后才会写入笔记。建议保留 24 小时。');

    new Setting(container)
      .setName('转发消息兼容性')
      .setDesc('可解析 iLink 下发的引用文字和引用附件。公众号文章、小程序等转发卡片可能不会被微信通道下发，请改发链接或截图。');

    const controls = new Setting(container)
      .setName(hasCredential ? '微信 Bot 控制' : '创建微信 Bot')
      .setDesc(hasCredential
        ? '连接凭据已使用 Windows 当前用户加密保存。'
        : '扫码后会创建独立微信 Bot，不会读取你的其他微信聊天。');

    if (!hasCredential) {
      controls.addButton((button) => button
        .setButtonText('扫码连接')
        .setCta()
        .onClick(() => new WeChatConnectModal(this.app, this.secondBrainPlugin, () => this.display()).open()));
      return;
    }

    controls.addButton((button) => button
      .setButtonText(this.secondBrainPlugin.weChatService.isRunning() ? '停止接收' : '开始接收')
      .onClick(async () => {
        if (this.secondBrainPlugin.weChatService.isRunning()) await this.secondBrainPlugin.weChatService.stop();
        else await this.secondBrainPlugin.weChatService.start();
        await this.renderWechatSettings(container);
      }));
    controls.addButton((button) => button
      .setButtonText('断开并清除')
      .setWarning()
      .onClick(async () => {
        await this.secondBrainPlugin.weChatService.disconnect();
        await this.renderWechatSettings(container);
      }));
  }
}

import * as fs from 'fs';
import type { App } from 'obsidian';
import { Notice, PluginSettingTab, requestUrl, Setting } from 'obsidian';

import {
  CODEX_MODEL_PROVIDER_LABELS,
  extractModelIds,
  getConfiguredModel,
  getModelProviderModelsEndpoint,
} from '../../core/model';
import {
  CODEX_PERFORMANCE_PROFILES,
  type CodexModelProvider,
  type CodexPerformanceMode,
  getHostnameKey,
} from '../../core/types';
import type SecondBrainPlugin from '../../main';
import { parseEnvironmentVariables } from '../../utils/env';
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
      .setName('知识库骨架')
      .setDesc('检查并补建通用目录、入口和模板；已有文件不会被覆盖。')
      .addButton((button) => button
        .setButtonText('检查与初始化')
        .onClick(() => this.secondBrainPlugin.openKnowledgeInitializer()));

    new Setting(container).setName('模型与推理').setHeading();
    const modelSettingsContainer = container.createDiv({ cls: 'second-brain-model-settings' });
    this.renderModelSettings(modelSettingsContainer);

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

  private renderModelSettings(container: HTMLElement): void {
    container.empty();
    const settings = this.secondBrainPlugin.settings;
    const provider = settings.codexModelProvider ?? 'codex';

    new Setting(container)
      .setName('模型提供商')
      .setDesc('统一由本机 Codex CLI 执行工具和知识工作流；模型可来自 Codex、Ollama、LM Studio 或自定义接口。')
      .addDropdown((dropdown) => {
        for (const [value, label] of Object.entries(CODEX_MODEL_PROVIDER_LABELS)) {
          dropdown.addOption(value, label);
        }
        dropdown.setValue(provider).onChange(async (value) => {
          settings.codexModelProvider = value as CodexModelProvider;
          this.syncConfiguredModels();
          await this.secondBrainPlugin.saveSettings();
          this.secondBrainPlugin.getView()?.refreshModelSelector();
          this.renderModelSettings(container);
        });
      });

    if (provider === 'ollama' || provider === 'lmstudio') {
      const endpoint = provider === 'ollama'
        ? 'http://127.0.0.1:11434'
        : 'http://127.0.0.1:1234';
      new Setting(container)
        .setName('本地服务地址')
        .setDesc('使用 Codex CLI 内置的本地提供商配置。需要自定义端口时，请选择“自定义 Responses API”。')
        .addText((text) => text.setValue(endpoint).setDisabled(true));
    }

    if (provider === 'custom') {
      new Setting(container)
        .setName('API 基础地址')
        .setDesc('必须实现 OpenAI Responses API，例如 https://example.com/v1；地址中不要包含密钥。')
        .addText((text) => text
          .setPlaceholder('https://example.com/v1')
          .setValue(settings.codexProviderBaseUrl ?? '')
          .onChange(async (value) => {
            settings.codexProviderBaseUrl = value.trim();
            await this.secondBrainPlugin.saveSettings();
          }));

      new Setting(container)
        .setName('API 密钥环境变量')
        .setDesc('填写变量名而不是密钥，例如 OPENAI_API_KEY。留空表示接口不需要鉴权。')
        .addText((text) => text
          .setPlaceholder('OPENAI_API_KEY')
          .setValue(settings.codexProviderApiKeyEnvVar ?? '')
          .onChange(async (value) => {
            settings.codexProviderApiKeyEnvVar = value.trim();
            await this.secondBrainPlugin.saveSettings();
          }));
    }

    if (provider !== 'codex') {
      new Setting(container)
        .setName('快速模型')
        .setDesc('日常问答、标题处理和收件箱分流使用的模型名称。')
        .addText((text) => text
          .setPlaceholder(provider === 'ollama' ? 'gpt-oss:20b' : '模型 ID')
          .setValue(settings.codexProviderFastModel ?? '')
          .onChange(async (value) => {
            settings.codexProviderFastModel = value.trim();
            this.syncConfiguredModels();
            await this.secondBrainPlugin.saveSettings();
            this.secondBrainPlugin.getView()?.refreshModelSelector();
          }));

      new Setting(container)
        .setName('深度模型')
        .setDesc('复杂分析使用；留空时沿用快速模型。')
        .addText((text) => text
          .setPlaceholder('留空则使用快速模型')
          .setValue(settings.codexProviderDeepModel ?? '')
          .onChange(async (value) => {
            settings.codexProviderDeepModel = value.trim();
            this.syncConfiguredModels();
            await this.secondBrainPlugin.saveSettings();
            this.secondBrainPlugin.getView()?.refreshModelSelector();
          }));

      new Setting(container)
        .setName('发送推理强度')
        .setDesc('仅在模型明确支持 reasoning effort 时开启；普通模型开启后可能拒绝请求。')
        .addToggle((toggle) => toggle
          .setValue(settings.codexProviderSupportsReasoning ?? false)
          .onChange(async (value) => {
            settings.codexProviderSupportsReasoning = value;
            this.syncConfiguredModels();
            await this.secondBrainPlugin.saveSettings();
          }));
    }

    new Setting(container)
      .setName('响应通道')
      .setDesc('快速适合日常问答和收件箱分流；深度适合复杂分析。')
      .addDropdown((dropdown) => {
        for (const [mode, profile] of Object.entries(CODEX_PERFORMANCE_PROFILES)) {
          let model: string = profile.model;
          try {
            model = getConfiguredModel(settings, mode as CodexPerformanceMode);
          } catch {
            model = '待配置';
          }
          dropdown.addOption(mode, `${profile.label} · ${model}`);
        }
        dropdown
          .setValue(settings.codexPerformanceMode ?? 'fast')
          .onChange(async (value) => {
            const mode = value as CodexPerformanceMode;
            settings.codexPerformanceMode = mode;
            this.syncConfiguredModels();
            await this.secondBrainPlugin.saveSettings();
            this.secondBrainPlugin.getView()?.refreshModelSelector();
          });
      });

    const providerDescription = provider === 'codex'
      ? '使用当前 Codex 登录状态；可通过下方检测结果确认 CLI。'
      : '连接测试只检查服务和模型列表；完整知识工作流还要求模型支持工具调用、流式输出和足够上下文。';
    new Setting(container)
      .setName('连接检查')
      .setDesc(providerDescription)
      .addButton((button) => button
        .setButtonText('测试连接')
        .onClick(async () => this.testModelProviderConnection()));
  }

  private syncConfiguredModels(): void {
    const settings = this.secondBrainPlugin.settings;
    const mode = settings.codexPerformanceMode ?? 'fast';
    try {
      const fast = getConfiguredModel(settings, 'fast');
      const deep = getConfiguredModel(settings, 'deep');
      settings.codexModelOptions = [...new Set([fast, deep])];
      settings.codexModel = getConfiguredModel(settings, mode);
    } catch {
      settings.codexModelOptions = [];
      settings.codexModel = '';
    }
    const profile = CODEX_PERFORMANCE_PROFILES[mode];
    settings.codexReasoningEffort = (settings.codexModelProvider ?? 'codex') === 'codex' || settings.codexProviderSupportsReasoning
      ? profile.reasoningEffort
      : '';
    settings.codexPlanModeReasoningEffort = settings.codexReasoningEffort;
  }

  private async testModelProviderConnection(): Promise<void> {
    const settings = this.secondBrainPlugin.settings;
    if ((settings.codexModelProvider ?? 'codex') === 'codex') {
      const codexPath = this.secondBrainPlugin.getResolvedCodexCliPath();
      new Notice(codexPath ? `已找到 Codex CLI：${codexPath}` : '未找到 Codex CLI，请检查下方路径。');
      return;
    }

    try {
      getConfiguredModel(settings, 'fast');
      const endpoint = getModelProviderModelsEndpoint(settings);
      if (!endpoint) throw new Error('无法确定模型服务地址。');
      const headers: Record<string, string> = {};
      const envKey = settings.codexProviderApiKeyEnvVar?.trim() ?? '';
      if (envKey) {
        const configuredEnv = parseEnvironmentVariables(this.secondBrainPlugin.getActiveEnvironmentVariables());
        const apiKey = configuredEnv[envKey] || process.env[envKey];
        if (!apiKey) throw new Error(`未找到环境变量 ${envKey}，请先在系统中设置 API 密钥。`);
        headers.Authorization = `Bearer ${apiKey}`;
      }

      const response = await requestUrl({ url: endpoint, method: 'GET', headers, throw: false });
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`服务返回 HTTP ${response.status}。`);
      }
      const models = extractModelIds(response.json);
      const suffix = models.length > 0
        ? `，识别到 ${models.length} 个模型：${models.slice(0, 3).join('、')}`
        : '，但没有从模型列表中识别到模型名称';
      new Notice(`连接成功${suffix}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`连接失败：${message}`);
    }
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

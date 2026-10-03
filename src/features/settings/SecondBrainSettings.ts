import * as fs from 'fs';
import type { App } from 'obsidian';
import { Notice, PluginSettingTab, requestUrl, SecretComponent, Setting } from 'obsidian';

import { isAbsoluteWikiPath } from '../../core/knowledge/LlmWikiService';
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
import { CustomInstructionsModal } from './CustomInstructionsModal';

const DIRECT_API_KEY_SECRET_ID = 'second-brain-model-api-key';

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
    this.renderLongTermMemorySettings(container);
    this.renderDailyNoteSettings(container);
    this.renderProactiveReviewSettings(container);
    this.renderProactiveInsightSettings(container);

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

  private renderLongTermMemorySettings(container: HTMLElement): void {
    const settings = this.secondBrainPlugin.settings;
    const status = this.secondBrainPlugin.llmWikiService.getStatus();

    new Setting(container).setName('长期记忆库').setHeading();

    new Setting(container)
      .setName('启用 LLM Wiki')
      .setDesc('可选模块。只在已有稳定的手册、规范、PDF或报告时启用；持续修改的领域笔记继续保存在Obsidian。')
      .addToggle((toggle) => toggle
        .setValue(settings.llmWikiEnabled)
        .onChange(async (value) => {
          settings.llmWikiEnabled = value;
          await this.secondBrainPlugin.saveSettings();
          if (value) await this.secondBrainPlugin.llmWikiService.start();
          else await this.secondBrainPlugin.llmWikiService.stop();
          this.display();
        }));

    new Setting(container)
      .setName('当前状态')
      .setDesc(status.detail)
      .addButton((button) => button
        .setButtonText(status.connected ? '重新检测' : '连接')
        .setCta()
        .onClick(async () => {
          const next = await this.secondBrainPlugin.llmWikiService.start();
          new Notice(next.detail);
          this.display();
        }));

    new Setting(container)
      .setName('启动 Obsidian 时连接')
      .setDesc('启用长期记忆后才建议打开；默认关闭，不影响日志、复盘、收件箱和微信。')
      .addToggle((toggle) => toggle
        .setValue(settings.llmWikiAutoStart)
        .onChange(async (value) => {
          settings.llmWikiAutoStart = value;
          await this.secondBrainPlugin.saveSettings();
        }));

    new Setting(container)
      .setName('对话自动读取长期记忆')
      .setDesc('将相关Wiki证据与本地笔记一起用于回答；检索本身不会改写资料。')
      .addToggle((toggle) => toggle
        .setValue(settings.llmWikiAutoRetrieve)
        .onChange(async (value) => {
          settings.llmWikiAutoRetrieve = value;
          await this.secondBrainPlugin.saveSettings();
        }));

    new Setting(container)
      .setName('每次读取数量')
      .setDesc('建议6条；范围1至12条。数量过多会增加上下文和响应时间。')
      .addText((text) => text
        .setValue(String(settings.llmWikiTopK))
        .onChange(async (value) => {
          const parsed = Number(value);
          if (!Number.isFinite(parsed) || parsed < 1 || parsed > 12) {
            text.inputEl.addClass('is-invalid');
            return;
          }
          text.inputEl.removeClass('is-invalid');
          settings.llmWikiTopK = Math.round(parsed);
          await this.secondBrainPlugin.saveSettings();
        }));

    const paths = [
      ['便携程序', 'llmWikiExecutablePath'],
      ['知识项目', 'llmWikiProjectPath'],
    ] as const;
    for (const [label, key] of paths) {
      const configuredPath = settings[key];
      const exists = Boolean(configuredPath && fs.existsSync(configuredPath));
      new Setting(container)
        .setName(label)
        .setDesc(exists
          ? `已找到：${configuredPath}`
          : `当前未找到：${configuredPath || '尚未填写'}。请填写绝对路径。`)
        .addText((text) => text
          .setValue(configuredPath)
          .onChange(async (value) => {
            if (value.trim() && !isAbsoluteWikiPath(value.trim())) {
              text.inputEl.addClass('is-invalid');
              return;
            }
            text.inputEl.removeClass('is-invalid');
            settings[key] = value.trim();
            await this.secondBrainPlugin.saveSettings();
          }));
    }

    new Setting(container)
      .setName('模型设置')
      .setDesc('LLM Wiki 使用独立的模型设置。请在其应用中配置模型接口，不要将密钥放进公开仓库。');
  }

  private renderDailyNoteSettings(container: HTMLElement): void {
    const settings = this.secondBrainPlugin.settings;
    new Setting(container).setName('每日行为日志').setHeading();

    new Setting(container)
      .setName('显示今日信息')
      .setDesc('打开当天日志时，离线生成星期、农历、节日习俗和宜忌；不会调用外部接口。')
      .addToggle((toggle) => toggle
        .setValue(settings.dailyInfoEnabled)
        .onChange(async (value) => {
          settings.dailyInfoEnabled = value;
          await this.secondBrainPlugin.saveSettings();
          if (value) await this.secondBrainPlugin.refreshTodayInfo();
        }));

  }

  private renderProactiveReviewSettings(container: HTMLElement): void {
    const settings = this.secondBrainPlugin.settings;
    new Setting(container).setName('行动工作台').setHeading();

    new Setting(container)
      .setName('打开行动工作台')
      .setDesc('新增、勾选、延期、修改、设置优先级和恢复归档事项；Markdown 仅作为可恢复记录。')
      .addButton((button) => button
        .setButtonText('打开')
        .setCta()
        .onClick(() => this.secondBrainPlugin.openActionWorkbench()));

    new Setting(container)
      .setName('每天自动检查')
      .setDesc('每天首次打开 Obsidian 时本地核对行动、项目、等待与决策；不会自动调用模型或修改笔记。')
      .addToggle((toggle) => toggle
        .setValue(settings.proactiveReviewEnabled)
        .onChange(async (value) => {
          settings.proactiveReviewEnabled = value;
          await this.secondBrainPlugin.saveSettings();
          if (value) await this.secondBrainPlugin.runProactiveReviewCheck(false, false);
        }));

    new Setting(container)
      .setName('项目停滞阈值')
      .setDesc('活跃项目连续多少天没有更新后提醒；建议 14 天。')
      .addText((text) => text
        .setValue(String(settings.proactiveReviewProjectStaleDays))
        .onChange(async (value) => {
          const parsed = Number(value);
          if (!Number.isFinite(parsed) || parsed < 1 || parsed > 365) {
            text.inputEl.addClass('is-invalid');
            return;
          }
          text.inputEl.removeClass('is-invalid');
          settings.proactiveReviewProjectStaleDays = Math.round(parsed);
          await this.secondBrainPlugin.saveSettings();
        }));

    new Setting(container)
      .setName('本周行动阈值')
      .setDesc('“本周”任务首次被跟踪多少天后仍未完成时提醒；建议 7 天。')
      .addText((text) => text
        .setValue(String(settings.proactiveReviewWeeklyActionDays))
        .onChange(async (value) => {
          const parsed = Number(value);
          if (!Number.isFinite(parsed) || parsed < 1 || parsed > 90) {
            text.inputEl.addClass('is-invalid');
            return;
          }
          text.inputEl.removeClass('is-invalid');
          settings.proactiveReviewWeeklyActionDays = Math.round(parsed);
          await this.secondBrainPlugin.saveSettings();
        }));

    new Setting(container)
      .setName('列表视窗高度')
      .setDesc('控制窗口内同时约显示多少项；全部检测结果仍可下滑浏览，建议 3 项。')
      .addText((text) => text
        .setValue(String(settings.proactiveReviewMaxVisible))
        .onChange(async (value) => {
          const parsed = Number(value);
          if (!Number.isFinite(parsed) || parsed < 1 || parsed > 10) {
            text.inputEl.addClass('is-invalid');
            return;
          }
          text.inputEl.removeClass('is-invalid');
          settings.proactiveReviewMaxVisible = Math.round(parsed);
          await this.secondBrainPlugin.saveSettings();
        }));

    new Setting(container)
      .setName('启动后显示简短提醒')
      .setDesc('有待复盘事项时只显示一次通知，不弹出窗口。')
      .addToggle((toggle) => toggle
        .setValue(settings.proactiveReviewStartupNotice)
        .onChange(async (value) => {
          settings.proactiveReviewStartupNotice = value;
          await this.secondBrainPlugin.saveSettings();
        }));

    new Setting(container)
      .setName('当前检查')
      .setDesc('立即刷新行动系统提醒和待确认数量；遗漏事项与进度语义分析需在中心内手动启动。')
      .addButton((button) => button
        .setButtonText('立即检查')
        .onClick(() => { void this.secondBrainPlugin.runProactiveReviewCheck(true, false); }));
  }

  private renderProactiveInsightSettings(container: HTMLElement): void {
    const settings = this.secondBrainPlugin.settings;
    new Setting(container).setName('记忆管家').setHeading();

    new Setting(container)
      .setName('主动程度')
      .setDesc('关闭：不运行；安静：只显示数量；管家简报：汇总提醒；及时提醒：重要事项即时通知。')
      .addDropdown((dropdown) => dropdown
        .addOption('off', '关闭')
        .addOption('quiet', '安静')
        .addOption('brief', '管家简报')
        .addOption('timely', '及时提醒')
        .setValue(settings.memoryButlerMode)
        .onChange(async (value) => {
          settings.memoryButlerMode = value as typeof settings.memoryButlerMode;
          await this.secondBrainPlugin.saveSettings();
        }));

    new Setting(container)
      .setName('启用主动洞察')
      .setDesc('建立本地增量索引并发现跨笔记候选；原始收件箱、附件、模板和归档不会进入分析。')
      .addToggle((toggle) => toggle
        .setValue(settings.proactiveInsightsEnabled)
        .onChange(async (value) => {
          settings.proactiveInsightsEnabled = value;
          await this.secondBrainPlugin.saveSettings();
          if (value) await this.secondBrainPlugin.refreshProactiveInsightCount();
        }));

    new Setting(container)
      .setName('每天自动生成')
      .setDesc('累计足够的实质变更后，每天最多调用一次快速模型；首次升级只建立索引，不会自动调用。')
      .addToggle((toggle) => toggle
        .setValue(settings.proactiveInsightsAutoAnalyze)
        .onChange(async (value) => {
          settings.proactiveInsightsAutoAnalyze = value;
          await this.secondBrainPlugin.saveSettings();
        }));

    new Setting(container)
      .setName('触发笔记数量')
      .setDesc('累计多少篇新增或实质修改笔记后允许自动分析；建议 3 篇。')
      .addText((text) => text
        .setValue(String(settings.proactiveInsightsMinChangedNotes))
        .onChange(async (value) => {
          const parsed = Number(value);
          if (!Number.isFinite(parsed) || parsed < 1 || parsed > 30) {
            text.inputEl.addClass('is-invalid');
            return;
          }
          text.inputEl.removeClass('is-invalid');
          settings.proactiveInsightsMinChangedNotes = Math.round(parsed);
          await this.secondBrainPlugin.saveSettings();
        }));

    new Setting(container)
      .setName('每日新洞察上限')
      .setDesc('每次最多生成多少条高价值候选；建议 3 条，避免信息过载。')
      .addText((text) => text
        .setValue(String(settings.proactiveInsightsDailyLimit))
        .onChange(async (value) => {
          const parsed = Number(value);
          if (!Number.isFinite(parsed) || parsed < 1 || parsed > 5) {
            text.inputEl.addClass('is-invalid');
            return;
          }
          text.inputEl.removeClass('is-invalid');
          settings.proactiveInsightsDailyLimit = Math.round(parsed);
          await this.secondBrainPlugin.saveSettings();
        }));

    new Setting(container)
      .setName('洞察列表视窗高度')
      .setDesc('控制窗口内同时约显示多少条；全部结果仍可下滑浏览，建议 3 条。')
      .addText((text) => text
        .setValue(String(settings.proactiveInsightsViewportItems))
        .onChange(async (value) => {
          const parsed = Number(value);
          if (!Number.isFinite(parsed) || parsed < 1 || parsed > 10) {
            text.inputEl.addClass('is-invalid');
            return;
          }
          text.inputEl.removeClass('is-invalid');
          settings.proactiveInsightsViewportItems = Math.round(parsed);
          await this.secondBrainPlugin.saveSettings();
        }));

    new Setting(container)
      .setName('生成后显示提醒')
      .setDesc('自动生成新洞察时只显示一次简短通知，不强制弹出窗口。')
      .addToggle((toggle) => toggle
        .setValue(settings.proactiveInsightsStartupNotice)
        .onChange(async (value) => {
          settings.proactiveInsightsStartupNotice = value;
          await this.secondBrainPlugin.saveSettings();
        }));

    new Setting(container)
      .setName('打开记忆管家')
      .setDesc('统一处理遗漏事项、进度、到期提醒、规律与矛盾。')
      .addButton((button) => button
        .setButtonText('打开')
        .onClick(() => this.secondBrainPlugin.openProactiveInsights()));
  }

  private renderModelSettings(container: HTMLElement): void {
    container.empty();
    const settings = this.secondBrainPlugin.settings;
    const provider = settings.codexModelProvider ?? 'codex';

    new Setting(container)
      .setName('模型来源')
      .setDesc('选择 Codex 账户、本地模型，或在下方直接接入其他模型 API。切换后会用于新的对话和知识工作流。')
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
      const apiHeading = container.createDiv({ cls: 'second-brain-custom-api-heading' });
      apiHeading.createEl('h3', { text: '其他模型 API' });
      apiHeading.createSpan({
        text: '兼容 OpenAI Responses API 的云端或本地服务都可以接入。',
        cls: 'setting-item-description',
      });

      new Setting(container)
        .setName('API 基础地址')
        .setDesc('填写到版本层，例如 https://api.example.com/v1 或 http://127.0.0.1:11434/v1；地址中不要包含密钥。')
        .addText((text) => text
          .setPlaceholder('https://example.com/v1')
          .setValue(settings.codexProviderBaseUrl ?? '')
          .onChange(async (value) => {
            settings.codexProviderBaseUrl = value.trim();
            await this.secondBrainPlugin.saveSettings();
          }));

      const savedSecretId = settings.codexProviderSecretId?.trim() ?? '';
      const hasSavedApiKey = Boolean(savedSecretId && this.app.secretStorage.getSecret(savedSecretId));
      const apiKeySetting = new Setting(container)
        .setName('API 密钥')
        .setDesc(hasSavedApiKey
          ? '已保存 API 密钥。再次填写会覆盖旧密钥；密钥只保存在 Obsidian 加密密钥库中。'
          : '直接填写 API 密钥并点击“保存密钥”。本地模型通常可以留空。密钥不会写入插件配置、笔记或命令参数。');
      apiKeySetting.addText((text) => {
        text.setPlaceholder('sk-...');
        text.inputEl.type = 'password';
        text.inputEl.autocomplete = 'new-password';
        apiKeySetting.addButton((button) => button
          .setButtonText('保存密钥')
          .setCta()
          .onClick(async () => {
            const value = text.getValue().trim();
            if (!value) {
              new Notice('请输入 API 密钥；本地模型无需填写。');
              return;
            }
            this.app.secretStorage.setSecret(DIRECT_API_KEY_SECRET_ID, value);
            settings.codexProviderSecretId = DIRECT_API_KEY_SECRET_ID;
            await this.secondBrainPlugin.saveSettings();
            text.setValue('');
            new Notice('API 密钥已安全保存。');
            this.renderModelSettings(container);
          }));
      });

      if (hasSavedApiKey) {
        apiKeySetting.addButton((button) => button
          .setButtonText('清除选择')
          .onClick(async () => {
            settings.codexProviderSecretId = '';
            await this.secondBrainPlugin.saveSettings();
            this.renderModelSettings(container);
          }));
      }

      new Setting(container)
        .setName('已有密钥')
        .setDesc('如果你已经在 Obsidian 密钥管理器中保存过密钥，可以从这里选择。')
        .addComponent((controlEl) => new SecretComponent(this.app, controlEl)
          .setValue(settings.codexProviderSecretId ?? '')
          .onChange(async (value) => {
            settings.codexProviderSecretId = value;
            await this.secondBrainPlugin.saveSettings();
            this.renderModelSettings(container);
          }));

      new Setting(container)
        .setName('旧版环境变量（可选）')
        .setDesc('仅在未选择上方 API 密钥时使用。可填写 OPENAI_API_KEY 等变量名；通常无需设置。')
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
        .setDesc('日常问答、标题处理和收件箱分流使用的模型名称，例如 gpt-4o-mini、qwen-plus 或本地模型名。')
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
        .setDesc('复杂分析和复盘使用；留空时沿用快速模型。')
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
      : '连接测试会检查服务和模型列表；完整知识工作流还要求模型支持 Responses API、工具调用、流式输出和足够上下文。';
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
      const secretId = settings.codexProviderSecretId?.trim() ?? '';
      const envKey = settings.codexProviderApiKeyEnvVar?.trim() ?? '';
      if (secretId) {
        const apiKey = this.app.secretStorage.getSecret(secretId);
        if (!apiKey) throw new Error('未找到已选择的 API 密钥，请重新选择或新建。');
        headers.Authorization = `Bearer ${apiKey}`;
      } else if (envKey) {
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
    const timing = status.lastDeliveryLagMs === undefined
      ? ''
      : ` 最近接收延迟 ${(status.lastDeliveryLagMs / 1000).toFixed(1)} 秒，插件处理 ${(status.lastProcessingMs ?? 0) / 1000 < 0.1 ? '<0.1' : ((status.lastProcessingMs ?? 0) / 1000).toFixed(1)} 秒。`;

    new Setting(container)
      .setName('当前状态')
      .setDesc(`${status.detail}${timing}`)
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
      .setName('启用完整协作模式')
      .setDesc('微信消息默认交给同一第二大脑 Agent 理解，可连续对话、检索、智能收录并生成受控修改提案。')
      .addToggle((toggle) => toggle
        .setValue(this.secondBrainPlugin.settings.wechatCollaborationEnabled)
        .onChange(async (value) => {
          this.secondBrainPlugin.settings.wechatCollaborationEnabled = value;
          await this.secondBrainPlugin.saveSettings();
          await this.renderWechatSettings(container);
        }));

    if (this.secondBrainPlugin.settings.wechatCollaborationEnabled) {
      new Setting(container)
        .setName('微信端附加指令')
        .setDesc('微信端先遵守通用自定义指令，再追加这里的移动端特殊要求；电脑端不加载此部分。')
        .addButton((button) => button
          .setButtonText('编辑指令')
          .onClick(() => new CustomInstructionsModal(this.app, this.secondBrainPlugin).open()));

      new Setting(container)
        .setName('微信默认响应通道')
        .setDesc('普通问答默认使用快速通道；在微信发送“深度通道”可只切换微信会话，不影响插件面板。')
        .addDropdown((dropdown) => dropdown
          .addOption('fast', '快速')
          .addOption('deep', '深度')
          .setValue(this.secondBrainPlugin.settings.wechatDefaultPerformanceMode ?? 'fast')
          .onChange(async (value) => {
            this.secondBrainPlugin.settings.wechatDefaultPerformanceMode = value as CodexPerformanceMode;
            await this.secondBrainPlugin.saveSettings();
          }));

      new Setting(container)
        .setName('消息判断规则')
        .setDesc('直接使用自然语言；Agent 判断回答、检索或收录。“对话：…”和“记录：…”仅作为可选快捷方式。');

      new Setting(container)
        .setName('微信安全写入')
        .setDesc('Agent 先生成小范围提案；回复“确认”才会在核对文件并创建快照后写入，回复“取消”则放弃。');
    }

    new Setting(container).setName('微信管家简报').setHeading();

    new Setting(container)
      .setName('启用早间简报')
      .setDesc('从行动工作台和记忆管家生成简报；默认不调用模型。')
      .addToggle((toggle) => toggle
        .setValue(this.secondBrainPlugin.settings.wechatButlerEnabled)
        .onChange(async (value) => {
          this.secondBrainPlugin.settings.wechatButlerEnabled = value;
          await this.secondBrainPlugin.saveSettings();
          this.secondBrainPlugin.weChatService.rescheduleButlerBrief();
        }));

    new Setting(container)
      .setName('简报时间')
      .setDesc('电脑和 Obsidian 当时未运行时，将在当天启动后补发。')
      .addText((text) => {
        text.inputEl.type = 'time';
        text.setValue(this.secondBrainPlugin.settings.wechatButlerBriefTime).onChange(async (value) => {
          if (!/^\d{2}:\d{2}$/u.test(value)) return;
          this.secondBrainPlugin.settings.wechatButlerBriefTime = value;
          await this.secondBrainPlugin.saveSettings();
          this.secondBrainPlugin.weChatService.rescheduleButlerBrief();
        });
      });

    new Setting(container)
      .setName('启动后补发')
      .setDesc('当天错过设定时间后，在 Obsidian 首次启动并连接微信时补发一次。')
      .addToggle((toggle) => toggle
        .setValue(this.secondBrainPlugin.settings.wechatButlerCatchUp)
        .onChange(async (value) => {
          this.secondBrainPlugin.settings.wechatButlerCatchUp = value;
          await this.secondBrainPlugin.saveSettings();
          this.secondBrainPlugin.weChatService.rescheduleButlerBrief();
        }));

    new Setting(container)
      .setName('包含管家询问')
      .setDesc('在行动之外附带最多 3 条需要你决定的遗漏、复盘或洞察。')
      .addToggle((toggle) => toggle
        .setValue(this.secondBrainPlugin.settings.wechatButlerIncludeInsights)
        .onChange(async (value) => {
          this.secondBrainPlugin.settings.wechatButlerIncludeInsights = value;
          await this.secondBrainPlugin.saveSettings();
        }));

    new Setting(container)
      .setName('简报行动上限')
      .setDesc('允许 1–20 项；先显示今天任务，再按高、普通优先级显示其他未完成行动；重复事项只出现一次。')
      .addText((text) => text
        .setValue(String(this.secondBrainPlugin.settings.wechatButlerMaxItems))
        .onChange(async (value) => {
          const parsed = Number(value);
          if (!Number.isFinite(parsed) || parsed < 1 || parsed > 20) {
            text.inputEl.addClass('is-invalid');
            return;
          }
          text.inputEl.removeClass('is-invalid');
          this.secondBrainPlugin.settings.wechatButlerMaxItems = Math.round(parsed);
          await this.secondBrainPlugin.saveSettings();
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

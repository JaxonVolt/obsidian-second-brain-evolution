/* eslint-disable simple-import-sort/imports */
import * as fs from 'fs';
import type { App } from 'obsidian';
import { Notice, PluginSettingTab, Setting } from 'obsidian';

import {
  type BackendId,
  CODEX_PERFORMANCE_PROFILES,
  type CodexPerformanceMode,
  getCurrentPlatformKey,
  getHostnameKey,
} from '../../core/types';
import { DEFAULT_CLAUDE_MODELS } from '../../core/types/models';
import { setLocale, t } from '../../i18n';
import type { TranslationKey } from '../../i18n/types';
import type ClaudianPlugin from '../../main';
import {
  findNodeExecutable,
  formatContextLimit,
  getCustomModelIds,
  getEnhancedPath,
  getModelsFromEnvironment,
  parseContextLimit,
  parseEnvironmentVariables,
} from '../../utils/env';
import { expandHomePath } from '../../utils/path';
import { ClaudianView } from '../chat/ClaudianView';
import { updateTabBackendUI } from '../chat/tabs/Tab';
import { buildNavMappingText, parseNavMappings } from './keyboardNavigation';
import { AgentSettings } from './ui/AgentSettings';
import { EnvSnippetManager } from './ui/EnvSnippetManager';
import { McpSettingsManager } from './ui/McpSettingsManager';
import { PluginSettingsManager } from './ui/PluginSettingsManager';
import { SlashCommandSettings } from './ui/SlashCommandSettings';

function formatHotkey(hotkey: { modifiers: string[]; key: string }): string {
  const isMac = navigator.platform.includes('Mac');
  const modMap: Record<string, string> = isMac
    ? { Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Meta: '⌘' }
    : { Mod: 'Ctrl', Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Meta: 'Win' };

  const mods = hotkey.modifiers.map((m) => modMap[m] || m);
  const key = hotkey.key.length === 1 ? hotkey.key.toUpperCase() : hotkey.key;

  return isMac ? [...mods, key].join('') : [...mods, key].join('+');
}

function openHotkeySettings(app: App): void {
  const setting = (app as any).setting;
  setting.open();
  setting.openTabById('hotkeys');
  setTimeout(() => {
    const tab = setting.activeTab;
    if (tab) {
      const searchEl = tab.searchInputEl ?? tab.searchComponent?.inputEl;
      if (searchEl) {
        searchEl.value = '知识演化';
        tab.updateHotkeyVisibility?.();
      }
    }
  }, 100);
}

function getHotkeyForCommand(app: App, commandId: string): string | null {
  const hotkeyManager = (app as any).hotkeyManager;
  if (!hotkeyManager) return null;

  const customHotkeys = hotkeyManager.customKeys?.[commandId];
  const defaultHotkeys = hotkeyManager.defaultKeys?.[commandId];
  const hotkeys = customHotkeys?.length > 0 ? customHotkeys : defaultHotkeys;

  if (!hotkeys || hotkeys.length === 0) return null;

  return hotkeys.map(formatHotkey).join(', ');
}

function addHotkeySettingRow(
  containerEl: HTMLElement,
  app: App,
  commandId: string,
  translationPrefix: string
): void {
  const hotkey = getHotkeyForCommand(app, commandId);
  const item = containerEl.createDiv({ cls: 'claudian-hotkey-item' });
  item.createSpan({ cls: 'claudian-hotkey-name', text: t(`${translationPrefix}.name` as TranslationKey) });
  if (hotkey) {
    item.createSpan({ cls: 'claudian-hotkey-badge', text: hotkey });
  }
  item.addEventListener('click', () => openHotkeySettings(app));
}

export class ClaudianSettingTab extends PluginSettingTab {
  plugin: ClaudianPlugin;
  private contextLimitsContainer: HTMLElement | null = null;

  constructor(app: App, plugin: ClaudianPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass('claudian-settings');
    this.contextLimitsContainer = null;

    setLocale('zh-CN');

    this.renderCommonSettings(containerEl);
    this.renderCodexSettings(containerEl);
  }

  private renderCommonSettings(containerEl: HTMLElement): void {
    new Setting(containerEl).setName(t('settings.common')).setHeading();

    new Setting(containerEl)
      .setName('运行引擎')
      .setDesc('本插件固定使用本机 Codex CLI。')
      .addText((text) => {
        text.setValue('Codex').setDisabled(true);
      });
  }

  private renderSharedCustomizationSettings(containerEl: HTMLElement): void {
    new Setting(containerEl).setName(t('settings.customization')).setHeading();

    new Setting(containerEl)
      .setName(t('settings.excludedTags.name'))
      .setDesc(t('settings.excludedTags.desc'))
      .addTextArea((text) => {
        text
          .setPlaceholder('system\nprivate\ndraft')
          .setValue(this.plugin.settings.excludedTags.join('\n'))
          .onChange(async (value) => {
            this.plugin.settings.excludedTags = value
              .split(/\r?\n/)
              .map((s) => s.trim().replace(/^#/, ''))
              .filter((s) => s.length > 0);
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 4;
        text.inputEl.cols = 30;
      });

    new Setting(containerEl)
      .setName(t('settings.mediaFolder.name'))
      .setDesc(t('settings.mediaFolder.desc'))
      .addText((text) => {
        text
          .setPlaceholder('attachments')
          .setValue(this.plugin.settings.mediaFolder)
          .onChange(async (value) => {
            this.plugin.settings.mediaFolder = value.trim();
            await this.plugin.saveSettings();
          });
        text.inputEl.addClass('claudian-settings-media-input');
        text.inputEl.addEventListener('blur', () => this.restartServiceForPromptChange());
      });

    new Setting(containerEl)
      .setName(t('settings.enableAutoScroll.name'))
      .setDesc(t('settings.enableAutoScroll.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableAutoScroll ?? true)
          .onChange(async (value) => {
            this.plugin.settings.enableAutoScroll = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t('settings.navMappings.name'))
      .setDesc(t('settings.navMappings.desc'))
      .addTextArea((text) => {
        let pendingValue = buildNavMappingText(this.plugin.settings.keyboardNavigation);
        let saveTimeout: number | null = null;

        const commitValue = async (showError: boolean): Promise<void> => {
          if (saveTimeout !== null) {
            window.clearTimeout(saveTimeout);
            saveTimeout = null;
          }

          const result = parseNavMappings(pendingValue);
          if (!result.settings) {
            if (showError) {
              new Notice(`${t('common.error')}: ${result.error}`);
              pendingValue = buildNavMappingText(this.plugin.settings.keyboardNavigation);
              text.setValue(pendingValue);
            }
            return;
          }

          this.plugin.settings.keyboardNavigation.scrollUpKey = result.settings.scrollUp;
          this.plugin.settings.keyboardNavigation.scrollDownKey = result.settings.scrollDown;
          this.plugin.settings.keyboardNavigation.focusInputKey = result.settings.focusInput;
          await this.plugin.saveSettings();
          pendingValue = buildNavMappingText(this.plugin.settings.keyboardNavigation);
          text.setValue(pendingValue);
        };

        const scheduleSave = (): void => {
          if (saveTimeout !== null) {
            window.clearTimeout(saveTimeout);
          }
          saveTimeout = window.setTimeout(() => {
            void commitValue(false);
          }, 500);
        };

        text
          .setPlaceholder('map w scrollUp\nmap s scrollDown\nmap i focusInput')
          .setValue(pendingValue)
          .onChange((value) => {
            pendingValue = value;
            scheduleSave();
          });

        text.inputEl.rows = 3;
        text.inputEl.addEventListener('blur', async () => {
          await commitValue(true);
        });
      });

    new Setting(containerEl)
      .setName(t('settings.tabBarPosition.name'))
      .setDesc(t('settings.tabBarPosition.desc'))
      .addDropdown((dropdown) => {
        dropdown
          .addOption('input', t('settings.tabBarPosition.input'))
          .addOption('header', t('settings.tabBarPosition.header'))
          .setValue(this.plugin.settings.tabBarPosition ?? 'input')
          .onChange(async (value: 'input' | 'header') => {
            this.plugin.settings.tabBarPosition = value;
            await this.plugin.saveSettings();

            for (const leaf of this.plugin.app.workspace.getLeavesOfType('claudxian-view')) {
              if (leaf.view instanceof ClaudianView) {
                leaf.view.updateLayoutForPosition();
              }
            }
          });
      });

    new Setting(containerEl)
      .setName(t('settings.openInMainTab.name'))
      .setDesc(t('settings.openInMainTab.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.openInMainTab)
          .onChange(async (value) => {
            this.plugin.settings.openInMainTab = value;
            await this.plugin.saveSettings();
          })
      );

    const maxTabsSetting = new Setting(containerEl)
      .setName(t('settings.maxTabs.name'))
      .setDesc(t('settings.maxTabs.desc'));

    const maxTabsWarningEl = containerEl.createDiv({ cls: 'claudian-max-tabs-warning' });
    maxTabsWarningEl.style.color = 'var(--text-warning)';
    maxTabsWarningEl.style.fontSize = '0.85em';
    maxTabsWarningEl.style.marginTop = '-0.5em';
    maxTabsWarningEl.style.marginBottom = '0.5em';
    maxTabsWarningEl.style.display = 'none';
    maxTabsWarningEl.setText(t('settings.maxTabs.warning'));

    const updateMaxTabsWarning = (value: number): void => {
      maxTabsWarningEl.style.display = value > 5 ? 'block' : 'none';
    };

    maxTabsSetting.addSlider((slider) => {
      slider
        .setLimits(3, 10, 1)
        .setValue(this.plugin.settings.maxTabs ?? 10)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.maxTabs = value;
          await this.plugin.saveSettings();
          updateMaxTabsWarning(value);
        });
      updateMaxTabsWarning(this.plugin.settings.maxTabs ?? 10);
    });
  }

  private renderHotkeySettings(containerEl: HTMLElement): void {
    new Setting(containerEl).setName(t('settings.hotkeys')).setHeading();

    const hotkeyGrid = containerEl.createDiv({ cls: 'claudian-hotkey-grid' });
    addHotkeySettingRow(hotkeyGrid, this.app, 'claudian:inline-edit', 'settings.inlineEditHotkey');
    addHotkeySettingRow(hotkeyGrid, this.app, 'claudian:open-view', 'settings.openChatHotkey');
    addHotkeySettingRow(hotkeyGrid, this.app, 'claudian:new-session', 'settings.newSessionHotkey');
    addHotkeySettingRow(hotkeyGrid, this.app, 'claudian:new-tab', 'settings.newTabHotkey');
    addHotkeySettingRow(hotkeyGrid, this.app, 'claudian:close-current-tab', 'settings.closeTabHotkey');
  }

  private renderSharedCommandSettings(containerEl: HTMLElement): void {
    new Setting(containerEl).setName(t('settings.slashCommands.name')).setHeading();

    const slashCommandsDesc = containerEl.createDiv({ cls: 'claudian-sp-settings-desc' });
    slashCommandsDesc.createEl('p', {
      text: t('settings.slashCommands.desc'),
      cls: 'setting-item-description',
    });

    const slashCommandsContainer = containerEl.createDiv({ cls: 'claudian-slash-commands-container' });
    new SlashCommandSettings(slashCommandsContainer, this.plugin);

    new Setting(containerEl)
      .setName(t('settings.hiddenSlashCommands.name'))
      .setDesc(t('settings.hiddenSlashCommands.desc'))
      .addTextArea((text) => {
        text
          .setPlaceholder(t('settings.hiddenSlashCommands.placeholder'))
          .setValue((this.plugin.settings.hiddenSlashCommands || []).join('\n'))
          .onChange(async (value) => {
            this.plugin.settings.hiddenSlashCommands = value
              .split(/\r?\n/)
              .map((s) => s.trim().replace(/^\//, ''))
              .filter((s) => s.length > 0);
            await this.plugin.saveSettings();
            this.plugin.getView()?.updateHiddenSlashCommands();
          });
        text.inputEl.rows = 4;
        text.inputEl.cols = 30;
      });
  }

  private renderSharedEnvironmentSettings(containerEl: HTMLElement): void {
    new Setting(containerEl).setName(t('settings.environment')).setHeading();

    new Setting(containerEl)
      .setName(t('settings.customVariables.name'))
      .setDesc(t('settings.customVariables.desc'))
      .addTextArea((text) => {
        text
          .setPlaceholder('ANTHROPIC_API_KEY=your-key\nOPENAI_API_KEY=your-key\nANTHROPIC_BASE_URL=https://api.example.com\nOPENAI_BASE_URL=https://api.openai.com/v1')
          .setValue(this.plugin.settings.environmentVariables);
        text.inputEl.rows = 6;
        text.inputEl.cols = 50;
        text.inputEl.addClass('claudian-settings-env-textarea');
        text.inputEl.addEventListener('blur', async () => {
          await this.plugin.applyEnvironmentVariables(text.inputEl.value);
          this.renderContextLimitsSection();
        });
      });

    const envSnippetsContainer = containerEl.createDiv({ cls: 'claudian-env-snippets-container' });
    new EnvSnippetManager(envSnippetsContainer, this.plugin, () => {
      this.renderContextLimitsSection();
    });
  }

  private renderClaudeSettings(containerEl: HTMLElement): void {
    new Setting(containerEl).setName(t('settings.claude.title')).setHeading();

    new Setting(containerEl)
      .setName(t('settings.userName.name'))
      .setDesc(t('settings.userName.desc'))
      .addText((text) => {
        text
          .setPlaceholder(t('settings.userName.name'))
          .setValue(this.plugin.settings.userName)
          .onChange(async (value) => {
            this.plugin.settings.userName = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.addEventListener('blur', () => this.restartServiceForPromptChange());
      });

    new Setting(containerEl)
      .setName(t('settings.systemPrompt.name'))
      .setDesc(t('settings.systemPrompt.desc'))
      .addTextArea((text) => {
        text
          .setPlaceholder(t('settings.systemPrompt.name'))
          .setValue(this.plugin.settings.systemPrompt)
          .onChange(async (value) => {
            this.plugin.settings.systemPrompt = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 6;
        text.inputEl.cols = 50;
        text.inputEl.addEventListener('blur', () => this.restartServiceForPromptChange());
      });

    new Setting(containerEl)
      .setName(t('settings.autoTitle.name'))
      .setDesc(t('settings.autoTitle.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableAutoTitleGeneration)
          .onChange(async (value) => {
            this.plugin.settings.enableAutoTitleGeneration = value;
            await this.plugin.saveSettings();
            this.display();
          })
      );

    if (this.plugin.settings.enableAutoTitleGeneration) {
      new Setting(containerEl)
        .setName(t('settings.titleModel.name'))
        .setDesc(t('settings.titleModel.desc'))
        .addDropdown((dropdown) => {
          dropdown.addOption('', t('settings.titleModel.auto'));

          const envVars = parseEnvironmentVariables(this.plugin.settings.environmentVariables);
          const customModels = getModelsFromEnvironment(envVars);
          const models = customModels.length > 0 ? customModels : DEFAULT_CLAUDE_MODELS;

          for (const model of models) {
            dropdown.addOption(model.value, model.label);
          }

          dropdown
            .setValue(this.plugin.settings.titleGenerationModel || '')
            .onChange(async (value) => {
              this.plugin.settings.titleGenerationModel = value;
              await this.plugin.saveSettings();
            });
        });
    }

    new Setting(containerEl)
      .setName(t('settings.exportPaths.name'))
      .setDesc(t('settings.exportPaths.desc'))
      .addTextArea((text) => {
        const placeholder = process.platform === 'win32'
          ? '~/Desktop\n~/Downloads\n%TEMP%'
          : '~/Desktop\n~/Downloads\n/tmp';
        text
          .setPlaceholder(placeholder)
          .setValue(this.plugin.settings.allowedExportPaths.join('\n'))
          .onChange(async (value) => {
            this.plugin.settings.allowedExportPaths = value
              .split(/\r?\n/)
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 4;
        text.inputEl.cols = 40;
        text.inputEl.addEventListener('blur', () => this.restartServiceForPromptChange());
      });

    new Setting(containerEl)
      .setName(t('settings.loadUserSettings.name'))
      .setDesc(t('settings.loadUserSettings.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.loadUserClaudeSettings)
          .onChange(async (value) => {
            this.plugin.settings.loadUserClaudeSettings = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t('settings.show1MModel.name'))
      .setDesc(t('settings.show1MModel.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.show1MModel ?? false)
          .onChange(async (value) => {
            this.plugin.settings.show1MModel = value;
            await this.plugin.saveSettings();

            const view = this.plugin.app.workspace.getLeavesOfType('claudxian-view')[0]?.view as ClaudianView | undefined;
            view?.refreshModelSelector();
          })
      );

    new Setting(containerEl)
      .setName(t('settings.enableChrome.name'))
      .setDesc(t('settings.enableChrome.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableChrome ?? false)
          .onChange(async (value) => {
            this.plugin.settings.enableChrome = value;
            await this.plugin.saveSettings();
          })
      );

    this.contextLimitsContainer = containerEl.createDiv({ cls: 'claudian-context-limits-container' });
    this.renderContextLimitsSection();

    this.renderClaudeCliPathSetting(containerEl);

    new Setting(containerEl).setName(t('settings.subagents.name')).setHeading();

    const agentsDesc = containerEl.createDiv({ cls: 'claudian-sp-settings-desc' });
    agentsDesc.createEl('p', {
      text: t('settings.subagents.desc'),
      cls: 'setting-item-description',
    });

    const agentsContainer = containerEl.createDiv({ cls: 'claudian-agents-container' });
    new AgentSettings(agentsContainer, this.plugin);

    new Setting(containerEl).setName(t('settings.mcpServers.name')).setHeading();

    const mcpDesc = containerEl.createDiv({ cls: 'claudian-mcp-settings-desc' });
    mcpDesc.createEl('p', {
      text: t('settings.mcpServers.desc'),
      cls: 'setting-item-description',
    });

    const mcpContainer = containerEl.createDiv({ cls: 'claudian-mcp-container' });
    new McpSettingsManager(mcpContainer, this.plugin);

    new Setting(containerEl).setName(t('settings.plugins.name')).setHeading();

    const pluginsDesc = containerEl.createDiv({ cls: 'claudian-plugin-settings-desc' });
    pluginsDesc.createEl('p', {
      text: t('settings.plugins.desc'),
      cls: 'setting-item-description',
    });

    const pluginsContainer = containerEl.createDiv({ cls: 'claudian-plugins-container' });
    new PluginSettingsManager(pluginsContainer, this.plugin);

    this.renderClaudeSafetySettings(containerEl);
  }

  private renderClaudeSafetySettings(containerEl: HTMLElement): void {
    new Setting(containerEl).setName(t('settings.safety')).setHeading();

    new Setting(containerEl)
      .setName(t('settings.enableBlocklist.name'))
      .setDesc(t('settings.enableBlocklist.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableBlocklist)
          .onChange(async (value) => {
            this.plugin.settings.enableBlocklist = value;
            await this.plugin.saveSettings();
          })
      );

    const platformKey = getCurrentPlatformKey();
    const isWindows = platformKey === 'windows';
    const platformLabel = isWindows ? 'Windows' : 'Unix';

    new Setting(containerEl)
      .setName(t('settings.blockedCommands.name', { platform: platformLabel }))
      .setDesc(t('settings.blockedCommands.desc', { platform: platformLabel }))
      .addTextArea((text) => {
        const placeholder = isWindows
          ? 'del /s /q\nrd /s /q\nRemove-Item -Recurse -Force'
          : 'rm -rf\nchmod 777\nmkfs';
        text
          .setPlaceholder(placeholder)
          .setValue(this.plugin.settings.blockedCommands[platformKey].join('\n'))
          .onChange(async (value) => {
            this.plugin.settings.blockedCommands[platformKey] = value
              .split(/\r?\n/)
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 6;
        text.inputEl.cols = 40;
      });

    if (isWindows) {
      new Setting(containerEl)
        .setName(t('settings.blockedCommands.unixName'))
        .setDesc(t('settings.blockedCommands.unixDesc'))
        .addTextArea((text) => {
          text
            .setPlaceholder('rm -rf\nchmod 777\nmkfs')
            .setValue(this.plugin.settings.blockedCommands.unix.join('\n'))
            .onChange(async (value) => {
              this.plugin.settings.blockedCommands.unix = value
                .split(/\r?\n/)
                .map((s) => s.trim())
                .filter((s) => s.length > 0);
              await this.plugin.saveSettings();
            });
          text.inputEl.rows = 4;
          text.inputEl.cols = 40;
        });
    }
  }

  private renderCodexSettings(containerEl: HTMLElement): void {
    new Setting(containerEl).setName(t('settings.codex.title')).setHeading();

    this.renderCodexCliPathSetting(containerEl);
    this.renderCodexCliDetectionSetting(containerEl);

    new Setting(containerEl)
      .setName('响应通道')
      .setDesc('快速：GPT-5.6 Terra / Medium；深度：GPT-5.6 Sol / High。')
      .addDropdown((dropdown) => {
        for (const [mode, profile] of Object.entries(CODEX_PERFORMANCE_PROFILES)) {
          dropdown.addOption(mode, `${profile.label} · ${profile.model}`);
        }

        dropdown
          .setValue(this.plugin.settings.codexPerformanceMode ?? 'fast')
          .onChange(async (value) => {
            const mode = value as CodexPerformanceMode;
            const profile = CODEX_PERFORMANCE_PROFILES[mode];
            this.plugin.settings.codexPerformanceMode = mode;
            this.plugin.settings.codexModel = profile.model;
            this.plugin.settings.codexModelOptions = [
              CODEX_PERFORMANCE_PROFILES.fast.model,
              CODEX_PERFORMANCE_PROFILES.deep.model,
            ];
            this.plugin.settings.codexReasoningEffort = profile.reasoningEffort;
            this.plugin.settings.codexPlanModeReasoningEffort = profile.reasoningEffort;
            await this.plugin.saveSettings();
            this.refreshAllTabsBackendUI();
          });
      });
  }

  private renderAdvancedSettings(containerEl: HTMLElement): void {
    new Setting(containerEl).setName(t('settings.advanced')).setHeading();

    new Setting(containerEl)
      .setName(t('settings.enableBangBash.name'))
      .setDesc(t('settings.enableBangBash.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableBangBash ?? false)
          .onChange(async (value) => {
            bangBashValidationEl.style.display = 'none';
            if (value) {
              const enhancedPath = getEnhancedPath();
              const nodePath = findNodeExecutable(enhancedPath);
              if (!nodePath) {
                bangBashValidationEl.setText(t('settings.enableBangBash.validation.noNode'));
                bangBashValidationEl.style.display = 'block';
                toggle.setValue(false);
                return;
              }
            }
            this.plugin.settings.enableBangBash = value;
            await this.plugin.saveSettings();
          })
      );

    const bangBashValidationEl = containerEl.createDiv({ cls: 'claudian-bang-bash-validation' });
    bangBashValidationEl.style.color = 'var(--text-error)';
    bangBashValidationEl.style.fontSize = '0.85em';
    bangBashValidationEl.style.marginTop = '-0.5em';
    bangBashValidationEl.style.marginBottom = '0.5em';
    bangBashValidationEl.style.display = 'none';
  }

  private renderCodexCliDetectionSetting(containerEl: HTMLElement): void {
    const codexPath = this.plugin.getResolvedCodexCliPath();

    new Setting(containerEl)
      .setName(t('settings.codex.cliDetection.name'))
      .setDesc(codexPath
        ? t('settings.codex.cliDetection.resolved', { path: codexPath })
        : t('settings.codex.cliDetection.missing'));
  }

  private renderCodexCliPathSetting(containerEl: HTMLElement): void {
    const hostnameKey = getHostnameKey();
    const placeholder = process.platform === 'win32'
      ? 'C:\\Users\\name\\AppData\\Roaming\\npm\\codex.exe'
      : '/usr/local/bin/codex';

    this.renderBackendCliPathSetting(containerEl, {
      currentValue: this.plugin.settings.codexCliPathsByHost?.[hostnameKey] || '',
      description: t('settings.codex.cliPath.desc'),
      name: `${t('settings.codex.cliPath.name')} (${hostnameKey})`,
      onBlur: async () => {
        await this.cleanupTabsForBackend('codex');
        this.refreshAllTabsBackendUI();
        this.display();
      },
      onChange: async (trimmedValue) => {
        if (!this.plugin.settings.codexCliPathsByHost) {
          this.plugin.settings.codexCliPathsByHost = {};
        }
        this.plugin.settings.codexCliPathsByHost[hostnameKey] = trimmedValue;
        await this.plugin.saveSettings();
      },
      placeholder,
    });
  }

  private renderClaudeCliPathSetting(containerEl: HTMLElement): void {
    const hostnameKey = getHostnameKey();
    const platformDesc = process.platform === 'win32'
      ? t('settings.cliPath.descWindows')
      : t('settings.cliPath.descUnix');
    const placeholder = process.platform === 'win32'
      ? 'D:\\nodejs\\node_global\\node_modules\\@anthropic-ai\\claude-code\\cli.js'
      : '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js';

    this.renderBackendCliPathSetting(containerEl, {
      currentValue: this.plugin.settings.claudeCliPathsByHost?.[hostnameKey] || '',
      description: `${t('settings.cliPath.desc')} ${platformDesc}`,
      name: `${t('settings.cliPath.name')} (${hostnameKey})`,
      onChange: async (trimmedValue) => {
        if (!this.plugin.settings.claudeCliPathsByHost) {
          this.plugin.settings.claudeCliPathsByHost = {};
        }
        this.plugin.settings.claudeCliPathsByHost[hostnameKey] = trimmedValue;
        await this.plugin.saveSettings();
        this.plugin.cliResolver?.reset();
        const view = this.plugin.getView();
        await view?.getTabManager()?.broadcastToAllTabs(
          (service) => Promise.resolve(service.cleanup())
        );
      },
      placeholder,
    });
  }

  private renderBackendCliPathSetting(
    containerEl: HTMLElement,
    options: {
      currentValue: string;
      description: string;
      name: string;
      onBlur?: () => Promise<void> | void;
      onChange: (trimmedValue: string) => Promise<void> | void;
      placeholder: string;
    }
  ): void {
    const cliPathSetting = new Setting(containerEl)
      .setName(options.name)
      .setDesc(options.description);
    const validationEl = this.createCliPathValidationEl(containerEl);

    cliPathSetting.addText((text) => {
      text
        .setPlaceholder(options.placeholder)
        .setValue(options.currentValue)
        .onChange(async (value) => {
          const error = this.validateExecutablePath(value);
          this.setCliPathValidationState(validationEl, text.inputEl, error);
          await options.onChange(value.trim());
        });
      text.inputEl.addClass('claudian-settings-cli-path-input');
      text.inputEl.style.width = '100%';

      if (options.onBlur) {
        text.inputEl.addEventListener('blur', async () => {
          await options.onBlur?.();
        });
      }

      const initialError = this.validateExecutablePath(options.currentValue);
      this.setCliPathValidationState(validationEl, text.inputEl, initialError);
    });
  }

  private createCliPathValidationEl(containerEl: HTMLElement): HTMLDivElement {
    const validationEl = containerEl.createDiv({ cls: 'claudian-cli-path-validation' });
    validationEl.style.color = 'var(--text-error)';
    validationEl.style.fontSize = '0.85em';
    validationEl.style.marginTop = '-0.5em';
    validationEl.style.marginBottom = '0.5em';
    validationEl.style.display = 'none';
    return validationEl;
  }

  private setCliPathValidationState(
    validationEl: HTMLDivElement,
    inputEl: HTMLInputElement,
    error: string | null
  ): void {
    if (!error) {
      validationEl.style.display = 'none';
      inputEl.style.borderColor = '';
      return;
    }

    validationEl.setText(error);
    validationEl.style.display = 'block';
    inputEl.style.borderColor = 'var(--text-error)';
  }

  private validateExecutablePath(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed) return null;

    const expandedPath = expandHomePath(trimmed);

    try {
      if (!fs.existsSync(expandedPath)) {
        return t('settings.cliPath.validation.notExist');
      }

      const stat = fs.statSync(expandedPath);
      if (!stat.isFile()) {
        return t('settings.cliPath.validation.isDirectory');
      }
    } catch {
      return t('settings.cliPath.validation.notExist');
    }

    return null;
  }

  private async cleanupTabsForBackend(backendId: BackendId): Promise<void> {
    for (const view of this.plugin.getAllViews()) {
      const tabManager = view.getTabManager();
      if (!tabManager) continue;

      for (const tab of tabManager.getAllTabs()) {
        if (tab.service?.getBackendId?.() !== backendId) {
          continue;
        }

        tab.service.cleanup();
        tab.service = null;
        tab.serviceInitialized = false;
        tab.ui.modelSelector?.setReady(false);
        updateTabBackendUI(tab, this.plugin);
      }
      view.refreshBackendBadge();
    }
  }

  private refreshAllTabsBackendUI(): void {
    for (const view of this.plugin.getAllViews()) {
      const tabManager = view.getTabManager();
      if (!tabManager) continue;

      for (const tab of tabManager.getAllTabs()) {
        updateTabBackendUI(tab, this.plugin);
      }
      view.refreshBackendBadge();
    }
  }

  private renderContextLimitsSection(): void {
    const container = this.contextLimitsContainer;
    if (!container) return;

    container.empty();

    const envVars = parseEnvironmentVariables(this.plugin.settings.environmentVariables);
    const uniqueModelIds = getCustomModelIds(envVars);

    if (uniqueModelIds.size === 0) {
      return;
    }

    const headerEl = container.createDiv({ cls: 'claudian-context-limits-header' });
    headerEl.createSpan({ text: t('settings.customContextLimits.name'), cls: 'claudian-context-limits-label' });

    const descEl = container.createDiv({ cls: 'claudian-context-limits-desc' });
    descEl.setText(t('settings.customContextLimits.desc'));

    const listEl = container.createDiv({ cls: 'claudian-context-limits-list' });

    for (const modelId of uniqueModelIds) {
      const currentValue = this.plugin.settings.customContextLimits?.[modelId];

      const itemEl = listEl.createDiv({ cls: 'claudian-context-limits-item' });

      const nameEl = itemEl.createDiv({ cls: 'claudian-context-limits-model' });
      nameEl.setText(modelId);

      const inputWrapper = itemEl.createDiv({ cls: 'claudian-context-limits-input-wrapper' });

      const inputEl = inputWrapper.createEl('input', {
        type: 'text',
        placeholder: '200k',
        cls: 'claudian-context-limits-input',
        value: currentValue ? formatContextLimit(currentValue) : '',
      });

      const validationEl = inputWrapper.createDiv({ cls: 'claudian-context-limit-validation' });

      inputEl.addEventListener('input', async () => {
        const trimmed = inputEl.value.trim();

        if (!this.plugin.settings.customContextLimits) {
          this.plugin.settings.customContextLimits = {};
        }

        if (!trimmed) {
          delete this.plugin.settings.customContextLimits[modelId];
          validationEl.style.display = 'none';
          inputEl.classList.remove('claudian-input-error');
        } else {
          const parsed = parseContextLimit(trimmed);
          if (parsed === null) {
            validationEl.setText(t('settings.customContextLimits.invalid'));
            validationEl.style.display = 'block';
            inputEl.classList.add('claudian-input-error');
            return;
          }

          this.plugin.settings.customContextLimits[modelId] = parsed;
          validationEl.style.display = 'none';
          inputEl.classList.remove('claudian-input-error');
        }

        await this.plugin.saveSettings();
      });
    }
  }

  private async refreshIdleTabsForBackendChange(): Promise<void> {
    for (const view of this.plugin.getAllViews()) {
      const tabManager = view.getTabManager();
      if (!tabManager) continue;

      for (const tab of tabManager.getAllTabs()) {
        const hasConversation = !!tab.conversationId;
        const hasMessages = tab.state.messages.length > 0;
        if (hasConversation || hasMessages) {
          continue;
        }

        tab.service?.cleanup();
        tab.service = null;
        tab.serviceInitialized = false;
        tab.ui.modelSelector?.setReady(false);

        updateTabBackendUI(tab, this.plugin);
      }
      view.refreshBackendBadge();
    }

    new Notice('运行设置已更新，新对话将使用最新配置。');
  }

  private async restartServiceForPromptChange(): Promise<void> {
    const view = this.plugin.getView();
    const tabManager = view?.getTabManager();
    if (!tabManager) return;

    try {
      await tabManager.broadcastToAllTabs(
        async (service) => { await service.ensureReady({ force: true }); }
      );
    } catch {
      return;
    }
  }
}

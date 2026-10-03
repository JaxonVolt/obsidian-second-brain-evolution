/**
 * StorageService - Main coordinator for distributed storage system.
 *
 * Manages:
 * - CC settings in .claude/settings.json (CC-compatible, shareable)
 * - Claudian settings in .claude/claudxian-settings.json (Claudian-specific)
 * - Slash commands in .claude/commands/*.md
 * - Chat sessions in .claude/sessions/*.jsonl
 * - MCP configs in .claude/mcp.json
 *
 * Handles migration from legacy formats:
 * - Old settings.json with Claudian fields → split into CC + Claudian files
 * - Old permissions array → CC permissions object
 * - data.json state → claudian-settings.json
 */

import type { App, Plugin } from 'obsidian';
import { Notice } from 'obsidian';

import type {
  CCPermissions,
  CCSettings,
  ClaudeModel,
  Conversation,
  LegacyPermission,
  SlashCommand,
} from '../types';
import {
  createPermissionRule,
  DEFAULT_CC_PERMISSIONS,
  DEFAULT_SETTINGS,
  legacyPermissionsToCCPermissions,
} from '../types';
import { AGENTS_PATH, AgentVaultStorage } from './AgentVaultStorage';
import { CC_SETTINGS_PATH, CCSettingsStorage, isLegacyPermissionsFormat } from './CCSettingsStorage';
import {
  ClaudianSettingsStorage,
  normalizeBlockedCommands,
  type StoredClaudianSettings,
} from './ClaudianSettingsStorage';
import { McpStorage } from './McpStorage';
import {
  CLAUDIAN_ONLY_FIELDS,
  convertEnvObjectToString,
  mergeEnvironmentVariables,
} from './migrationConstants';
import { mutatePluginData } from './PluginDataMutation';
import { SESSIONS_PATH, SessionStorage } from './SessionStorage';
import { SKILLS_PATH, SkillStorage } from './SkillStorage';
import { COMMANDS_PATH, SlashCommandStorage } from './SlashCommandStorage';
import { VaultFileAdapter } from './VaultFileAdapter';

/** Base path for all Claudian storage. */
export const CLAUDE_PATH = '.second-brain/runtime';
const LEGACY_RUNTIME_PATH = '.claude';

/** Legacy settings path (now CC settings). */
export const SETTINGS_PATH = CC_SETTINGS_PATH;

/**
 * Combined settings for the application.
 * Merges CC settings (permissions) with Claudian settings.
 */
export interface CombinedSettings {
  /** CC-compatible settings (permissions, etc.) */
  cc: CCSettings;
  /** Claudian-specific settings */
  claudian: StoredClaudianSettings;
}

/** Legacy data format (pre-split migration). */
interface LegacySettingsJson {
  // Old Claudian fields that were in settings.json
  userName?: string;
  enableBlocklist?: boolean;
  blockedCommands?: unknown;
  model?: string;
  thinkingBudget?: string;
  permissionMode?: string;
  lastNonPlanPermissionMode?: string;
  permissions?: LegacyPermission[];
  excludedTags?: string[];
  mediaFolder?: string;
  environmentVariables?: string;
  envSnippets?: unknown[];
  systemPrompt?: string;
  wechatAdditionalInstructions?: string;
  allowedExportPaths?: string[];
  keyboardNavigation?: unknown;
  claudeCliPath?: string;
  claudeCliPaths?: unknown;
  codexCliPath?: string;
  codexCliPathsByHost?: unknown;
  loadUserClaudeSettings?: boolean;
  enableAutoTitleGeneration?: boolean;
  titleGenerationModel?: string;

  // CC fields
  $schema?: string;
  env?: Record<string, string>;
}

/** Legacy data.json format. */
interface LegacyDataJson {
  activeConversationId?: string | null;
  lastEnvHash?: string;
  lastClaudeModel?: ClaudeModel;
  lastCustomModel?: ClaudeModel;
  conversations?: Conversation[];
  slashCommands?: SlashCommand[];
  migrationVersion?: number;
  // May also contain old settings if not yet migrated
  [key: string]: unknown;
}

// CLAUDIAN_ONLY_FIELDS is imported from ./migrationConstants

export class StorageService {
  readonly ccSettings: CCSettingsStorage;
  readonly claudianSettings: ClaudianSettingsStorage;
  readonly commands: SlashCommandStorage;
  readonly skills: SkillStorage;
  readonly sessions: SessionStorage;
  readonly mcp: McpStorage;
  readonly agents: AgentVaultStorage;

  private adapter: VaultFileAdapter;
  private plugin: Plugin;
  private app: App;

  constructor(plugin: Plugin) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.adapter = new VaultFileAdapter(this.app);
    this.ccSettings = new CCSettingsStorage(this.adapter);
    this.claudianSettings = new ClaudianSettingsStorage(this.adapter);
    this.commands = new SlashCommandStorage(this.adapter);
    this.skills = new SkillStorage(this.adapter);
    this.sessions = new SessionStorage(this.adapter);
    this.mcp = new McpStorage(this.adapter);
    this.agents = new AgentVaultStorage(this.adapter);
  }

  async initialize(): Promise<CombinedSettings> {
    await this.ensureDirectories();
    await this.migrateLegacyRuntime();
    await this.runMigrations();

    const cc = await this.ccSettings.load();
    const claudian = await this.claudianSettings.load();

    return { cc, claudian };
  }

  private async migrateLegacyRuntime(): Promise<void> {
    if (!(await this.adapter.exists(LEGACY_RUNTIME_PATH))) return;

    const fileMappings: Array<[string, string]> = [
      [`${LEGACY_RUNTIME_PATH}/claudxian-settings.json`, '.second-brain/runtime/settings.json'],
      [`${LEGACY_RUNTIME_PATH}/settings.json`, '.second-brain/runtime/permissions.json'],
      [`${LEGACY_RUNTIME_PATH}/mcp.json`, '.second-brain/runtime/mcp.json'],
    ];
    const folderMappings: Array<[string, string]> = [
      [`${LEGACY_RUNTIME_PATH}/commands`, COMMANDS_PATH],
      [`${LEGACY_RUNTIME_PATH}/skills`, SKILLS_PATH],
      [`${LEGACY_RUNTIME_PATH}/sessions`, SESSIONS_PATH],
      [`${LEGACY_RUNTIME_PATH}/agents`, AGENTS_PATH],
    ];

    let copied = 0;
    for (const [source, target] of fileMappings) {
      if (!(await this.adapter.exists(source)) || await this.adapter.exists(target)) continue;
      await this.adapter.write(target, await this.adapter.read(source));
      copied++;
    }
    for (const [sourceFolder, targetFolder] of folderMappings) {
      for (const source of await this.adapter.listFilesRecursive(sourceFolder)) {
        const relative = source.slice(sourceFolder.length).replace(/^\//, '');
        const target = `${targetFolder}/${relative}`;
        if (await this.adapter.exists(target)) continue;
        await this.adapter.write(target, await this.adapter.read(source));
        copied++;
      }
    }

    if (copied > 0) {
      await this.adapter.write('.second-brain/runtime/migration.json', JSON.stringify({
        copiedFiles: copied,
        migratedAt: new Date().toISOString(),
        source: 'legacy-runtime',
      }, null, 2));
    }
  }

  private async runMigrations(): Promise<void> {
    const ccExists = await this.ccSettings.exists();
    const claudianExists = await this.claudianSettings.exists();
    const dataJson = await this.loadDataJson();

    // Check if old settings.json has Claudian fields that need migration
    if (ccExists && !claudianExists) {
      await this.migrateFromOldSettingsJson();
    }

    if (dataJson) {
      const hasState = this.hasStateToMigrate(dataJson);
      const hasLegacyContent = this.hasLegacyContentToMigrate(dataJson);

      // Migrate data.json state to claudian-settings.json
      if (hasState) {
        await this.migrateFromDataJson(dataJson);
      }

      // Migrate slash commands and conversations from data.json
      let legacyContentHadErrors = false;
      if (hasLegacyContent) {
        const result = await this.migrateLegacyDataJsonContent(dataJson);
        legacyContentHadErrors = result.hadErrors;
      }

      // Clear legacy data.json only after successful migrations
      if ((hasState || hasLegacyContent) && !legacyContentHadErrors) {
        await this.clearLegacyDataJson();
      }
    }
  }

  private hasStateToMigrate(data: LegacyDataJson): boolean {
    return (
      data.lastEnvHash !== undefined ||
      data.lastClaudeModel !== undefined ||
      data.lastCustomModel !== undefined
    );
  }

  private hasLegacyContentToMigrate(data: LegacyDataJson): boolean {
    return (
      (data.slashCommands?.length ?? 0) > 0 ||
      (data.conversations?.length ?? 0) > 0
    );
  }

  /**
   * Migrate from old settings.json (with Claudian fields) to split format.
   *
   * Handles:
   * - Legacy Claudian fields (userName, model, etc.) → claudian-settings.json
   * - Legacy permissions array → CC permissions object
   * - CC env object → Claudian environmentVariables string
   * - Preserves existing CC permissions if already in CC format
   */
  private async migrateFromOldSettingsJson(): Promise<void> {
    const content = await this.adapter.read(CC_SETTINGS_PATH);
    const oldSettings = JSON.parse(content) as LegacySettingsJson;

    const hasClaudianFields = Array.from(CLAUDIAN_ONLY_FIELDS).some(
      field => (oldSettings as Record<string, unknown>)[field] !== undefined
    );

    if (!hasClaudianFields) {
      return;
    }

    // Handle environment variables: merge Claudian string format with CC object format
    let environmentVariables = oldSettings.environmentVariables ?? '';
    if (oldSettings.env && typeof oldSettings.env === 'object') {
      const envFromCC = convertEnvObjectToString(oldSettings.env);
      if (envFromCC) {
        environmentVariables = mergeEnvironmentVariables(environmentVariables, envFromCC);
      }
    }

    const claudianFields: Partial<StoredClaudianSettings> = {
      userName: oldSettings.userName ?? DEFAULT_SETTINGS.userName,
      enableBlocklist: oldSettings.enableBlocklist ?? DEFAULT_SETTINGS.enableBlocklist,
      blockedCommands: normalizeBlockedCommands(oldSettings.blockedCommands),
      model: (oldSettings.model as ClaudeModel) ?? DEFAULT_SETTINGS.model,
      thinkingBudget: (oldSettings.thinkingBudget as StoredClaudianSettings['thinkingBudget']) ?? DEFAULT_SETTINGS.thinkingBudget,
      permissionMode: (oldSettings.permissionMode as StoredClaudianSettings['permissionMode']) ?? DEFAULT_SETTINGS.permissionMode,
      excludedTags: oldSettings.excludedTags ?? DEFAULT_SETTINGS.excludedTags,
      mediaFolder: oldSettings.mediaFolder ?? DEFAULT_SETTINGS.mediaFolder,
      environmentVariables, // Merged from both sources
      envSnippets: oldSettings.envSnippets as StoredClaudianSettings['envSnippets'] ?? DEFAULT_SETTINGS.envSnippets,
      systemPrompt: oldSettings.systemPrompt ?? DEFAULT_SETTINGS.systemPrompt,
      wechatAdditionalInstructions: oldSettings.wechatAdditionalInstructions
        ?? DEFAULT_SETTINGS.wechatAdditionalInstructions,
      allowedExportPaths: oldSettings.allowedExportPaths ?? DEFAULT_SETTINGS.allowedExportPaths,
      persistentExternalContextPaths: DEFAULT_SETTINGS.persistentExternalContextPaths,
      keyboardNavigation: oldSettings.keyboardNavigation as StoredClaudianSettings['keyboardNavigation'] ?? DEFAULT_SETTINGS.keyboardNavigation,
      claudeCliPath: oldSettings.claudeCliPath ?? DEFAULT_SETTINGS.claudeCliPath,
      claudeCliPathsByHost: DEFAULT_SETTINGS.claudeCliPathsByHost,  // Migration to hostname-based handled in main.ts
      codexCliPath: oldSettings.codexCliPath ?? DEFAULT_SETTINGS.codexCliPath,
      codexCliPathsByHost: oldSettings.codexCliPathsByHost as StoredClaudianSettings['codexCliPathsByHost'] ?? DEFAULT_SETTINGS.codexCliPathsByHost,
      loadUserClaudeSettings: oldSettings.loadUserClaudeSettings ?? DEFAULT_SETTINGS.loadUserClaudeSettings,
      enableAutoTitleGeneration: oldSettings.enableAutoTitleGeneration ?? DEFAULT_SETTINGS.enableAutoTitleGeneration,
      titleGenerationModel: oldSettings.titleGenerationModel ?? DEFAULT_SETTINGS.titleGenerationModel,
      lastClaudeModel: DEFAULT_SETTINGS.lastClaudeModel,
      lastCustomModel: DEFAULT_SETTINGS.lastCustomModel,
      lastEnvHash: DEFAULT_SETTINGS.lastEnvHash,
    };

    // Save Claudian settings FIRST (before stripping from settings.json)
    await this.claudianSettings.save(claudianFields as StoredClaudianSettings);

    // Verify Claudian settings were saved
    const savedClaudian = await this.claudianSettings.load();
    if (!savedClaudian || savedClaudian.userName === undefined) {
      throw new Error('Failed to verify claudian-settings.json was saved correctly');
    }

    // Handle permissions: convert legacy format OR preserve existing CC format
    let ccPermissions: CCPermissions;
    if (isLegacyPermissionsFormat(oldSettings)) {
      ccPermissions = legacyPermissionsToCCPermissions(oldSettings.permissions);
    } else if (oldSettings.permissions && typeof oldSettings.permissions === 'object' && !Array.isArray(oldSettings.permissions)) {
      // Already in CC format - preserve it including defaultMode and additionalDirectories
      const existingPerms = oldSettings.permissions as unknown as CCPermissions;
      ccPermissions = {
        allow: existingPerms.allow ?? [],
        deny: existingPerms.deny ?? [],
        ask: existingPerms.ask ?? [],
        defaultMode: existingPerms.defaultMode,
        additionalDirectories: existingPerms.additionalDirectories,
      };
    } else {
      ccPermissions = { ...DEFAULT_CC_PERMISSIONS };
    }

    // Rewrite settings.json with only CC fields
    const ccSettings: CCSettings = {
      permissions: ccPermissions,
    };

    // Pass true to strip Claudian-only fields during migration
    await this.ccSettings.save(ccSettings, true);
  }

  private async migrateFromDataJson(dataJson: LegacyDataJson): Promise<void> {
    const claudian = await this.claudianSettings.load();

    // Only migrate if not already set (claudian-settings.json takes precedence)
    if (dataJson.lastEnvHash !== undefined && !claudian.lastEnvHash) {
      claudian.lastEnvHash = dataJson.lastEnvHash;
    }
    if (dataJson.lastClaudeModel !== undefined && !claudian.lastClaudeModel) {
      claudian.lastClaudeModel = dataJson.lastClaudeModel;
    }
    if (dataJson.lastCustomModel !== undefined && !claudian.lastCustomModel) {
      claudian.lastCustomModel = dataJson.lastCustomModel;
    }

    await this.claudianSettings.save(claudian);
  }

  private async migrateLegacyDataJsonContent(dataJson: LegacyDataJson): Promise<{ hadErrors: boolean }> {
    let hadErrors = false;

    if (dataJson.slashCommands && dataJson.slashCommands.length > 0) {
      for (const command of dataJson.slashCommands) {
        try {
          const filePath = this.commands.getFilePath(command);
          if (await this.adapter.exists(filePath)) {
            continue;
          }
          await this.commands.save(command);
        } catch {
          hadErrors = true;
        }
      }
    }

    if (dataJson.conversations && dataJson.conversations.length > 0) {
      for (const conversation of dataJson.conversations) {
        try {
          const filePath = this.sessions.getFilePath(conversation.id);
          if (await this.adapter.exists(filePath)) {
            continue;
          }
          await this.sessions.saveConversation(conversation);
        } catch {
          hadErrors = true;
        }
      }
    }

    return { hadErrors };
  }

  private async clearLegacyDataJson(): Promise<void> {
    await mutatePluginData(this.plugin, (data) => {
      delete data.lastEnvHash;
      delete data.lastClaudeModel;
      delete data.lastCustomModel;
      delete data.conversations;
      delete data.slashCommands;
      delete data.migrationVersion;
    });
  }

  private async loadDataJson(): Promise<LegacyDataJson | null> {
    try {
      const data = await this.plugin.loadData();
      return data || null;
    } catch {
      // data.json may not exist on fresh installs
      return null;
    }
  }

  async ensureDirectories(): Promise<void> {
    await this.adapter.ensureFolder(CLAUDE_PATH);
    await this.adapter.ensureFolder(COMMANDS_PATH);
    await this.adapter.ensureFolder(SKILLS_PATH);
    await this.adapter.ensureFolder(SESSIONS_PATH);
    await this.adapter.ensureFolder(AGENTS_PATH);
  }

  async loadAllSlashCommands(): Promise<SlashCommand[]> {
    const commands = await this.commands.loadAll();
    const skills = await this.skills.loadAll();
    return [...commands, ...skills];
  }

  getAdapter(): VaultFileAdapter {
    return this.adapter;
  }

  async getPermissions(): Promise<CCPermissions> {
    return this.ccSettings.getPermissions();
  }

  async updatePermissions(permissions: CCPermissions): Promise<void> {
    return this.ccSettings.updatePermissions(permissions);
  }

  async addAllowRule(rule: string): Promise<void> {
    return this.ccSettings.addAllowRule(createPermissionRule(rule));
  }

  async addDenyRule(rule: string): Promise<void> {
    return this.ccSettings.addDenyRule(createPermissionRule(rule));
  }

  /**
   * Remove a permission rule from all lists.
   */
  async removePermissionRule(rule: string): Promise<void> {
    return this.ccSettings.removeRule(createPermissionRule(rule));
  }

  async updateClaudianSettings(updates: Partial<StoredClaudianSettings>): Promise<void> {
    return this.claudianSettings.update(updates);
  }

  async saveClaudianSettings(settings: Partial<StoredClaudianSettings>): Promise<void> {
    return this.claudianSettings.save(settings);
  }

  async loadClaudianSettings(): Promise<StoredClaudianSettings> {
    return this.claudianSettings.load();
  }

  /**
   * Get legacy activeConversationId from storage (claudian-settings.json or data.json).
   */
  async getLegacyActiveConversationId(): Promise<string | null> {
    const fromSettings = await this.claudianSettings.getLegacyActiveConversationId();
    if (fromSettings) {
      return fromSettings;
    }

    const dataJson = await this.loadDataJson();
    if (dataJson && typeof dataJson.activeConversationId === 'string') {
      return dataJson.activeConversationId;
    }

    return null;
  }

  /**
   * Remove legacy activeConversationId from storage after migration.
   */
  async clearLegacyActiveConversationId(): Promise<void> {
    await this.claudianSettings.clearLegacyActiveConversationId();

    const dataJson = await this.loadDataJson();
    if (!dataJson || !('activeConversationId' in dataJson)) {
      return;
    }

    await mutatePluginData(this.plugin, (data) => { delete data.activeConversationId; });
  }

  /**
   * Get tab manager state from data.json with runtime validation.
   */
  async getTabManagerState(): Promise<TabManagerPersistedState | null> {
    try {
      const data = await this.plugin.loadData();
      if (data?.tabManagerState) {
        return this.validateTabManagerState(data.tabManagerState);
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Validates and sanitizes tab manager state from storage.
   * Returns null if the data is invalid or corrupted.
   */
  private validateTabManagerState(data: unknown): TabManagerPersistedState | null {
    if (!data || typeof data !== 'object') {
      return null;
    }

    const state = data as Record<string, unknown>;

    if (!Array.isArray(state.openTabs)) {
      return null;
    }

    const validatedTabs: Array<{ tabId: string; conversationId: string | null }> = [];
    for (const tab of state.openTabs) {
      if (!tab || typeof tab !== 'object') {
        continue; // Skip invalid entries
      }
      const tabObj = tab as Record<string, unknown>;
      if (typeof tabObj.tabId !== 'string') {
        continue; // Skip entries without valid tabId
      }
      validatedTabs.push({
        tabId: tabObj.tabId,
        conversationId:
          typeof tabObj.conversationId === 'string' ? tabObj.conversationId : null,
      });
    }

    const activeTabId =
      typeof state.activeTabId === 'string' ? state.activeTabId : null;

    return {
      openTabs: validatedTabs,
      activeTabId,
    };
  }

  async setTabManagerState(state: TabManagerPersistedState): Promise<void> {
    try {
      await mutatePluginData(this.plugin, (data) => { data.tabManagerState = state; });
    } catch {
      new Notice('Failed to save tab layout');
    }
  }
}

/**
 * Persisted state for the tab manager.
 * Stored in data.json (machine-specific, not shared).
 */
export interface TabManagerPersistedState {
  openTabs: Array<{ tabId: string; conversationId: string | null }>;
  activeTabId: string | null;
}

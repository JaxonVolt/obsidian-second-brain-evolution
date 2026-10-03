/**
 * Claudian - Obsidian plugin entry point
 *
 * Registers the sidebar chat view, settings tab, and commands.
 * Manages conversation persistence and environment variable configuration.
 */

/* eslint-disable simple-import-sort/imports */

import { Notice, Plugin } from 'obsidian';

import type { AgentManager } from './core/agents';
import { DailyNoteInfoService } from './core/knowledge/DailyNoteInfoService';
import {
  ActionLifecycleService,
  type ActionLifecycleRecord,
} from './core/knowledge/ActionLifecycleService';
import { ActionReminderService } from './core/knowledge/ActionReminderService';
import { ActionWorkbenchService, recurrenceLabel } from './core/knowledge/ActionWorkbenchService';
import { InboxCaptureService } from './core/knowledge/InboxCaptureService';
import { InboxDigestService } from './core/knowledge/InboxDigestService';
import { ensureKnowledgeRuntime } from './core/knowledge/KnowledgeRuntime';
import { LlmWikiService } from './core/knowledge/LlmWikiService';
import { WorkLogService } from './core/knowledge/WorkLogService';
import {
  type InsightRecord,
  ProactiveInsightService,
} from './core/knowledge/ProactiveInsightService';
import {
  ProactiveReviewService,
  type ReviewItem,
  type ReviewScanResult,
} from './core/knowledge/ProactiveReviewService';
import { SecondBrainInitializer } from './core/knowledge/SecondBrainInitializer';
import { getConfiguredModel } from './core/model';
import { WeChatChannelService } from './core/wechat/WeChatChannelService';
import { McpServerManager } from './core/mcp';
import type { PluginManager } from './core/plugins';
import { StorageService } from './core/storage';
import { isSubagentToolName, TOOL_TASK } from './core/tools/toolNames';
import type {
  BackendId,
  ChatMessage,
  ClaudianSettings,
  Conversation,
  ConversationMeta,
  SlashCommand,
  SubagentInfo,
} from './core/types';
import {
  BACKEND_CLAUDE,
  BACKEND_CODEX,
  CODEX_PERFORMANCE_PROFILES,
  DEFAULT_CLAUDE_MODELS,
  DEFAULT_SETTINGS,
  getBackendCapabilities,
  getCliPlatformKey,
  getHostnameKey,
  normalizeBackendId,
  VIEW_TYPE_CLAUDIAN,
} from './core/types';
import { ClaudianView } from './features/chat/ClaudianView';
import { updateTabBackendUI } from './features/chat/tabs/Tab';
import { ActionWorkbenchModal } from './features/action/ActionWorkbenchModal';
import { InboxDigestModal } from './features/inbox/InboxDigestModal';
import { MemoryButlerModal } from './features/butler/MemoryButlerModal';
import { SecondBrainOnboardingModal } from './features/onboarding/SecondBrainOnboardingModal';
import { DecisionCreateModal } from './features/review/DecisionCreateModal';
import { SecondBrainSettingTab } from './features/settings/SecondBrainSettings';
import { WeChatConnectModal } from './features/wechat/WeChatConnectModal';
import { setLocale } from './i18n';
import type { ClaudeCliResolver } from './utils/claudeCli';
import { resolveConfiguredCodexCliPath } from './utils/codexCli';
import { getCurrentModelFromEnvironment, getModelsFromEnvironment, parseEnvironmentVariables } from './utils/env';
import { getVaultPath } from './utils/path';
import {
  deleteSDKSession,
  loadSDKSessionMessages,
  loadSubagentToolCalls,
  sdkSessionExists,
  type SDKSessionLoadResult,
} from './utils/sdkSession';

/**
 * Main plugin class for Claudian.
 * Handles plugin lifecycle, settings persistence, and conversation management.
 */
export default class ClaudianPlugin extends Plugin {
  settings: ClaudianSettings;
  mcpManager: McpServerManager;
  pluginManager: PluginManager;
  agentManager: AgentManager;
  storage: StorageService;
  cliResolver?: ClaudeCliResolver;
  private conversations: Conversation[] = [];
  private runtimeEnvironmentVariables = '';
  private inboxCaptureService: InboxCaptureService;
  private dailyNoteInfoService: DailyNoteInfoService;
  private workLogService: WorkLogService;
  private knowledgeInitializer: SecondBrainInitializer;
  private proactiveReviewService: ProactiveReviewService;
  private actionLifecycleService: ActionLifecycleService;
  actionWorkbenchService: ActionWorkbenchService;
  private actionReminderService: ActionReminderService;
  private proactiveReviewCount = 0;
  private proactiveReviewRibbonEl: HTMLElement | null = null;
  private proactiveReviewRefreshTimer: number | null = null;
  private proactiveInsightService: ProactiveInsightService;
  private proactiveInsightCount = 0;
  private proactiveInsightRibbonEl: HTMLElement | null = null;
  llmWikiService: LlmWikiService;
  weChatService: WeChatChannelService;

  async onload() {
    await this.loadSettings();
    await ensureKnowledgeRuntime(this.app);
    this.knowledgeInitializer = new SecondBrainInitializer(this.app);
    this.inboxCaptureService = new InboxCaptureService(this.app);
    this.dailyNoteInfoService = new DailyNoteInfoService(this.app, () => ({
      enabled: this.settings.dailyInfoEnabled,
    }));
    this.workLogService = new WorkLogService(this.app);
    this.actionWorkbenchService = new ActionWorkbenchService(this.app);
    this.actionReminderService = new ActionReminderService(this.app, this.actionWorkbenchService);
    this.proactiveReviewService = new ProactiveReviewService(this.app, () => ({
      enabled: this.settings.proactiveReviewEnabled,
      projectStaleDays: this.settings.proactiveReviewProjectStaleDays,
      weeklyActionDays: this.settings.proactiveReviewWeeklyActionDays,
      maxVisible: this.settings.proactiveReviewMaxVisible,
      startupNotice: this.settings.proactiveReviewStartupNotice,
    }));
    this.actionLifecycleService = new ActionLifecycleService(this.app, this, () => ({
      enabled: this.settings.proactiveReviewEnabled,
      viewportItems: this.settings.proactiveReviewMaxVisible,
    }));
    this.proactiveInsightService = new ProactiveInsightService(this.app, this, () => ({
      enabled: this.settings.proactiveInsightsEnabled,
      autoAnalyze: this.settings.proactiveInsightsAutoAnalyze,
      minChangedNotes: this.settings.proactiveInsightsMinChangedNotes,
      dailyLimit: this.settings.proactiveInsightsDailyLimit,
      viewportItems: this.settings.proactiveInsightsViewportItems,
      startupNotice: this.settings.proactiveInsightsStartupNotice,
    }));
    this.llmWikiService = new LlmWikiService(
      this.app,
      () => this.settings,
      () => this.getResolvedCodexCliPath(),
    );
    this.weChatService = new WeChatChannelService(this);

    // Initialize MCP manager (shared for agent + UI)
    this.mcpManager = new McpServerManager(this.storage.mcp);
    await this.mcpManager.loadServers();

    this.registerView(
      VIEW_TYPE_CLAUDIAN,
      (leaf) => new ClaudianView(leaf, this)
    );

    this.addRibbonIcon('brain-circuit', '打开第二大脑', () => {
      this.activateView();
    });
    this.addRibbonIcon('briefcase-business', '打开或创建今天的工作日志', () => {
      void this.openTodayWorkLog();
    });
    this.proactiveReviewRibbonEl = this.addRibbonIcon('list-checks', '行动工作台', () => {
      this.openActionWorkbench();
    });
    if (this.proactiveReviewRibbonEl) {
      this.proactiveReviewRibbonEl.addClass('second-brain-review-ribbon');
      this.proactiveReviewRibbonEl.dataset.reviewCount = '0';
    }
    this.proactiveInsightRibbonEl = this.addRibbonIcon('bell-ring', '记忆管家', () => {
      this.openProactiveInsights();
    });
    if (this.proactiveInsightRibbonEl) {
      this.proactiveInsightRibbonEl.addClass('second-brain-insight-ribbon');
      this.proactiveInsightRibbonEl.dataset.insightCount = '0';
    }

    this.addCommand({
      id: 'open-view',
      name: '打开第二大脑',
      callback: () => {
        this.activateView();
      },
    });

    const knowledgeCommands = [
      { id: 'open-today-note', name: '打开或创建今日日记', command: 'today' },
      { id: 'open-today-work-log', name: '打开或创建今天的工作日志', command: 'work-log' },
      { id: 'knowledge-organize-recent-logs', name: '知识演化：整理近期日志', command: 'organize-recent-logs' },
      { id: 'knowledge-digest', name: '知识演化：消化收件箱', command: 'digest' },
      { id: 'knowledge-current-status', name: '知识演化：分析现状', command: 'current-status' },
      { id: 'knowledge-health-check', name: '知识演化：系统体检', command: 'health-check' },
    ];
    for (const item of knowledgeCommands) {
      this.addCommand({
        id: item.id,
        name: item.name,
        callback: () => { void this.runKnowledgeCommand(item.command); },
      });
    }

    this.addCommand({
      id: 'capture-to-inbox',
      name: '将输入存入收件箱',
      callback: () => { void this.focusCaptureInput(); },
    });

    this.addCommand({
      id: 'initialize-second-brain',
      name: '初始化或补全第二大脑骨架',
      callback: () => this.openKnowledgeInitializer(),
    });

    this.addCommand({
      id: 'proactive-review',
      name: '行动工作台：打开',
      callback: () => this.openActionWorkbench(),
    });

    this.addCommand({
      id: 'proactive-review-scan-now',
      name: '行动与复盘：立即核对',
      callback: () => { void this.runProactiveReviewCheck(true); },
    });

    this.addCommand({
      id: 'create-tracked-decision',
      name: '行动与复盘：记录一项决策',
      callback: () => {
        new DecisionCreateModal(this.app, this.proactiveReviewService, () => {
          void this.runProactiveReviewCheck(false, false);
        }).open();
      },
    });

    this.addCommand({
      id: 'open-proactive-insights',
      name: '记忆管家：打开',
      callback: () => this.openProactiveInsights(),
    });

    this.addCommand({
      id: 'connect-long-term-memory',
      name: '长期记忆库：连接或刷新状态',
      callback: async () => {
        const status = await this.llmWikiService.start();
        new Notice(status.detail);
      },
    });

    this.addCommand({
      id: 'generate-proactive-insights',
      name: '主动洞察：分析新增和修改笔记',
      callback: () => { void this.generateProactiveInsights(false, true); },
    });

    this.addCommand({
      id: 'analyze-existing-knowledge',
      name: '主动洞察：分析现有知识库',
      callback: () => { void this.generateProactiveInsights(true, true); },
    });

    this.addCommand({
      id: 'connect-wechat-bot',
      name: '微信远程入口：扫码连接',
      callback: () => new WeChatConnectModal(this.app, this).open(),
    });

    this.addCommand({
      id: 'toggle-wechat-inbox',
      name: '微信远程入口：开始或停止接收',
      callback: () => {
        if (this.weChatService.isRunning()) void this.weChatService.stop();
        else void this.weChatService.start();
      },
    });

    this.addCommand({
      id: 'new-tab',
      name: '新建对话标签页',
      checkCallback: (checking: boolean) => {
        const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_CLAUDIAN)[0];
        if (!leaf) return false;

        const view = leaf.view as ClaudianView;
        const tabManager = view.getTabManager();
        if (!tabManager) return false;

        if (!tabManager.canCreateTab()) return false;

        if (!checking) {
          tabManager.createTab();
        }
        return true;
      },
    });

    this.addCommand({
      id: 'new-session',
      name: '在当前标签页新建对话',
      checkCallback: (checking: boolean) => {
        const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_CLAUDIAN)[0];
        if (!leaf) return false;

        const view = leaf.view as ClaudianView;
        const tabManager = view.getTabManager();
        if (!tabManager) return false;

        const activeTab = tabManager.getActiveTab();
        if (!activeTab) return false;

        if (activeTab.state.isStreaming) return false;

        if (!checking) {
          tabManager.createNewConversation();
        }
        return true;
      },
    });

    this.addCommand({
      id: 'close-current-tab',
      name: '关闭当前对话标签页',
      checkCallback: (checking: boolean) => {
        const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_CLAUDIAN)[0];
        if (!leaf) return false;

        const view = leaf.view as ClaudianView;
        const tabManager = view.getTabManager();
        if (!tabManager) return false;

        if (!checking) {
          const activeTabId = tabManager.getActiveTabId();
          if (activeTabId) {
            // When closing the last tab, TabManager will create a new empty one
            tabManager.closeTab(activeTabId);
          }
        }
        return true;
      },
    });

    this.addSettingTab(new SecondBrainSettingTab(this.app, this));
    const invalidateRecord = (path: string) => {
      this.actionWorkbenchService.handleVaultChange(path);
      this.llmWikiService.invalidate(path);
    };
    this.registerEvent(this.app.vault.on('create', (file) => invalidateRecord(file.path)));
    this.register(() => this.actionWorkbenchService.dispose());
    this.registerEvent(this.app.vault.on('modify', (file) => invalidateRecord(file.path)));
    this.registerEvent(this.app.vault.on('delete', (file) => invalidateRecord(file.path)));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      invalidateRecord(oldPath);
      invalidateRecord(file.path);
    }));
    this.registerEvent(this.app.workspace.on('file-open', (file) => {
      if (file) void this.dailyNoteInfoService.ensureForFile(file);
    }));
    this.registerEvent(this.app.vault.on('modify', (file) => {
      if (!this.settings.proactiveReviewEnabled || !this.proactiveReviewService.isRelevantPath(file.path)) return;
      if (this.proactiveReviewRefreshTimer !== null) {
        window.clearTimeout(this.proactiveReviewRefreshTimer);
      }
      this.proactiveReviewRefreshTimer = window.setTimeout(() => {
        this.proactiveReviewRefreshTimer = null;
        void this.runProactiveReviewCheck(false, false);
      }, 800);
    }));
    this.app.workspace.onLayoutReady(() => {
      void this.maybeShowKnowledgeInitializer();
      void this.refreshTodayInfo();
      void this.actionWorkbenchService.initialize().catch((error) => {
        console.warn('Action workbench initialization failed:', error);
      });
      void this.actionReminderService.check().catch((error) => {
        console.warn('Action reminder check failed:', error);
      });
      const timer = window.setTimeout(() => {
        void this.runDailyProactiveReview();
        void this.runDailyProactiveInsights();
      }, 5000);
      this.register(() => window.clearTimeout(timer));
      if (this.settings.llmWikiAutoStart) {
        void this.llmWikiService.start().catch((error) => {
          console.warn('LLM Wiki startup failed:', error);
        });
      }
    });
    this.registerInterval(window.setInterval(() => {
      void this.actionReminderService.check().catch((error) => {
        console.warn('Action reminder check failed:', error);
      });
    }, 60_000));
    if (this.settings.wechatAutoStart) await this.weChatService.start();
  }

  async onunload() {
    if (this.proactiveReviewRefreshTimer !== null) {
      window.clearTimeout(this.proactiveReviewRefreshTimer);
      this.proactiveReviewRefreshTimer = null;
    }
    await this.weChatService?.stop();
    await this.llmWikiService?.stop();
    // Ensures state is saved even if Obsidian quits without calling onClose()
    for (const view of this.getAllViews()) {
      const tabManager = view.getTabManager();
      if (tabManager) {
        const state = tabManager.getPersistedState();
        await this.storage.setTabManagerState(state);
      }
    }
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_CLAUDIAN)[0];

    if (!leaf) {
      const newLeaf = this.settings.openInMainTab
        ? workspace.getLeaf('tab')
        : workspace.getRightLeaf(false);
      if (newLeaf) {
        await newLeaf.setViewState({
          type: VIEW_TYPE_CLAUDIAN,
          active: true,
        });
        leaf = newLeaf;
      }
    }

    if (leaf) {
      workspace.revealLeaf(leaf);
    }
  }

  private async waitForActiveTab() {
    await this.activateView();
    for (let attempt = 0; attempt < 20; attempt++) {
      const tab = this.getView()?.getActiveTab();
      if (tab?.controllers.inputController) {
        return tab;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    }
    return null;
  }

  async runKnowledgeCommand(command: string): Promise<void> {
    if (command === 'today') {
      await this.openTodayNote();
      return;
    }
    if (command === 'work-log') {
      await this.openTodayWorkLog();
      return;
    }
    if (command === 'digest') {
      this.openInboxDigest();
      return;
    }
    const tab = await this.waitForActiveTab();
    if (!tab?.controllers.inputController) {
      new Notice('知识演化面板尚未准备好，请稍后重试。');
      return;
    }
    await tab.controllers.inputController.sendMessage({ content: `/${command}` });
  }

  async captureToInbox(content: string): Promise<string> {
    const path = await this.inboxCaptureService.capture(content);
    new Notice('已原样存入收件箱，等待你之后消化。');
    return path;
  }

  openInboxDigest(): void {
    new InboxDigestModal(this.app, new InboxDigestService(this.app, this)).open();
  }

  openKnowledgeInitializer(): void {
    new SecondBrainOnboardingModal(this.app, this.knowledgeInitializer, 'manual').open();
  }

  openActionWorkbench(initialView?: string): void {
    new ActionWorkbenchModal(this.app, this, this.actionWorkbenchService, initialView).open();
  }

  openProactiveReview(): void {
    this.openProactiveInsights();
  }

  openProactiveInsights(): void {
    new MemoryButlerModal(
      this.app,
      this,
      this.actionLifecycleService,
      this.proactiveReviewService,
      this.proactiveInsightService,
      this.actionWorkbenchService,
      {
      openSource: async (path) => {
        if (path) await this.app.workspace.openLinkText(path, '', false);
      },
      discussInsight: async (insight) => this.discussInsight(insight),
      discussAction: async (record) => this.discussActionCandidate(record),
      discussReview: async (item) => this.startProactiveReview(item),
      openWorkbench: (view) => this.openActionWorkbench(view),
      onCountChanged: (count) => this.updateProactiveInsightCount(count),
      },
    ).open();
  }

  getProactiveReviewCount(): number {
    return this.proactiveReviewCount;
  }

  getProactiveInsightCount(): number {
    return this.proactiveInsightCount;
  }

  async actionLifecycleServiceForButler(): Promise<string[]> {
    if (this.settings.memoryButlerMode === 'off') return [];
    const modules = new Set(this.settings.memoryButlerModules);
    const [lifecycle, review, longTermDue] = await Promise.all([
      modules.has('action-discovery') || modules.has('progress') ? this.actionLifecycleService.getCenter() : { discoveries: [], progress: [] },
      modules.has('review') ? this.proactiveReviewService.scan() : { items: [] },
      this.actionWorkbenchService.getLongTermDue(),
    ]);
    const limit = Math.max(1, Math.min(20, this.settings.memoryButlerMaxBriefItems));
    return [
      ...longTermDue.map((item) => `${item.title}：${recurrenceLabel(item)}，本次尚未完成。`),
      ...(modules.has('action-discovery') ? lifecycle.discoveries.map((item) => `${item.title}：还准备继续吗？`) : []),
      ...(modules.has('progress') ? lifecycle.progress.map((item) => `${item.title}：是否同步这项进度？`) : []),
      ...(modules.has('review') ? review.items.map((item) => `${item.title}：${item.reason}`) : []),
    ].slice(0, limit);
  }

  async proactiveInsightSummaryForButler(): Promise<string[]> {
    if (this.settings.memoryButlerMode === 'off' || !this.settings.memoryButlerModules.includes('insight')) return [];
    const center = await this.proactiveInsightService.getCenter('pending');
    const limit = Math.max(1, Math.min(20, this.settings.memoryButlerMaxBriefItems));
    return center.items
      .map((item) => item.observation?.readyForReview
        ? `${item.title}：待验证经验已达到复盘条件，请决定沉淀、继续观察或放弃。`
        : `${item.title}：${item.suggestedAction || '需要你确认如何处理'}`)
      .slice(0, limit);
  }

  async refreshProactiveInsightCount(): Promise<void> {
    try {
      this.updateProactiveInsightCount(await this.proactiveInsightService.getPendingCount());
    } catch {
      this.updateProactiveInsightCount(0);
    }
  }

  async generateProactiveInsights(forceAll = false, notify = true): Promise<void> {
    if (!this.settings.proactiveInsightsEnabled && !forceAll) return;
    try {
      const result = await this.proactiveInsightService.analyze(forceAll);
      await this.refreshProactiveInsightCount();
      if (!notify) return;
      if (result.baselineEstablished) {
        const suffix = result.invalidated > 0 ? `；已移出 ${result.invalidated} 条证据失效洞察` : '';
        new Notice(`记忆管家已建立本地索引${suffix}；首次全库分析请从记忆管家中手动确认。`);
      } else if (result.generated > 0 || result.observationMatches > 0) {
        const suffix = result.invalidated > 0 ? `，并移出 ${result.invalidated} 条证据失效洞察` : '';
        const observations = result.observationMatches > 0 ? `，待验证经验新增 ${result.observationMatches} 条证据` : '';
        new Notice(`记忆管家发现了 ${result.generated} 条待确认内容${observations}${suffix}。`, 7000);
      } else if (result.invalidated > 0) {
        new Notice(`记忆管家未发现新内容，已将 ${result.invalidated} 条证据失效内容移入历史记录。`, 7000);
      } else {
        new Notice('本次没有发现证据充分的新洞察。');
      }
    } catch (error) {
      if (notify) {
        const message = error instanceof Error ? error.message : String(error);
        new Notice(`记忆管家分析失败：${message}`, 8000);
      }
    }
  }

  async runProactiveReviewCheck(showResult = false, notify = true): Promise<ReviewScanResult | null> {
    if (!this.settings.proactiveReviewEnabled && !showResult) return null;
    try {
      const modules = new Set(this.settings.memoryButlerModules);
      const [result, lifecycle, longTermDue] = await Promise.all([
        modules.has('review') ? this.proactiveReviewService.scan() : {
          items: [], totalDetected: 0, viewportItems: 0, newCount: 0, scannedAt: new Date().toISOString(),
        },
        modules.has('action-discovery') || modules.has('progress') ? this.actionLifecycleService.getCenter() : { discoveries: [], progress: [] },
        this.actionWorkbenchService.getLongTermDue(),
      ]);
      const actionCount = (modules.has('action-discovery') ? lifecycle.discoveries.length : 0)
        + (modules.has('progress') ? lifecycle.progress.length : 0);
      const totalDetected = result.totalDetected + actionCount + longTermDue.length;
      this.updateProactiveReviewCount(totalDetected);
      if (showResult) {
        this.openProactiveReview();
      } else if (notify && totalDetected > 0 && this.settings.proactiveReviewStartupNotice) {
        new Notice(`行动工作台和记忆管家有 ${totalDetected} 项待处理，点击铃铛图标查看。`, 7000);
      }
      return { ...result, totalDetected };
    } catch (error) {
      if (showResult) {
        const message = error instanceof Error ? error.message : String(error);
        new Notice(`行动与复盘检查失败：${message}`);
      }
      return null;
    }
  }

  private async runDailyProactiveReview(): Promise<void> {
    if (!this.settings.proactiveReviewEnabled || this.settings.memoryButlerMode === 'off') return;
    if (!(await this.proactiveReviewService.shouldRunDaily())) {
      await this.runProactiveReviewCheck(false, false);
      return;
    }
    await this.runProactiveReviewCheck(false, this.settings.memoryButlerMode !== 'quiet');
  }

  private async runDailyProactiveInsights(): Promise<void> {
    if (!this.settings.proactiveInsightsEnabled || this.settings.memoryButlerMode === 'off'
      || !this.settings.memoryButlerModules.includes('insight')) return;
    try {
      if (this.settings.memoryButlerMode === 'quiet') {
        await this.refreshProactiveInsightCount();
        return;
      }
      const shouldAnalyze = await this.proactiveInsightService.shouldAutoAnalyze();
      if (shouldAnalyze && await this.proactiveInsightService.claimAutomaticAttempt()) {
        const result = await this.proactiveInsightService.analyze(false);
        await this.refreshProactiveInsightCount();
        if ((result.generated > 0 || result.observationMatches > 0) && this.settings.proactiveInsightsStartupNotice) {
          const observations = result.observationMatches > 0 ? `，并为待验证经验补充 ${result.observationMatches} 条证据` : '';
          new Notice(`记忆管家发现 ${result.generated} 条新内容${observations}，点击铃铛图标查看。`, 7000);
        }
      } else {
        await this.refreshProactiveInsightCount();
      }
    } catch (error) {
      console.warn('Automatic insight analysis failed; inspect .second-brain/analysis-jobs:', error);
    }
  }

  private updateProactiveReviewCount(count: number): void {
    this.proactiveReviewCount = Math.max(0, count);
    if (this.proactiveReviewRibbonEl) {
      this.proactiveReviewRibbonEl.dataset.reviewCount = String(this.proactiveReviewCount);
      this.proactiveReviewRibbonEl.setAttribute(
        'aria-label',
        this.proactiveReviewCount > 0 ? `行动工作台，${this.proactiveReviewCount} 项待处理` : '行动工作台',
      );
    }
    for (const view of this.getAllViews()) {
      view.updateProactiveReviewCount(this.proactiveReviewCount);
    }
  }

  private updateProactiveInsightCount(count: number): void {
    this.proactiveInsightCount = Math.max(0, count);
    if (this.proactiveInsightRibbonEl) {
      this.proactiveInsightRibbonEl.dataset.insightCount = String(this.proactiveInsightCount);
      this.proactiveInsightRibbonEl.setAttribute(
        'aria-label',
        this.proactiveInsightCount > 0
          ? `记忆管家，${this.proactiveInsightCount} 条待确认`
          : '记忆管家',
      );
    }
    for (const view of this.getAllViews()) {
      view.updateProactiveInsightCount(this.proactiveInsightCount);
    }
  }

  private async startProactiveReview(item: ReviewItem): Promise<void> {
    const tab = await this.waitForActiveTab();
    if (!tab?.controllers.inputController) {
      new Notice('知识演化面板尚未准备好，请稍后重试。');
      return;
    }
    const prompt = [
      '请对下面这项主动复盘提醒进行深入分析。',
      `类型：${item.kind}`,
      `事项：${item.title}`,
      `检测原因：${item.reason}`,
      `依据：${item.evidence}`,
      `来源：${item.sourcePath}`,
      '',
      '请先核对来源笔记，再区分事实、推断和需要我决定的部分。',
      '给出继续、调整、暂停或结束的建议，以及一个可以直接开始的下一步。',
      '现在只输出复盘建议，不修改任何笔记；需要写入时先列出修改内容并等待我确认。',
    ].join('\n');
    await tab.controllers.inputController.sendMessage({ content: prompt });
  }

  private async discussActionCandidate(record: ActionLifecycleRecord): Promise<void> {
    const tab = await this.waitForActiveTab();
    if (!tab?.controllers.inputController) {
      new Notice('知识演化面板尚未准备好，请稍后重试。');
      return;
    }
    this.settings.codexPerformanceMode = 'deep';
    try {
      this.settings.codexModel = getConfiguredModel(this.settings, 'deep');
    } catch {
      this.settings.codexModel = '';
    }
    const supportsReasoning = (this.settings.codexModelProvider ?? 'codex') === 'codex'
      || this.settings.codexProviderSupportsReasoning;
    this.settings.codexReasoningEffort = supportsReasoning
      ? CODEX_PERFORMANCE_PROFILES.deep.reasoningEffort
      : '';
    this.settings.codexPlanModeReasoningEffort = this.settings.codexReasoningEffort;
    await this.saveSettings();
    updateTabBackendUI(tab, this);
    const prompt = [
      '请与我深入讨论下面这条行动与复盘候选。',
      `类型：${record.category === 'discovery' ? '遗漏事项' : '进度同步'}`,
      `标题：${record.title}`,
      `模型判断：${record.summary}`,
      `判断理由：${record.rationale}`,
      `置信度：${Math.round(record.confidence * 100)}%`,
      `来源：${record.evidence.sourcePath}:${record.evidence.sourceLine}`,
      `原文：${record.evidence.quote}`,
      record.matchedActionId ? `匹配行动：${record.matchedActionId}` : '',
      record.matchedProjectPath ? `匹配项目：${record.matchedProjectPath}` : '',
      '',
      '请先打开并核对来源与相关行动文件，判断它是否仍然有效，是否已被后续记录解决或替代。',
      '区分事实、推断和需要我决定的部分，并给出继续、调整、延后、保留灵感或放弃的建议。',
      '现在只讨论，不修改笔记；需要写入时列出精确修改并等待我确认。',
    ].filter(Boolean).join('\n');
    await tab.controllers.inputController.sendMessage({ content: prompt });
  }

  private async discussInsight(insight: InsightRecord): Promise<void> {
    const tab = await this.waitForActiveTab();
    if (!tab?.controllers.inputController) {
      new Notice('知识演化面板尚未准备好，请稍后重试。');
      return;
    }
    this.settings.codexPerformanceMode = 'deep';
    try {
      this.settings.codexModel = getConfiguredModel(this.settings, 'deep');
    } catch {
      this.settings.codexModel = '';
    }
    const supportsReasoning = (this.settings.codexModelProvider ?? 'codex') === 'codex'
      || this.settings.codexProviderSupportsReasoning;
    this.settings.codexReasoningEffort = supportsReasoning
      ? CODEX_PERFORMANCE_PROFILES.deep.reasoningEffort
      : '';
    this.settings.codexPlanModeReasoningEffort = this.settings.codexReasoningEffort;
    await this.saveSettings();
    updateTabBackendUI(tab, this);
    const evidence = insight.evidence
      .map((item) => `- ${item.sourcePath}：${item.quote}`)
      .join('\n');
    const prompt = [
      '请与我讨论下面这条主动洞察。',
      `类型：${this.proactiveInsightService.getKindLabel(insight.kind)}`,
      `标题：${insight.title}`,
      `核心判断：${insight.summary}`,
      `触发原因：${insight.rationale}`,
      `反证与边界：${insight.counterEvidence || '尚未确认'}`,
      `建议下一步：${insight.suggestedAction || '尚未形成'}`,
      '证据：',
      evidence,
      '',
      '请先打开并核对列出的来源笔记，再区分已确认事实、合理推断、反证和仍需我决定的部分。',
      '不要把单次记录固化为人格或长期画像。现在只讨论和提出修改建议，不写入任何笔记。',
    ].join('\n');
    await tab.controllers.inputController.sendMessage({ content: prompt });
  }

  private createDecisionFromInsight(insight: InsightRecord): void {
    new DecisionCreateModal(
      this.app,
      this.proactiveReviewService,
      (decisionId) => {
        void this.proactiveInsightService.markDecisionConverted(insight.id, decisionId);
        void this.runProactiveReviewCheck(false, false);
        void this.refreshProactiveInsightCount();
      },
      {
        title: insight.title,
        background: insight.summary,
        rationale: [
          insight.rationale,
          ...insight.evidence.map((item) => `${item.sourcePath}：${item.quote}`),
        ].filter(Boolean).join('\n'),
        expectedResult: insight.suggestedAction,
      },
    ).open();
  }

  private async maybeShowKnowledgeInitializer(): Promise<void> {
    if (await this.knowledgeInitializer.getStatus() !== 'pending') return;
    if (await this.knowledgeInitializer.markCompletedIfReady()) return;
    new SecondBrainOnboardingModal(this.app, this.knowledgeInitializer, 'first-run').open();
  }

  async openTodayNote(): Promise<string | null> {
    const commands = (this.app as any).commands;
    const executed = commands?.executeCommandById?.('daily-notes');
    if (executed instanceof Promise) await executed;
    if (executed !== false) {
      for (let attempt = 0; attempt < 10 && !this.dailyNoteInfoService.findTodayFile(); attempt++) {
        await new Promise((resolve) => window.setTimeout(resolve, 25));
      }
      await this.refreshTodayInfo();
      return this.dailyNoteInfoService.findTodayFile()?.path ?? null;
    }
    new Notice('每日笔记核心功能未启用，请在 Obsidian 设置 → 核心插件中启用“每日笔记”。');
    return null;
  }

  async openTodayWorkLog(): Promise<string> {
    const result = await this.workLogService.openOrCreate();
    if (result.created) new Notice('已创建今天的工作日志。');
    return result.path;
  }

  async ensureWeChatConversationTab(conversationId: string): Promise<void> {
    for (const view of this.getAllViews()) {
      await view.getTabManager()?.ensureFixedConversationTab(conversationId, '微信会话');
    }
  }

  async syncConversationViews(conversationId: string): Promise<void> {
    for (const view of this.getAllViews()) {
      await view.getTabManager()?.refreshConversation(conversationId);
    }
  }

  async refreshTodayInfo(): Promise<void> {
    await this.dailyNoteInfoService.ensureTodayInfo();
  }

  private async focusCaptureInput(): Promise<void> {
    const tab = await this.waitForActiveTab();
    if (!tab) return;
    tab.dom.inputEl.focus();
    new Notice('输入任意混合内容，然后点击“存入收件箱”。');
  }

  async prefillKnowledgeCommand(command: string): Promise<void> {
    const tab = await this.waitForActiveTab();
    if (!tab) {
      new Notice('知识演化面板尚未准备好，请稍后重试。');
      return;
    }
    tab.dom.inputEl.value = `/${command} `;
    tab.dom.inputEl.dispatchEvent(new Event('input'));
    tab.dom.inputEl.focus();
  }

  /** Loads settings and conversations from persistent storage. */
  async loadSettings() {
    // Initialize storage service (handles migration if needed)
    this.storage = new StorageService(this);
    const { claudian } = await this.storage.initialize();

    const slashCommands = await this.storage.loadAllSlashCommands();
    const hadLegacyDailyInfoZodiac = 'dailyInfoZodiacSign' in claudian;
    let didMigrateActionWorkbenchViews = false;

    this.settings = {
      ...DEFAULT_SETTINGS,
      ...claudian,
      slashCommands,
    };
    delete (this.settings as unknown as Record<string, unknown>).dailyInfoZodiacSign;

    for (const view of ['long-term', 'inbox', 'planned']) {
      if (this.settings.actionWorkbenchViewOrder.includes(view)) continue;
      const previous = view === 'long-term' ? 'today' : view === 'inbox' ? 'long-term' : 'inbox';
      const previousIndex = this.settings.actionWorkbenchViewOrder.indexOf(previous);
      this.settings.actionWorkbenchViewOrder.splice(previousIndex >= 0 ? previousIndex + 1 : 0, 0, view);
      didMigrateActionWorkbenchViews = true;
    }

    this.settings.defaultBackend = BACKEND_CODEX;
    this.settings.locale = 'zh-CN';
    this.settings.enableAutoTitleGeneration = false;

    // Plan mode is ephemeral — normalize back to normal on load so the app
    // doesn't start stuck in plan mode after a restart (prePlanPermissionMode is lost)
    if (this.settings.permissionMode === 'plan') {
      this.settings.permissionMode = 'normal';
    }

    // Initialize and migrate legacy CLI paths to hostname-based paths
    this.settings.claudeCliPathsByHost ??= {};
    const hostname = getHostnameKey();
    let didMigrateCliPath = false;

    if (!this.settings.claudeCliPathsByHost[hostname]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const platformPaths = (this.settings as any).claudeCliPaths as Record<string, string> | undefined;
      const migratedPath = platformPaths?.[getCliPlatformKey()]?.trim() || this.settings.claudeCliPath?.trim();

      if (migratedPath) {
        this.settings.claudeCliPathsByHost[hostname] = migratedPath;
        this.settings.claudeCliPath = '';
        didMigrateCliPath = true;
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (this.settings as any).claudeCliPaths;

    // Load all conversations from session files (legacy JSONL + native metadata)
    const { conversations: legacyConversations, failedCount } = await this.storage.sessions.loadAllConversations();
    const legacyIds = new Set(legacyConversations.map(c => c.id));

    // Overlay native metadata onto legacy conversations if present
    for (const conversation of legacyConversations) {
      const meta = await this.storage.sessions.loadMetadata(conversation.id);
      if (!meta) continue;

      conversation.backendId = this.normalizeConversationBackendId(meta.backendId ?? conversation.backendId);
      conversation.isNative = true;
      conversation.title = meta.title ?? conversation.title;
      conversation.titleGenerationStatus = meta.titleGenerationStatus ?? conversation.titleGenerationStatus;
      conversation.createdAt = meta.createdAt ?? conversation.createdAt;
      conversation.updatedAt = meta.updatedAt ?? conversation.updatedAt;
      conversation.lastResponseAt = meta.lastResponseAt ?? conversation.lastResponseAt;
      if (meta.sessionId !== undefined) {
        conversation.sessionId = meta.sessionId;
      }
      conversation.currentNote = meta.currentNote ?? conversation.currentNote;
      conversation.externalContextPaths = meta.externalContextPaths ?? conversation.externalContextPaths;
      conversation.enabledMcpServers = meta.enabledMcpServers ?? conversation.enabledMcpServers;
      conversation.usage = meta.usage ?? conversation.usage;
      if (meta.sdkSessionId !== undefined) {
        conversation.sdkSessionId = meta.sdkSessionId;
      } else if (conversation.sdkSessionId === undefined && conversation.sessionId) {
        conversation.sdkSessionId = conversation.sessionId;
      }
      conversation.previousSdkSessionIds = meta.previousSdkSessionIds ?? conversation.previousSdkSessionIds;
      conversation.legacyCutoffAt = meta.legacyCutoffAt ?? conversation.legacyCutoffAt;
      conversation.subagentData = meta.subagentData ?? conversation.subagentData;
      conversation.resumeSessionAt = meta.resumeSessionAt ?? conversation.resumeSessionAt;
      conversation.forkSource = meta.forkSource ?? conversation.forkSource;
    }

    // Also load native session metadata (no legacy JSONL)
    const nativeMetadata = await this.storage.sessions.listNativeMetadata();
    const nativeConversations: Conversation[] = nativeMetadata
      .filter(meta => !legacyIds.has(meta.id))
      .map(meta => {
        const resumeSessionId = meta.sessionId !== undefined ? meta.sessionId : meta.id;
        const sdkSessionId = meta.sdkSessionId !== undefined
          ? meta.sdkSessionId
          : (resumeSessionId ?? undefined);

        return {
          backendId: this.normalizeConversationBackendId(meta.backendId),
          id: meta.id,
          title: meta.title,
          createdAt: meta.createdAt,
          updatedAt: meta.updatedAt,
          lastResponseAt: meta.lastResponseAt,
          sessionId: resumeSessionId,
          sdkSessionId,
          previousSdkSessionIds: meta.previousSdkSessionIds,
          messages: [], // Messages are in SDK storage, loaded on demand
          currentNote: meta.currentNote,
          externalContextPaths: meta.externalContextPaths,
          enabledMcpServers: meta.enabledMcpServers,
          usage: meta.usage,
          titleGenerationStatus: meta.titleGenerationStatus,
          legacyCutoffAt: meta.legacyCutoffAt,
          isNative: true,
          subagentData: meta.subagentData, // Preserve for applying to loaded messages
          resumeSessionAt: meta.resumeSessionAt,
          forkSource: meta.forkSource,
        };
      });

    this.conversations = [...legacyConversations, ...nativeConversations].sort(
      (a, b) => (b.lastResponseAt ?? b.updatedAt) - (a.lastResponseAt ?? a.updatedAt)
    );

    if (failedCount > 0) {
      new Notice(`Failed to load ${failedCount} conversation${failedCount > 1 ? 's' : ''}`);
    }
    setLocale(this.settings.locale);

    const backfilledConversations = this.backfillConversationResponseTimestamps();

    this.runtimeEnvironmentVariables = this.settings.environmentVariables || '';
    const { changed, invalidatedConversations } = this.reconcileModelWithEnvironment(this.runtimeEnvironmentVariables);

    if (changed || didMigrateCliPath || hadLegacyDailyInfoZodiac || didMigrateActionWorkbenchViews) {
      await this.saveSettings();
    }

    // Persist backfilled and invalidated conversations to their session files
    const conversationsToSave = new Set([...backfilledConversations, ...invalidatedConversations]);
    for (const conv of conversationsToSave) {
      if (conv.isNative) {
        // Native session: save metadata only
        await this.storage.sessions.saveMetadata(
          this.storage.sessions.toSessionMetadata(conv)
        );
      } else {
        // Legacy session: save full JSONL
        await this.storage.sessions.saveConversation(conv);
      }
    }
  }

  private backfillConversationResponseTimestamps(): Conversation[] {
    const updated: Conversation[] = [];
    for (const conv of this.conversations) {
      if (conv.lastResponseAt != null) continue;
      if (!conv.messages || conv.messages.length === 0) continue;

      for (let i = conv.messages.length - 1; i >= 0; i--) {
        const msg = conv.messages[i];
        if (msg.role === 'assistant') {
          conv.lastResponseAt = msg.timestamp;
          updated.push(conv);
          break;
        }
      }
    }
    return updated;
  }

  /** Persists settings to storage. */
  async saveSettings() {
    // Save settings (excluding slashCommands which are stored separately)
    const {
      slashCommands: _,
      ...settingsToSave
    } = this.settings;

    const runtimeSettings = { ...settingsToSave } as Record<string, unknown>;
    for (const legacyKey of [
      'model',
      'thinkingBudget',
      'show1MModel',
      'enableChrome',
      'claudeCliPath',
      'claudeCliPathsByHost',
      'loadUserClaudeSettings',
      'lastClaudeModel',
      'lastCustomModel',
      'titleGenerationModel',
      'dailyInfoZodiacSign',
    ]) {
      delete runtimeSettings[legacyKey];
    }
    await this.storage.saveClaudianSettings(runtimeSettings);
  }

  /** Updates and persists environment variables, restarting processes to apply changes. */
  async applyEnvironmentVariables(envText: string): Promise<void> {
    const envChanged = envText !== this.runtimeEnvironmentVariables;

    this.settings.environmentVariables = envText;

    if (!envChanged) {
      await this.saveSettings();
      return;
    }

    // Update runtime env vars so new processes use them
    this.runtimeEnvironmentVariables = envText;

    const { changed, invalidatedConversations } = this.reconcileModelWithEnvironment(envText);
    await this.saveSettings();

    if (invalidatedConversations.length > 0) {
      for (const conv of invalidatedConversations) {
        if (conv.isNative) {
          await this.storage.sessions.saveMetadata(
            this.storage.sessions.toSessionMetadata(conv)
          );
        } else {
          await this.storage.sessions.saveConversation(conv);
        }
      }
    }

    const view = this.getView();
    const tabManager = view?.getTabManager();

    if (tabManager) {
      for (const tab of tabManager.getAllTabs()) {
        if (tab.state.isStreaming) {
          tab.controllers.inputController?.cancelStreaming();
        }
      }

      let failedTabs = 0;
      if (changed) {
        for (const tab of tabManager.getAllTabs()) {
          if (!tab.service || !tab.serviceInitialized) {
            continue;
          }
          try {
            const externalContextPaths = tab.ui.externalContextSelector?.getExternalContexts() ?? [];
            tab.service.resetSession();
            await tab.service.ensureReady({ externalContextPaths });
          } catch {
            failedTabs++;
          }
        }
      } else {
        // Restart initialized tabs to pick up env changes
        try {
          await tabManager.broadcastToAllTabs(
            async (service) => { await service.ensureReady({ force: true }); }
          );
        } catch {
          failedTabs++;
        }
      }
      if (failedTabs > 0) {
        new Notice(`Environment changes applied, but ${failedTabs} tab(s) failed to restart.`);
      }
    }

    view?.refreshModelSelector();

    const noticeText = changed
      ? 'Environment variables applied. Sessions will be rebuilt on next message.'
      : 'Environment variables applied.';
    new Notice(noticeText);
  }

  /** Returns the runtime environment variables (fixed at plugin load). */
  getActiveEnvironmentVariables(): string {
    return this.runtimeEnvironmentVariables;
  }

  getResolvedClaudeCliPath(): string | null {
    return null;
  }

  getResolvedCodexCliPath(): string | null {
    return resolveConfiguredCodexCliPath(
      this.settings.codexCliPathsByHost,
      this.settings.codexCliPath,
      this.getActiveEnvironmentVariables()
    );
  }

  private getDefaultModelValues(): string[] {
    return DEFAULT_CLAUDE_MODELS.map((m) => m.value);
  }

  private getPreferredCustomModel(envVars: Record<string, string>, customModels: { value: string }[]): string {
    const envPreferred = getCurrentModelFromEnvironment(envVars);
    if (envPreferred && customModels.some((m) => m.value === envPreferred)) {
      return envPreferred;
    }
    return customModels[0].value;
  }

  /** Computes a hash of model and provider base URL environment variables for change detection. */
  private computeEnvHash(envText: string): string {
    const envVars = parseEnvironmentVariables(envText || '');
    const modelKeys = [
      'ANTHROPIC_MODEL',
      'ANTHROPIC_DEFAULT_OPUS_MODEL',
      'ANTHROPIC_DEFAULT_SONNET_MODEL',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    ];
    const providerKeys = [
      'ANTHROPIC_BASE_URL',
    ];
    const allKeys = [...modelKeys, ...providerKeys];
    const relevantPairs = allKeys
      .filter(key => envVars[key])
      .map(key => `${key}=${envVars[key]}`)
      .sort()
      .join('|');
    return relevantPairs;
  }

  /**
   * Reconciles model with environment.
   * Returns { changed, invalidatedConversations } where changed indicates if
   * settings were modified (requiring save), and invalidatedConversations lists
   * conversations that had their sessionId cleared (also requiring save).
   */
  private reconcileModelWithEnvironment(envText: string): {
    changed: boolean;
    invalidatedConversations: Conversation[];
  } {
    const currentHash = this.computeEnvHash(envText);
    const savedHash = this.settings.lastEnvHash || '';

    if (currentHash === savedHash) {
      return { changed: false, invalidatedConversations: [] };
    }

    // Hash changed - model or provider may have changed.
    // Session invalidation is now handled per-tab by TabManager.
    // Clear resume sessionId from all conversations since they belong to the old provider.
    // Sessions are provider-specific (contain signed thinking blocks, etc.).
    // NOTE: sdkSessionId is retained for loading SDK-stored history.
    const invalidatedConversations: Conversation[] = [];
    for (const conv of this.conversations) {
      if (conv.backendId !== BACKEND_CLAUDE) continue;
      if (conv.sessionId) {
        conv.sessionId = null;
        invalidatedConversations.push(conv);
      }
    }

    const envVars = parseEnvironmentVariables(envText || '');
    const customModels = getModelsFromEnvironment(envVars);

    if (customModels.length > 0) {
      this.settings.model = this.getPreferredCustomModel(envVars, customModels);
    } else {
      this.settings.model = DEFAULT_CLAUDE_MODELS[0].value;
    }

    this.settings.lastEnvHash = currentHash;
    return { changed: true, invalidatedConversations };
  }

  private normalizeConversationBackendId(backendId: unknown): BackendId {
    return normalizeBackendId(backendId, BACKEND_CODEX);
  }

  private generateConversationId(): string {
    return `conv-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }

  private generateDefaultTitle(): string {
    const now = new Date();
    return now.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  private getConversationPreview(conv: Conversation): string {
    const firstUserMsg = conv.messages.find(m => m.role === 'user');
    if (!firstUserMsg) {
      // For native sessions without loaded messages, indicate it's a persisted session
      // rather than "New conversation" which implies no content exists
      return conv.isNative ? '历史会话' : '新对话';
    }
    return firstUserMsg.content.substring(0, 50) + (firstUserMsg.content.length > 50 ? '...' : '');
  }

  /** Fork has no owned session yet; still referencing the source session for resume. */
  private isPendingFork(conversation: Conversation): boolean {
    return !!conversation.forkSource &&
      !conversation.sdkSessionId &&
      !conversation.sessionId;
  }

  private async loadSdkMessagesForConversation(conversation: Conversation): Promise<void> {
    if (!conversation.isNative || conversation.sdkMessagesLoaded) return;

    const vaultPath = getVaultPath(this.app);
    if (!vaultPath) return;

    const isPendingFork = this.isPendingFork(conversation);

    const allSessionIds: string[] = isPendingFork
      ? [conversation.forkSource!.sessionId]
      : [
          ...(conversation.previousSdkSessionIds || []),
          conversation.sdkSessionId ?? conversation.sessionId,
        ].filter((id): id is string => !!id);

    if (allSessionIds.length === 0) return;

    const allSdkMessages: ChatMessage[] = [];
    let missingSessionCount = 0;
    let errorCount = 0;
    let successCount = 0;

    const currentSessionId = isPendingFork
      ? conversation.forkSource!.sessionId
      : (conversation.sdkSessionId ?? conversation.sessionId);

    for (const sessionId of allSessionIds) {
      if (!sdkSessionExists(vaultPath, sessionId)) {
        missingSessionCount++;
        continue;
      }

      const isCurrentSession = sessionId === currentSessionId;
      const truncateAt = isCurrentSession
        ? (isPendingFork ? conversation.forkSource!.resumeAt : conversation.resumeSessionAt)
        : undefined;
      const result: SDKSessionLoadResult = await loadSDKSessionMessages(
        vaultPath, sessionId, truncateAt
      );

      if (result.error) {
        errorCount++;
        continue;
      }

      successCount++;
      allSdkMessages.push(...result.messages);
    }

    // Note: We intentionally don't notify users about missing session files.
    // Session files may be missing due to path encoding differences (special characters
    // in vault path) or external deletion. Showing a notification every restart is
    // too intrusive and not actionable for users.

    // Only mark as loaded if at least one session was successfully loaded,
    // or if all sessions were missing (no point retrying non-existent files).
    // If sessions exist but ALL failed to load, allow retry on next view.
    const allSessionsMissing = missingSessionCount === allSessionIds.length;
    const hasLoadErrors = errorCount > 0 && successCount === 0 && !allSessionsMissing;
    if (hasLoadErrors) {
      // Don't mark as loaded - allow retry on next view
      return;
    }

    // Filter out rebuilt context messages (history blobs sent on session reset)
    const filteredSdkMessages = allSdkMessages.filter(msg => !msg.isRebuiltContext);

    // Apply legacy cutoff filter if needed
    const afterCutoff = conversation.legacyCutoffAt != null
      ? filteredSdkMessages.filter(msg => msg.timestamp > conversation.legacyCutoffAt!)
      : filteredSdkMessages;

    const merged = this.dedupeMessages([
      ...conversation.messages,
      ...afterCutoff,
    ]).sort((a, b) => a.timestamp - b.timestamp);

    // Apply cached subagentData to loaded messages (for Agent tool count and status)
    if (conversation.subagentData) {
      await this.enrichAsyncSubagentToolCalls(
        conversation.subagentData,
        vaultPath,
        allSessionIds
      );
      this.applySubagentData(merged, conversation.subagentData);
    }

    conversation.messages = merged;
    conversation.sdkMessagesLoaded = true;
  }

  private async enrichAsyncSubagentToolCalls(
    subagentData: Record<string, SubagentInfo>,
    vaultPath: string,
    sessionIds: string[]
  ): Promise<void> {
    const uniqueSessionIds = [...new Set(sessionIds)];
    if (uniqueSessionIds.length === 0) return;

    const loaderCache = new Map<string, ReturnType<typeof loadSubagentToolCalls>>();

    for (const subagent of Object.values(subagentData)) {
      if (subagent.mode !== 'async') continue;
      if (!subagent.agentId) continue;
      if ((subagent.toolCalls?.length ?? 0) > 0) continue;

      for (const sessionId of uniqueSessionIds) {
        const cacheKey = `${sessionId}:${subagent.agentId}`;

        let loader = loaderCache.get(cacheKey);
        if (!loader) {
          loader = loadSubagentToolCalls(vaultPath, sessionId, subagent.agentId);
          loaderCache.set(cacheKey, loader);
        }

        const recoveredToolCalls = await loader;
        if (recoveredToolCalls.length === 0) continue;

        subagent.toolCalls = recoveredToolCalls.map(toolCall => ({
          ...toolCall,
          input: { ...toolCall.input },
        }));
        break;
      }
    }
  }

  /**
   * Applies cached subagentData to messages.
   * Restores subagent info so Agent tools can show tool count and status.
   * Also updates contentBlocks to properly identify Agent tools as subagents.
   */
  private applySubagentData(messages: ChatMessage[], subagentData: Record<string, SubagentInfo>): void {
    const attachedSubagentIds = new Set<string>();
    const chooseRicherResult = (sdkResult?: string, cachedResult?: string): string | undefined => {
      const sdkText = typeof sdkResult === 'string' ? sdkResult.trim() : '';
      const cachedText = typeof cachedResult === 'string' ? cachedResult.trim() : '';

      if (sdkText.length === 0 && cachedText.length === 0) return undefined;
      if (sdkText.length === 0) return cachedResult;
      if (cachedText.length === 0) return sdkResult;

      return sdkText.length >= cachedText.length ? sdkResult : cachedResult;
    };

    const ensureTaskToolCall = (
      msg: ChatMessage,
      subagentId: string,
      subagent: SubagentInfo
    ) => {
      msg.toolCalls = msg.toolCalls || [];
      let taskToolCall = msg.toolCalls.find(
        tc => tc.id === subagentId && isSubagentToolName(tc.name)
      );

      if (!taskToolCall) {
        taskToolCall = {
          id: subagentId,
          name: TOOL_TASK,
          input: {
            description: subagent.description,
            prompt: subagent.prompt || '',
            ...(subagent.mode === 'async' ? { run_in_background: true } : {}),
          },
          status: subagent.status,
          result: subagent.result,
          isExpanded: false,
          subagent,
        };
        msg.toolCalls.push(taskToolCall);
        return taskToolCall;
      }

      if (!taskToolCall.input.description) taskToolCall.input.description = subagent.description;
      if (!taskToolCall.input.prompt) taskToolCall.input.prompt = subagent.prompt || '';
      if (subagent.mode === 'async') taskToolCall.input.run_in_background = true;
      taskToolCall.status = subagent.status;
      const mergedResult = chooseRicherResult(taskToolCall.result, subagent.result);
      if (mergedResult !== undefined) {
        taskToolCall.result = mergedResult;
        subagent.result = mergedResult;
      }
      taskToolCall.subagent = subagent;
      return taskToolCall;
    };

    for (const msg of messages) {
      if (msg.role !== 'assistant') continue;

      // Apply subagent data to the message
      for (const [subagentId, subagent] of Object.entries(subagentData)) {
        const hasSubagentBlock = msg.contentBlocks?.some(
          b => (b.type === 'subagent' && b.subagentId === subagentId) ||
               (b.type === 'tool_use' && b.toolId === subagentId)
        );
        const hasTaskToolCall = msg.toolCalls?.some(tc => tc.id === subagentId) ?? false;

        if (!hasSubagentBlock && !hasTaskToolCall) continue;
        ensureTaskToolCall(msg, subagentId, subagent);

        // Update contentBlock from tool_use to subagent, or update existing subagent block with mode
        if (!msg.contentBlocks) {
          msg.contentBlocks = [];
        }

        let hasNormalizedSubagentBlock = false;
        for (let i = 0; i < msg.contentBlocks.length; i++) {
          const block = msg.contentBlocks[i];
          if (block.type === 'tool_use' && block.toolId === subagentId) {
            msg.contentBlocks[i] = {
              type: 'subagent',
              subagentId,
              mode: subagent.mode,
            };
            hasNormalizedSubagentBlock = true;
          } else if (block.type === 'subagent' && block.subagentId === subagentId && !block.mode) {
            block.mode = subagent.mode;
            hasNormalizedSubagentBlock = true;
          } else if (block.type === 'subagent' && block.subagentId === subagentId) {
            hasNormalizedSubagentBlock = true;
          }
        }

        if (!hasNormalizedSubagentBlock && hasTaskToolCall) {
          msg.contentBlocks.push({
            type: 'subagent',
            subagentId,
            mode: subagent.mode,
          });
        }

        attachedSubagentIds.add(subagentId);
      }
    }

    for (const [subagentId, subagent] of Object.entries(subagentData)) {
      if (attachedSubagentIds.has(subagentId)) continue;

      let anchor = [...messages].reverse().find((msg): msg is ChatMessage => msg.role === 'assistant');
      if (!anchor) {
        anchor = {
          id: `subagent-recovery-${subagentId}`,
          role: 'assistant',
          content: '',
          timestamp: subagent.completedAt ?? subagent.startedAt ?? Date.now(),
          contentBlocks: [],
        };
        messages.push(anchor);
      }

      ensureTaskToolCall(anchor, subagentId, subagent);

      anchor.contentBlocks = anchor.contentBlocks || [];
      const hasSubagentBlock = anchor.contentBlocks.some(
        block => block.type === 'subagent' && block.subagentId === subagentId
      );
      if (!hasSubagentBlock) {
        anchor.contentBlocks.push({
          type: 'subagent',
          subagentId,
          mode: subagent.mode,
        });
      }
    }
  }

  private dedupeMessages(messages: ChatMessage[]): ChatMessage[] {
    const seen = new Set<string>();
    const result: ChatMessage[] = [];

    for (const message of messages) {
      // Use message.id as primary key - more reliable than content-based deduplication
      // especially for tool-only messages or messages with identical content
      if (seen.has(message.id)) continue;
      seen.add(message.id);
      result.push(message);
    }

    return result;
  }

  /**
   * Creates a new conversation and sets it as active.
   *
   * Backends with native history support store metadata only; backends without
   * native history are persisted as JSONL from the start. Fixed integration
   * conversations can opt into JSONL so plugin-generated status messages persist.
   */
  async createConversation(
    sessionId?: string,
    backendId: BackendId = this.settings.defaultBackend,
    options: { forceLegacyStorage?: boolean } = {},
  ): Promise<Conversation> {
    const conversationId = sessionId ?? this.generateConversationId();
    const supportsNativeHistory = getBackendCapabilities(backendId).supportsNativeHistory
      && !options.forceLegacyStorage;
    const conversation: Conversation = {
      backendId,
      id: conversationId,
      title: this.generateDefaultTitle(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sessionId: sessionId ?? null,
      sdkSessionId: supportsNativeHistory ? sessionId ?? undefined : undefined,
      messages: [],
      isNative: supportsNativeHistory || undefined,
    };

    this.conversations.unshift(conversation);

    if (conversation.isNative) {
      await this.storage.sessions.saveMetadata(
        this.storage.sessions.toSessionMetadata(conversation)
      );
    } else {
      await this.storage.sessions.saveConversation(conversation);
    }

    return conversation;
  }

  /**
   * Switches to an existing conversation by ID.
   *
   * For native sessions, loads messages from SDK storage if not already loaded.
   */
  async switchConversation(id: string): Promise<Conversation | null> {
    const conversation = this.conversations.find(c => c.id === id);
    if (!conversation) return null;

    await this.loadSdkMessagesForConversation(conversation);

    return conversation;
  }

  /**
   * Deletes a conversation and resets any tabs using it.
   *
   * For native sessions, deletes the metadata file and SDK session file.
   * For legacy sessions, deletes the JSONL file.
   */
  async deleteConversation(id: string): Promise<void> {
    const index = this.conversations.findIndex(c => c.id === id);
    if (index === -1) return;

    const conversation = this.conversations[index];
    this.conversations.splice(index, 1);

    const vaultPath = getVaultPath(this.app);
    const sdkSessionId = conversation.sdkSessionId ?? conversation.sessionId;
    if (vaultPath && sdkSessionId) {
      await deleteSDKSession(vaultPath, sdkSessionId);
    }

    if (conversation.isNative) {
      // Native session: delete metadata file
      await this.storage.sessions.deleteMetadata(id);
    } else {
      // Legacy session: delete JSONL file
      await this.storage.sessions.deleteConversation(id);
    }

    // Notify all views/tabs that have this conversation open
    for (const view of this.getAllViews()) {
      const tabManager = view.getTabManager();
      if (!tabManager) continue;

      for (const tab of tabManager.getAllTabs()) {
        if (tab.conversationId === id) {
          tab.controllers.inputController?.cancelStreaming();
          await tab.controllers.conversationController?.createNew({ force: true });
        }
      }
    }
  }

  /** Renames a conversation. */
  async renameConversation(id: string, title: string): Promise<void> {
    const conversation = this.conversations.find(c => c.id === id);
    if (!conversation) return;

    conversation.title = title.trim() || this.generateDefaultTitle();
    conversation.updatedAt = Date.now();

    if (conversation.isNative) {
      // Native session: save metadata only
      await this.storage.sessions.saveMetadata(
        this.storage.sessions.toSessionMetadata(conversation)
      );
    } else {
      // Legacy session: save full JSONL
      await this.storage.sessions.saveConversation(conversation);
    }
  }

  /**
   * Updates conversation properties.
   *
   * For native sessions, saves metadata only (SDK handles messages including images).
   * For legacy sessions, saves full JSONL.
   *
   * Image data is cleared from memory after save (SDK/JSONL has persisted it),
   * except for pending fork conversations whose images aren't yet in SDK storage.
   */
  async updateConversation(id: string, updates: Partial<Conversation>): Promise<void> {
    const conversation = this.conversations.find(c => c.id === id);
    if (!conversation) return;

    Object.assign(conversation, updates, { updatedAt: Date.now() });

    if (conversation.isNative) {
      // Native session: save metadata only (SDK handles messages including images)
      await this.storage.sessions.saveMetadata(
        this.storage.sessions.toSessionMetadata(conversation)
      );
    } else {
      // Legacy session: save full JSONL
      await this.storage.sessions.saveConversation(conversation);
    }

    // Clear image data from memory after save (data is persisted by SDK or JSONL).
    // Skip for pending forks: their deep-cloned images aren't in SDK storage yet.
    if (!this.isPendingFork(conversation)) {
      for (const msg of conversation.messages) {
        if (msg.images) {
          for (const img of msg.images) {
            img.data = '';
          }
        }
      }
    }
  }

  async persistConversationMessagesInPlugin(id: string): Promise<void> {
    const conversation = await this.getConversationById(id);
    if (!conversation || !conversation.isNative) return;
    conversation.isNative = undefined;
    conversation.sdkMessagesLoaded = undefined;
    await this.storage.sessions.saveConversation(conversation);
    if (await this.storage.sessions.loadMetadata(id)) {
      await this.storage.sessions.deleteMetadata(id);
    }
  }

  /**
   * Gets a conversation by ID from the in-memory cache.
   *
   * For native sessions, loads messages from SDK storage if not already loaded.
   */
  async getConversationById(id: string): Promise<Conversation | null> {
    const conversation = this.conversations.find(c => c.id === id) || null;

    if (conversation) {
      await this.loadSdkMessagesForConversation(conversation);
    }

    return conversation;
  }

  /**
   * Gets a conversation by ID without loading SDK messages.
   * Use this for UI code that only needs metadata (title, etc.).
   */
  getConversationSync(id: string): Conversation | null {
    return this.conversations.find(c => c.id === id) || null;
  }

  /** Finds an existing empty conversation (no messages). */
  findEmptyConversation(): Conversation | null {
    return this.conversations.find(c => c.messages.length === 0) || null;
  }

  /** Returns conversation metadata list for the history dropdown. */
  getConversationList(): ConversationMeta[] {
    return this.conversations.map(c => ({
      backendId: c.backendId,
      id: c.id,
      title: c.title,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      lastResponseAt: c.lastResponseAt,
      messageCount: c.messages.length,
      preview: this.getConversationPreview(c),
      titleGenerationStatus: c.titleGenerationStatus,
      isNative: c.isNative,
    }));
  }

  /** Returns the active Claudian view from workspace, if open. */
  getView(): ClaudianView | null {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CLAUDIAN);
    if (leaves.length > 0) {
      return leaves[0].view as ClaudianView;
    }
    return null;
  }

  /** Returns all open Claudian views in the workspace. */
  getAllViews(): ClaudianView[] {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CLAUDIAN);
    return leaves.map(leaf => leaf.view as ClaudianView);
  }

  /**
   * Checks if a conversation is open in any Claudian view.
   * Returns the view and tab if found, null otherwise.
   */
  findConversationAcrossViews(conversationId: string): { view: ClaudianView; tabId: string } | null {
    for (const view of this.getAllViews()) {
      const tabManager = view.getTabManager();
      if (!tabManager) continue;

      const tabs = tabManager.getAllTabs();
      for (const tab of tabs) {
        if (tab.conversationId === conversationId) {
          return { view, tabId: tab.id };
        }
      }
    }
    return null;
  }

  /**
   * Gets SDK supported commands from any ready service.
   * The command list is the same for all services, so we just need one ready.
   * Used by inline edit and other contexts that don't have direct TabManager access.
   */
  async getSdkCommands(): Promise<SlashCommand[]> {
    for (const view of this.getAllViews()) {
      const tabManager = view.getTabManager();
      if (tabManager) {
        const commands = await tabManager.getSdkCommands();
        if (commands.length > 0) {
          return commands;
        }
      }
    }
    return [];
  }
}

/* eslint-disable simple-import-sort/imports */
import { type EventRef, ItemView, Menu, Notice, setIcon, type WorkspaceLeaf } from 'obsidian';

import { BACKEND_CODEX, VIEW_TYPE_CLAUDIAN } from '../../core/types';
import type ClaudianPlugin from '../../main';
import { CustomInstructionsModal } from '../settings/CustomInstructionsModal';
import { requestTabTitle, TabBar, TabManager, updatePlanModeUI } from './tabs';
import type { TabBarItem, TabData, TabId } from './tabs/types';

export class ClaudianView extends ItemView {
  private plugin: ClaudianPlugin;

  // Tab management
  private tabManager: TabManager | null = null;
  private tabBar: TabBar | null = null;
  private tabBarContainerEl: HTMLElement | null = null;
  private tabContentEl: HTMLElement | null = null;
  private navRowContent: HTMLElement | null = null;

  // DOM Elements
  private viewContainerEl: HTMLElement | null = null;
  private headerEl: HTMLElement | null = null;
  private titleSlotEl: HTMLElement | null = null;
  private logoEl: HTMLElement | null = null;
  private titleTextEl: HTMLElement | null = null;
  private backendBadgeEl: HTMLElement | null = null;
  private headerActionsEl: HTMLElement | null = null;
  private headerActionsContent: HTMLElement | null = null;

  // Header elements
  private historyDropdown: HTMLElement | null = null;
  private proactiveReviewBtn: HTMLElement | null = null;
  private proactiveReviewCountEl: HTMLElement | null = null;
  private proactiveInsightBtn: HTMLElement | null = null;
  private proactiveInsightCountEl: HTMLElement | null = null;
  private customInstructionsBtn: HTMLElement | null = null;

  // Event refs for cleanup
  private eventRefs: EventRef[] = [];

  // Debouncing for tab bar updates
  private pendingTabBarUpdate: number | null = null;

  // Debouncing for tab state persistence
  private pendingPersist: ReturnType<typeof setTimeout> | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: ClaudianPlugin) {
    super(leaf);
    this.plugin = plugin;

    // Hover Editor compatibility: Define load as an instance method that can't be
    // overwritten by prototype patching. Hover Editor patches ClaudianView.prototype.load
    // after our class is defined, but instance methods take precedence over prototype methods.
    const originalLoad = Object.getPrototypeOf(this).load.bind(this);
    Object.defineProperty(this, 'load', {
      value: async () => {
        // Ensure containerEl exists before any patched load code tries to use it
        if (!this.containerEl) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (this as any).containerEl = createDiv({ cls: 'view-content' });
        }
        // Wrap in try-catch to prevent Hover Editor errors from breaking our view
        try {
          return await originalLoad();
        } catch {
          // Hover Editor may throw if its DOM setup fails - continue anyway
        }
      },
      writable: false,
      configurable: false,
    });
  }

  getViewType(): string {
    return VIEW_TYPE_CLAUDIAN;
  }

  getDisplayText(): string {
    return '第二大脑';
  }

  getIcon(): string {
    return 'brain-circuit';
  }

  /** Refreshes the model selector display (used after env var changes). */
  refreshModelSelector(): void {
    const activeTab = this.tabManager?.getActiveTab();
    activeTab?.ui.modelSelector?.updateDisplay();
    activeTab?.ui.modelSelector?.renderOptions();
  }

  /** Updates hidden slash commands on all tabs (used after settings change). */
  updateHiddenSlashCommands(): void {
    const hiddenCommands = new Set(
      (this.plugin.settings.hiddenSlashCommands || []).map(c => c.toLowerCase())
    );
    for (const tab of this.tabManager?.getAllTabs() ?? []) {
      tab.ui.slashCommandDropdown?.setHiddenCommands(hiddenCommands);
    }
  }

  async onOpen() {
    // Guard: Hover Editor and similar plugins may call onOpen before DOM is ready.
    // containerEl must exist before we can access contentEl or create elements.
    if (!this.containerEl) {
      return;
    }

    // Use contentEl (standard Obsidian API) as primary target.
    // Hover Editor and other plugins may modify the DOM structure,
    // so we need fallbacks to handle non-standard scenarios.
    let container: HTMLElement | null =
      this.contentEl ?? (this.containerEl.children[1] as HTMLElement | null);

    if (!container) {
      // Last resort: create our own container inside containerEl
      container = this.containerEl.createDiv();
    }

    this.viewContainerEl = container;
    this.viewContainerEl.empty();
    this.viewContainerEl.addClass('claudian-container');

    // Build header (logo only, tab bar and actions moved to nav row)
    const header = this.viewContainerEl.createDiv({ cls: 'claudian-header' });
    this.buildHeader(header);

    // Build nav row content (tab badges + header actions)
    this.navRowContent = this.buildNavRowContent();

    // Tab content container (TabManager will populate this)
    this.tabContentEl = this.viewContainerEl.createDiv({ cls: 'claudian-tab-content-container' });

    // Initialize TabManager
    this.tabManager = new TabManager(
      this.plugin,
      this.plugin.mcpManager,
      this.tabContentEl,
      this,
      {
        onTabCreated: () => {
          this.updateTabBar();
          this.updateNavRowLocation();
          this.refreshBackendBadge();
          this.persistTabState();
        },
        onTabSwitched: () => {
          this.updateTabBar();
          this.updateHistoryDropdown();
          this.updateNavRowLocation();
          this.refreshBackendBadge();
          this.persistTabState();
        },
        onTabClosed: () => {
          this.updateTabBar();
          this.refreshBackendBadge();
          this.persistTabState();
        },
        onTabStreamingChanged: () => this.updateTabBar(),
        onTabTitleChanged: () => {
          this.updateTabBar();
          this.persistTabState();
        },
        onTabAttentionChanged: () => this.updateTabBar(),
        onTabConversationChanged: () => {
          this.refreshBackendBadge();
          this.persistTabState();
        },
      }
    );

    // Wire up view-level event handlers
    this.wireEventHandlers();

    // Restore tabs from persisted state or create default tab
    await this.restoreOrCreateTabs();
    await this.plugin.weChatService.ensureDesktopConversationTab();

    // Apply initial layout based on tabBarPosition setting
    this.updateLayoutForPosition();
    this.refreshBackendBadge();
  }

  async onClose() {
    // Cancel any pending tab bar update
    if (this.pendingTabBarUpdate !== null) {
      cancelAnimationFrame(this.pendingTabBarUpdate);
      this.pendingTabBarUpdate = null;
    }

    // Cleanup event refs
    for (const ref of this.eventRefs) {
      this.plugin.app.vault.offref(ref);
    }
    this.eventRefs = [];

    // Persist tab state before cleanup (immediate, not debounced)
    await this.persistTabStateImmediate();

    // Destroy tab manager and all tabs
    await this.tabManager?.destroy();
    this.tabManager = null;

    // Cleanup tab bar
    this.tabBar?.destroy();
    this.tabBar = null;
  }

  // ============================================
  // UI Building
  // ============================================

  private buildHeader(header: HTMLElement) {
    this.headerEl = header;

    // Title slot container (logo + title or tabs)
    this.titleSlotEl = header.createDiv({ cls: 'claudian-title-slot' });

    // Logo (hidden when 2+ tabs)
    this.logoEl = this.titleSlotEl.createSpan({ cls: 'claudian-logo' });
    this.logoEl.setAttribute('aria-label', '第二大脑');
    setIcon(this.logoEl, 'brain-circuit');

    // Title text (hidden in header mode when 2+ tabs)
    this.titleTextEl = this.titleSlotEl.createEl('h4', { text: '第二大脑', cls: 'claudian-title-text' });
    this.backendBadgeEl = this.titleSlotEl.createDiv({
      cls: 'claudian-backend-badge claudian-header-backend-badge',
      text: 'Codex',
    });

    // Header actions container (stays in the top header across layouts)
    this.headerActionsEl = header.createDiv({ cls: 'claudian-header-actions claudian-header-actions-slot' });
    this.headerActionsEl.style.display = 'flex';
  }

  /**
   * Builds the nav row content (tab badges only).
   * Header actions stay in the top header so overlays are not clipped by the input area.
   */
  private buildNavRowContent(): HTMLElement {
    // Create a fragment to hold nav row content
    const fragment = document.createDocumentFragment();

    // Tab badges (left side in nav row, or in title slot for header mode)
    this.tabBarContainerEl = document.createElement('div');
    this.tabBarContainerEl.className = 'claudian-tab-bar-container';
    this.tabBar = new TabBar(this.tabBarContainerEl, {
      onTabClick: (tabId) => this.handleTabClick(tabId),
      onTabContextMenu: (item, event) => this.handleTabContextMenu(item, event),
    });
    fragment.appendChild(this.tabBarContainerEl);

    // Header actions (right side)
    this.headerActionsContent = document.createElement('div');
    this.headerActionsContent.className = 'claudian-header-actions';

    // New conversation always opens a separate empty tab and preserves the current tab.
    const newBtn = this.headerActionsContent.createDiv({ cls: 'claudian-header-btn claudian-new-tab-btn' });
    setIcon(newBtn, 'square-pen');
    newBtn.setAttribute('aria-label', '新建对话');
    newBtn.addEventListener('click', async () => {
      await this.handleNewTab();
    });

    this.proactiveReviewBtn = this.headerActionsContent.createDiv({
      cls: 'claudian-header-btn claudian-review-btn',
    });
    setIcon(this.proactiveReviewBtn, 'list-checks');
    this.proactiveReviewBtn.setAttribute('aria-label', '行动工作台');
    this.proactiveReviewBtn.addEventListener('click', () => this.plugin.openActionWorkbench());
    this.proactiveReviewCountEl = this.proactiveReviewBtn.createSpan({ cls: 'claudian-review-count' });
    this.updateProactiveReviewCount(this.plugin.getProactiveReviewCount());

    this.proactiveInsightBtn = this.headerActionsContent.createDiv({
      cls: 'claudian-header-btn claudian-insight-btn',
    });
    setIcon(this.proactiveInsightBtn, 'bell-ring');
    this.proactiveInsightBtn.setAttribute('aria-label', '记忆管家');
    this.proactiveInsightBtn.addEventListener('click', () => this.plugin.openProactiveInsights());
    this.proactiveInsightCountEl = this.proactiveInsightBtn.createSpan({ cls: 'claudian-insight-count' });
    this.updateProactiveInsightCount(this.plugin.getProactiveInsightCount());

    this.customInstructionsBtn = this.headerActionsContent.createDiv({
      cls: 'claudian-header-btn claudian-custom-instructions-btn',
    });
    setIcon(this.customInstructionsBtn, 'scroll-text');
    this.customInstructionsBtn.addEventListener('click', () => {
      new CustomInstructionsModal(this.app, this.plugin, () => {
        this.refreshCustomInstructionsButton();
      }).open();
    });
    this.refreshCustomInstructionsButton();

    // History dropdown
    const historyContainer = this.headerActionsContent.createDiv({ cls: 'claudian-history-container' });
    const historyBtn = historyContainer.createDiv({ cls: 'claudian-header-btn' });
    setIcon(historyBtn, 'history');
    historyBtn.setAttribute('aria-label', '对话历史');

    this.historyDropdown = historyContainer.createDiv({ cls: 'claudian-history-menu' });

    historyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleHistoryDropdown();
    });

    // Create a wrapper div to hold the fragment (for input mode nav row)
    const wrapper = document.createElement('div');
    wrapper.style.display = 'contents';
    wrapper.appendChild(fragment);
    return wrapper;
  }

  /**
   * Moves tab badges based on tabBarPosition.
   * Header actions always stay in the top header to keep dropdowns unobstructed.
   */
  private updateNavRowLocation(): void {
    if (!this.tabBarContainerEl || !this.headerActionsContent) return;

    if (this.headerActionsEl) {
      this.headerActionsEl.appendChild(this.headerActionsContent);
      this.headerActionsEl.style.display = 'flex';
    }

    const isHeaderMode = this.plugin.settings.tabBarPosition === 'header';

    if (isHeaderMode) {
      if (this.titleSlotEl) {
        this.titleSlotEl.appendChild(this.tabBarContainerEl);
      }
      return;
    }

    const activeTab = this.tabManager?.getActiveTab();
    if (activeTab && this.navRowContent) {
      this.navRowContent.appendChild(this.tabBarContainerEl);
      activeTab.dom.navRowEl.appendChild(this.navRowContent);
    }
  }

  /**
   * Updates layout when tabBarPosition setting changes.
   * Called from settings when user changes the tab bar position.
   */
  updateLayoutForPosition(): void {
    if (!this.viewContainerEl) return;

    const isHeaderMode = this.plugin.settings.tabBarPosition === 'header';

    // Update container class for CSS styling
    this.viewContainerEl.toggleClass('claudian-container--header-mode', isHeaderMode);

    // Move nav content to appropriate location
    this.updateNavRowLocation();

    // Update tab bar and title visibility
    this.updateTabBarVisibility();
  }

  updateProactiveReviewCount(count: number): void {
    if (!this.proactiveReviewBtn || !this.proactiveReviewCountEl) return;
    void count;
    this.proactiveReviewCountEl.style.display = 'none';
    this.proactiveReviewBtn.setAttribute('aria-label', '行动工作台');
  }

  updateProactiveInsightCount(count: number): void {
    if (!this.proactiveInsightBtn || !this.proactiveInsightCountEl) return;
    const normalized = Math.max(0, count);
    this.proactiveInsightCountEl.setText(normalized > 99 ? '99+' : String(normalized));
    this.proactiveInsightCountEl.style.display = normalized > 0 ? '' : 'none';
    this.proactiveInsightBtn.setAttribute(
      'aria-label',
      normalized > 0 ? `记忆管家，${normalized} 条待确认` : '记忆管家',
    );
  }

  refreshCustomInstructionsButton(): void {
    if (!this.customInstructionsBtn) return;
    const enabled = Boolean(this.plugin.settings.systemPrompt?.trim());
    this.customInstructionsBtn.toggleClass('is-active', enabled);
    this.customInstructionsBtn.setAttribute(
      'aria-label',
      enabled ? '自定义指令（已启用）' : '自定义指令',
    );
  }

  // ============================================
  // Tab Management
  // ============================================

  private handleTabClick(tabId: TabId): void {
    this.tabManager?.switchToTab(tabId);
  }

  private handleTabContextMenu(item: TabBarItem, event: MouseEvent): void {
    const menu = new Menu();

    menu.addItem(menuItem => {
      menuItem
        .setTitle('重命名标签页')
        .setIcon('pencil')
        .setDisabled(item.canRename === false)
        .onClick(async () => {
          const title = await requestTabTitle(this.app, item.title);
          if (!title) return;

          try {
            await this.tabManager?.renameTab(item.id, title);
          } catch {
            new Notice('重命名标签页失败。');
          }
        });
    });

    menu.addItem(menuItem => {
      menuItem
        .setTitle('删除标签页')
        .setIcon('trash-2')
        .setWarning(true)
        .setDisabled(!item.canClose)
        .onClick(() => {
          void this.handleTabClose(item.id);
        });
    });

    menu.showAtMouseEvent(event);
  }

  private async handleTabClose(tabId: TabId): Promise<void> {
    const tab = this.tabManager?.getTab(tabId);
    // If streaming, treat close like user interrupt (force close cancels the stream)
    const force = tab?.state.isStreaming ?? false;
    await this.tabManager?.closeTab(tabId, force);
    this.updateTabBarVisibility();
  }

  private async handleNewTab(): Promise<void> {
    const tab = await this.tabManager?.createTab();
    if (!tab) {
      const maxTabs = this.plugin.settings.maxTabs ?? 10;
      new Notice(`最多只能同时打开 ${maxTabs} 个对话标签页。`);
      return;
    }
    this.updateTabBarVisibility();
  }

  private updateTabBar(): void {
    if (!this.tabManager || !this.tabBar) return;

    // Debounce tab bar updates using requestAnimationFrame
    if (this.pendingTabBarUpdate !== null) {
      cancelAnimationFrame(this.pendingTabBarUpdate);
    }

    this.pendingTabBarUpdate = requestAnimationFrame(() => {
      this.pendingTabBarUpdate = null;
      if (!this.tabManager || !this.tabBar) return;

      const items = this.tabManager.getTabBarItems();
      this.tabBar.update(items);
      this.updateTabBarVisibility();
    });
  }

  private updateTabBarVisibility(): void {
    if (!this.tabBarContainerEl || !this.tabManager) return;

    const tabCount = this.tabManager.getTabCount();
    const showTabBar = tabCount >= 2;
    const isHeaderMode = this.plugin.settings.tabBarPosition === 'header';

    // Hide tab badges when only 1 tab, show when 2+
    this.tabBarContainerEl.style.display = showTabBar ? 'flex' : 'none';

    // In header mode, badges replace logo/title in the same location
    // In input mode, keep logo/title visible (badges are in nav row)
    const hideBranding = showTabBar && isHeaderMode;
    if (this.logoEl) {
      this.logoEl.style.display = hideBranding ? 'none' : '';
    }
    if (this.titleTextEl) {
      this.titleTextEl.style.display = hideBranding ? 'none' : '';
    }
  }


  refreshBackendBadge(): void {
    if (!this.backendBadgeEl) {
      return;
    }

    this.backendBadgeEl.setText('Codex');
    this.backendBadgeEl.dataset.backendId = BACKEND_CODEX;
    this.backendBadgeEl.setAttribute('title', '当前运行引擎：Codex');
    this.backendBadgeEl.addClass('is-codex');
  }

  // ============================================
  // History Dropdown
  // ============================================

  private toggleHistoryDropdown(): void {
    if (!this.historyDropdown) return;

    const isVisible = this.historyDropdown.hasClass('visible');
    if (isVisible) {
      this.historyDropdown.removeClass('visible');
    } else {
      this.updateHistoryDropdown();
      this.historyDropdown.addClass('visible');
    }
  }

  private updateHistoryDropdown(): void {
    if (!this.historyDropdown) return;
    this.historyDropdown.empty();

    const activeTab = this.tabManager?.getActiveTab();
    const conversationController = activeTab?.controllers.conversationController;

    if (conversationController) {
      conversationController.renderHistoryDropdown(this.historyDropdown, {
        onSelectConversation: async (conversationId) => {
          // Check if conversation is already open in this view's tabs
          const existingTab = this.findTabWithConversation(conversationId);
          if (existingTab) {
            // Switch to existing tab instead of opening in current tab
            await this.tabManager?.switchToTab(existingTab.id);
            this.historyDropdown?.removeClass('visible');
            return;
          }

          // Check if conversation is open in another view (split workspace scenario)
          const crossViewResult = this.plugin.findConversationAcrossViews(conversationId);
          if (crossViewResult && crossViewResult.view !== this) {
            // Focus the other view's leaf and switch to the tab
            this.plugin.app.workspace.revealLeaf(crossViewResult.view.leaf);
            await crossViewResult.view.getTabManager()?.switchToTab(crossViewResult.tabId);
            this.historyDropdown?.removeClass('visible');
            return;
          }

          // Open in current tab
          await this.tabManager?.openConversation(conversationId);
          this.historyDropdown?.removeClass('visible');
        },
      });
    }
  }

  private findTabWithConversation(conversationId: string): TabData | null {
    const tabs = this.tabManager?.getAllTabs() ?? [];
    return tabs.find(tab => tab.conversationId === conversationId) ?? null;
  }

  // ============================================
  // Event Wiring
  // ============================================

  private wireEventHandlers(): void {
    // Document-level click to close dropdowns
    this.registerDomEvent(document, 'click', () => {
      this.historyDropdown?.removeClass('visible');
    });

    // View-level Shift+Tab to toggle plan mode (works from any focused element)
    this.registerDomEvent(this.containerEl, 'keydown', (e: KeyboardEvent) => {
      if (e.key === 'Tab' && e.shiftKey && !e.isComposing) {
        e.preventDefault();
        const activeTab = this.tabManager?.getActiveTab();
        if (!activeTab) return;
        const current = this.plugin.settings.permissionMode;
        if (current === 'plan') {
          const restoreMode = activeTab.state.prePlanPermissionMode ?? 'normal';
          activeTab.state.prePlanPermissionMode = null;
          updatePlanModeUI(activeTab, this.plugin, restoreMode);
        } else {
          activeTab.state.prePlanPermissionMode = current;
          updatePlanModeUI(activeTab, this.plugin, 'plan');
        }
      }
    });

    // View-scoped escape to cancel streaming (only when Claudian has focus)
    this.registerDomEvent(this.containerEl, 'keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.isComposing) {
        const activeTab = this.tabManager?.getActiveTab();
        if (activeTab?.state.isStreaming) {
          e.preventDefault();
          activeTab.controllers.inputController?.cancelStreaming();
        }
      }
    });

    // Vault events - forward to active tab's file context manager
    const markCacheDirty = (includesFolders: boolean): void => {
      const mgr = this.tabManager?.getActiveTab()?.ui.fileContextManager;
      if (!mgr) return;
      mgr.markFileCacheDirty();
      if (includesFolders) mgr.markFolderCacheDirty();
    };
    this.eventRefs.push(
      this.plugin.app.vault.on('create', () => markCacheDirty(true)),
      this.plugin.app.vault.on('delete', () => markCacheDirty(true)),
      this.plugin.app.vault.on('rename', () => markCacheDirty(true)),
      this.plugin.app.vault.on('modify', () => markCacheDirty(false))
    );

    // File open event
    this.registerEvent(
      this.plugin.app.workspace.on('file-open', (file) => {
        if (file) {
          this.tabManager?.getActiveTab()?.ui.fileContextManager?.handleFileOpen(file);
        }
      })
    );

    // Click outside to close mention dropdown
    this.registerDomEvent(document, 'click', (e) => {
      const activeTab = this.tabManager?.getActiveTab();
      if (activeTab) {
        const fcm = activeTab.ui.fileContextManager;
        if (fcm && !fcm.containsElement(e.target as Node) && e.target !== activeTab.dom.inputEl) {
          fcm.hideMentionDropdown();
        }
      }
    });
  }

  // ============================================
  // Persistence
  // ============================================

  private async restoreOrCreateTabs(): Promise<void> {
    if (!this.tabManager) return;

    // Try to restore from persisted state
    const persistedState = await this.plugin.storage.getTabManagerState();
    if (persistedState && persistedState.openTabs.length > 0) {
      await this.tabManager.restoreState(persistedState);
      await this.plugin.storage.clearLegacyActiveConversationId();
      return;
    }

    // No persisted state - migrate legacy activeConversationId if present
    const legacyActiveId = await this.plugin.storage.getLegacyActiveConversationId();
    if (legacyActiveId) {
      const conversation = await this.plugin.getConversationById(legacyActiveId);
      if (conversation) {
        await this.tabManager.createTab(conversation.id);
      } else {
        await this.tabManager.createTab();
      }
      await this.plugin.storage.clearLegacyActiveConversationId();
      return;
    }

    // Fallback: create a new empty tab
    await this.tabManager.createTab();
    await this.plugin.storage.clearLegacyActiveConversationId();
  }

  private persistTabState(): void {
    // Debounce persistence to avoid rapid writes (300ms delay)
    if (this.pendingPersist !== null) {
      clearTimeout(this.pendingPersist);
    }
    this.pendingPersist = setTimeout(() => {
      this.pendingPersist = null;
      if (!this.tabManager) return;
      const state = this.tabManager.getPersistedState();
      this.plugin.storage.setTabManagerState(state).catch(() => {
        // Silently ignore persistence errors
      });
    }, 300);
  }

  /** Force immediate persistence (for onClose/onunload). */
  private async persistTabStateImmediate(): Promise<void> {
    // Cancel any pending debounced persist
    if (this.pendingPersist !== null) {
      clearTimeout(this.pendingPersist);
      this.pendingPersist = null;
    }
    if (!this.tabManager) return;
    const state = this.tabManager.getPersistedState();
    await this.plugin.storage.setTabManagerState(state);
  }

  // ============================================
  // Public API
  // ============================================

  /** Gets the currently active tab. */
  getActiveTab(): TabData | null {
    return this.tabManager?.getActiveTab() ?? null;
  }

  /** Gets the tab manager. */
  getTabManager(): TabManager | null {
    return this.tabManager;
  }
}

import { Notice, setIcon } from 'obsidian';
import * as path from 'path';

import type { McpServerManager } from '../../../core/mcp';
import type {
  BackendId,
  ClaudeModel,
  ClaudianMcpServer,
  CodexPerformanceMode,
  CodexPlanModeReasoningEffort,
  CodexReasoningEffort,
  PermissionMode,
  ThinkingBudget,
  UsageInfo
} from '../../../core/types';
import {
  CODEX_PERFORMANCE_PROFILES,
  CODEX_PLAN_REASONING_EFFORTS,
  CODEX_REASONING_EFFORTS,
  DEFAULT_CLAUDE_MODELS,
  THINKING_BUDGETS
} from '../../../core/types';
import { CHECK_ICON_SVG, MCP_ICON_SVG } from '../../../shared/icons';
import { getModelsFromEnvironment, parseEnvironmentVariables } from '../../../utils/env';
import { filterValidPaths, findConflictingPath, isDuplicatePath, isValidDirectoryPath, validateDirectoryPath } from '../../../utils/externalContext';
import { expandHomePath, normalizePathForFilesystem } from '../../../utils/path';

export interface ToolbarModelOption {
  value: string;
  label: string;
  description: string;
}

interface BaseToolbarSettings {
  backendId: BackendId;
  model: ClaudeModel;
  modelOptions?: ToolbarModelOption[];
  permissionMode: PermissionMode;
}

export interface ClaudeToolbarSettings extends BaseToolbarSettings {
  backendId: 'claude';
  thinkingBudget: ThinkingBudget;
  show1MModel?: boolean;
}

export interface CodexToolbarSettings extends BaseToolbarSettings {
  backendId: 'codex';
  codexPerformanceMode?: CodexPerformanceMode;
  codexReasoningEffort: CodexReasoningEffort;
  codexPlanModeReasoningEffort: CodexPlanModeReasoningEffort;
  prePlanPermissionMode?: Exclude<PermissionMode, 'plan'> | null;
}

export type ToolbarSettings = ClaudeToolbarSettings | CodexToolbarSettings;
export type ToolbarReasoningValue = ThinkingBudget | CodexReasoningEffort | CodexPlanModeReasoningEffort;

export interface ToolbarCallbacks {
  onModelChange: (model: ClaudeModel) => Promise<void>;
  onReasoningChange: (value: ToolbarReasoningValue) => Promise<void>;
  onCodexPerformanceModeChange?: (mode: CodexPerformanceMode) => Promise<void>;
  onPermissionModeChange: (mode: PermissionMode) => Promise<void>;
  onAttachActiveFile?: () => Promise<void> | void;
  onCaptureInput?: () => Promise<void> | void;
  getSettings: () => ToolbarSettings;
  getEnvironmentVariables?: () => string;
}

function isClaudeToolbarSettings(settings: ToolbarSettings): settings is ClaudeToolbarSettings {
  return settings.backendId === 'claude';
}

function isCodexToolbarSettings(settings: ToolbarSettings): settings is CodexToolbarSettings {
  return settings.backendId === 'codex';
}

interface ToolbarModelSelectorLike {
  setReady(ready: boolean): void;
  setVisible(visible: boolean): void;
  updateDisplay(): void;
  renderOptions(): void;
}

interface ToolbarReasoningSelectorLike {
  setVisible(visible: boolean): void;
  updateDisplay(): void;
}

interface ToolbarPermissionToggleLike {
  updateDisplay(): void;
}

abstract class BaseModelSelectorView implements ToolbarModelSelectorLike {
  protected container: HTMLElement;
  protected buttonEl: HTMLElement | null = null;
  protected dropdownEl: HTMLElement | null = null;
  protected callbacks: ToolbarCallbacks;
  protected isReady = false;

  constructor(parentEl: HTMLElement, callbacks: ToolbarCallbacks, modifierClass: string) {
    this.callbacks = callbacks;
    this.container = parentEl.createDiv({ cls: 'claudian-model-selector' });
    this.container.addClass(modifierClass);
    this.render();
  }

  protected abstract getAvailableModels(): ToolbarModelOption[];

  private render() {
    this.container.empty();

    this.buttonEl = this.container.createDiv({ cls: 'claudian-model-btn' });
    this.setReady(this.isReady);
    this.updateDisplay();

    this.dropdownEl = this.container.createDiv({ cls: 'claudian-model-dropdown' });
    this.renderOptions();
  }

  updateDisplay() {
    if (!this.buttonEl) return;
    const currentModel = this.callbacks.getSettings().model;
    const models = this.getAvailableModels();
    const modelInfo = models.find(m => m.value === currentModel);
    const displayModel = modelInfo || models[0];

    this.buttonEl.empty();
    const labelEl = this.buttonEl.createSpan({ cls: 'claudian-model-label' });
    labelEl.setText(displayModel?.label || 'Unknown');
  }

  setReady(ready: boolean) {
    this.isReady = ready;
    this.buttonEl?.toggleClass('ready', ready);
  }

  setVisible(visible: boolean): void {
    this.container.style.display = visible ? '' : 'none';
  }

  renderOptions() {
    if (!this.dropdownEl) return;
    this.dropdownEl.empty();

    const currentModel = this.callbacks.getSettings().model;
    const models = this.getAvailableModels();

    for (const model of [...models].reverse()) {
      const option = this.dropdownEl.createDiv({ cls: 'claudian-model-option' });
      if (model.value === currentModel) {
        option.addClass('selected');
      }

      option.createSpan({ text: model.label });
      if (model.description) {
        option.setAttribute('title', model.description);
      }

      option.addEventListener('click', async (e) => {
        e.stopPropagation();
        await this.callbacks.onModelChange(model.value);
        this.updateDisplay();
        this.renderOptions();
      });
    }
  }
}

export class ClaudeModelSelector extends BaseModelSelectorView {
  constructor(parentEl: HTMLElement, callbacks: ToolbarCallbacks) {
    super(parentEl, callbacks, 'claudian-model-selector--claude');
  }

  protected getAvailableModels(): ToolbarModelOption[] {
    const settings = this.callbacks.getSettings();
    let models: ToolbarModelOption[] = [];

    if (this.callbacks.getEnvironmentVariables) {
      const envVarsStr = this.callbacks.getEnvironmentVariables();
      const envVars = parseEnvironmentVariables(envVarsStr);
      const customModels = getModelsFromEnvironment(envVars);

      if (customModels.length > 0) {
        models = customModels;
      } else {
        models = [...DEFAULT_CLAUDE_MODELS];
      }
    } else {
      models = [...DEFAULT_CLAUDE_MODELS];
    }

    if (isClaudeToolbarSettings(settings) && settings.show1MModel) {
      models = models.map(m =>
        m.value === 'sonnet' ? { ...m, label: 'Sonnet (1M)' } : m
      );
    }

    return models;
  }
}

export class CodexModelSelector implements ToolbarModelSelectorLike {
  private readonly container: HTMLElement;
  private readonly callbacks: ToolbarCallbacks;

  constructor(parentEl: HTMLElement, callbacks: ToolbarCallbacks) {
    this.callbacks = callbacks;
    this.container = parentEl.createDiv({
      cls: 'claudian-model-selector claudian-model-selector--codex claudian-performance-selector',
    });
    this.render();
  }

  private getMode(): CodexPerformanceMode {
    const settings = this.callbacks.getSettings();
    if (!isCodexToolbarSettings(settings)) {
      return 'fast';
    }
    return settings.codexPerformanceMode ?? 'fast';
  }

  private render(): void {
    this.container.empty();
    const currentMode = this.getMode();

    for (const mode of ['fast', 'deep'] as const) {
      const profile = CODEX_PERFORMANCE_PROFILES[mode];
      const buttonEl = this.container.createEl('button', {
        cls: 'claudian-performance-option',
        text: profile.label,
      }) as HTMLButtonElement;
      buttonEl.setAttribute('type', 'button');
      buttonEl.setAttribute('title', `${profile.description} ${profile.model} / ${profile.reasoningEffort}`);
      buttonEl.setAttribute('aria-pressed', mode === currentMode ? 'true' : 'false');
      buttonEl.toggleClass('is-active', mode === currentMode);
      buttonEl.addEventListener('click', async (event) => {
        event.stopPropagation();
        if (mode === this.getMode()) {
          return;
        }
        await this.callbacks.onCodexPerformanceModeChange?.(mode);
        this.updateDisplay();
      });
    }
  }

  setReady(ready: boolean): void {
    this.container.toggleClass('ready', ready);
  }

  setVisible(visible: boolean): void {
    this.container.style.display = visible ? '' : 'none';
  }

  updateDisplay(): void {
    this.render();
  }

  renderOptions(): void {
    this.render();
  }
}

export class ModelSelector implements ToolbarModelSelectorLike {
  private visible = true;
  private readonly codexSelector: CodexModelSelector;

  constructor(parentEl: HTMLElement, callbacks: ToolbarCallbacks) {
    this.codexSelector = new CodexModelSelector(parentEl, callbacks);
  }

  private syncVisibility(): void {
    this.codexSelector.setVisible(this.visible);
  }

  setReady(ready: boolean): void {
    this.codexSelector.setReady(ready);
    this.syncVisibility();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.syncVisibility();
  }

  updateDisplay(): void {
    this.codexSelector.updateDisplay();
    this.syncVisibility();
  }

  renderOptions(): void {
    this.codexSelector.renderOptions();
    this.syncVisibility();
  }
}

export class ClaudeThinkingBudgetSelector implements ToolbarReasoningSelectorLike {
  private container: HTMLElement;
  private gearsEl: HTMLElement | null = null;
  private callbacks: ToolbarCallbacks;

  constructor(parentEl: HTMLElement, callbacks: ToolbarCallbacks) {
    this.callbacks = callbacks;
    this.container = parentEl.createDiv({ cls: 'claudian-thinking-selector' });
    this.container.addClass('claudian-thinking-selector--claude');
    this.render();
  }

  private render() {
    this.container.empty();

    const labelEl = this.container.createSpan({ cls: 'claudian-thinking-label-text' });
    labelEl.setText('Thinking:');

    this.gearsEl = this.container.createDiv({ cls: 'claudian-thinking-gears' });
    this.renderGears();
  }

  private renderGears() {
    if (!this.gearsEl) return;
    this.gearsEl.empty();

    const settings = this.callbacks.getSettings();
    const currentBudget = isClaudeToolbarSettings(settings)
      ? settings.thinkingBudget
      : 'off';
    const currentBudgetInfo = THINKING_BUDGETS.find(b => b.value === currentBudget);

    const currentEl = this.gearsEl.createDiv({ cls: 'claudian-thinking-current' });
    currentEl.setText(currentBudgetInfo?.label || 'Off');

    const optionsEl = this.gearsEl.createDiv({ cls: 'claudian-thinking-options' });

    for (const budget of [...THINKING_BUDGETS].reverse()) {
      const gearEl = optionsEl.createDiv({ cls: 'claudian-thinking-gear' });
      gearEl.setText(budget.label);
      gearEl.setAttribute('title', budget.tokens > 0 ? `${budget.tokens.toLocaleString()} tokens` : 'Disabled');

      if (budget.value === currentBudget) {
        gearEl.addClass('selected');
      }

      gearEl.addEventListener('click', async (e) => {
        e.stopPropagation();
        await this.callbacks.onReasoningChange(budget.value);
        this.updateDisplay();
      });
    }
  }

  updateDisplay() {
    this.renderGears();
  }

  setVisible(visible: boolean): void {
    this.container.style.display = visible ? '' : 'none';
  }
}

export class CodexReasoningEffortSelector implements ToolbarReasoningSelectorLike {
  private container: HTMLElement;
  private currentEl: HTMLElement | null = null;
  private optionsEl: HTMLElement | null = null;
  private labelEl: HTMLElement | null = null;
  private callbacks: ToolbarCallbacks;

  constructor(parentEl: HTMLElement, callbacks: ToolbarCallbacks) {
    this.callbacks = callbacks;
    this.container = parentEl.createDiv({ cls: 'claudian-thinking-selector' });
    this.container.addClass('claudian-thinking-selector--codex');
    this.render();
  }

  private getOptions() {
    const settings = this.callbacks.getSettings();
    return settings.permissionMode === 'plan'
      ? CODEX_PLAN_REASONING_EFFORTS
      : CODEX_REASONING_EFFORTS;
  }

  private getCurrentEffort(): CodexReasoningEffort | CodexPlanModeReasoningEffort {
    const settings = this.callbacks.getSettings();
    if (!isCodexToolbarSettings(settings)) {
      return '';
    }

    return settings.permissionMode === 'plan'
      ? settings.codexPlanModeReasoningEffort
      : settings.codexReasoningEffort;
  }

  private render() {
    this.container.empty();

    this.labelEl = this.container.createSpan({ cls: 'claudian-thinking-label-text' });
    this.labelEl.setText(this.callbacks.getSettings().permissionMode === 'plan' ? 'Plan:' : 'Reasoning:');

    const selectorEl = this.container.createDiv({ cls: 'claudian-thinking-gears' });
    this.currentEl = selectorEl.createDiv({ cls: 'claudian-thinking-current' });
    this.optionsEl = selectorEl.createDiv({ cls: 'claudian-thinking-options' });
    this.renderOptions();
  }

  private renderOptions() {
    if (!this.currentEl || !this.optionsEl) return;

    const currentEffort = this.getCurrentEffort();
    const options = this.getOptions();
    const currentOption = options.find(option => option.value === currentEffort) ?? options[0];

    if (this.labelEl) {
      this.labelEl.setText(this.callbacks.getSettings().permissionMode === 'plan' ? 'Plan:' : 'Reasoning:');
    }

    this.currentEl.empty();
    this.currentEl.setText(currentOption?.label || 'Default');

    this.optionsEl.empty();
    for (const option of [...options].reverse()) {
      const optionEl = this.optionsEl.createDiv({ cls: 'claudian-thinking-gear' });
      optionEl.setText(option.label);
      optionEl.setAttribute('title', option.description);
      if (option.value === currentEffort) {
        optionEl.addClass('selected');
      }

      optionEl.addEventListener('click', async (e) => {
        e.stopPropagation();
        await this.callbacks.onReasoningChange(option.value);
        this.updateDisplay();
      });
    }
  }

  updateDisplay() {
    this.renderOptions();
  }

  setVisible(visible: boolean): void {
    this.container.style.display = visible ? '' : 'none';
  }
}

export class ThinkingBudgetSelector implements ToolbarReasoningSelectorLike {
  private visible = true;
  private readonly codexSelector: CodexReasoningEffortSelector;

  constructor(parentEl: HTMLElement, callbacks: ToolbarCallbacks) {
    this.codexSelector = new CodexReasoningEffortSelector(parentEl, callbacks);
    this.syncVisibility();
  }

  private syncVisibility(): void {
    this.codexSelector.setVisible(false);
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.syncVisibility();
  }

  updateDisplay() {
    this.codexSelector.updateDisplay();
    this.syncVisibility();
  }
}

export class ClaudePermissionToggle implements ToolbarPermissionToggleLike {
  private container: HTMLElement;
  private toggleEl: HTMLElement | null = null;
  private labelEl: HTMLElement | null = null;
  private callbacks: ToolbarCallbacks;

  constructor(parentEl: HTMLElement, callbacks: ToolbarCallbacks) {
    this.callbacks = callbacks;
    this.container = parentEl.createDiv({ cls: 'claudian-permission-toggle' });
    this.container.addClass('claudian-permission-toggle--claude');
    this.render();
  }

  private render() {
    this.container.empty();

    this.labelEl = this.container.createSpan({ cls: 'claudian-permission-label' });
    this.toggleEl = this.container.createDiv({ cls: 'claudian-toggle-switch' });

    this.updateDisplay();
    this.toggleEl.addEventListener('click', () => this.toggle());
  }

  updateDisplay() {
    if (!this.toggleEl || !this.labelEl) return;

    const mode = this.callbacks.getSettings().permissionMode;
    if (mode === 'plan') {
      this.toggleEl.style.display = 'none';
      this.labelEl.setText('PLAN');
      this.labelEl.addClass('plan-active');
    } else {
      this.toggleEl.style.display = '';
      this.labelEl.removeClass('plan-active');
      if (mode === 'yolo') {
        this.toggleEl.addClass('active');
        this.labelEl.setText('YOLO');
      } else {
        this.toggleEl.removeClass('active');
        this.labelEl.setText('Safe');
      }
    }
  }

  private async toggle() {
    const current = this.callbacks.getSettings().permissionMode;
    const newMode: PermissionMode = current === 'yolo' ? 'normal' : 'yolo';
    await this.callbacks.onPermissionModeChange(newMode);
    this.updateDisplay();
  }

  setVisible(visible: boolean): void {
    this.container.style.display = visible ? '' : 'none';
  }
}

export class CodexPermissionToggle implements ToolbarPermissionToggleLike {
  private container: HTMLElement;
  private callbacks: ToolbarCallbacks;
  private modeGroupEl: HTMLElement | null = null;
  private modeLabelEl: HTMLElement | null = null;
  private modeToggleEl: HTMLButtonElement | null = null;
  private accessGroupEl: HTMLElement | null = null;
  private accessLabelEl: HTMLElement | null = null;
  private accessToggleEl: HTMLButtonElement | null = null;

  constructor(parentEl: HTMLElement, callbacks: ToolbarCallbacks) {
    this.callbacks = callbacks;
    this.container = parentEl.createDiv({ cls: 'claudian-permission-toggle' });
    this.container.addClass('claudian-permission-toggle--codex');
    this.render();
  }

  private render() {
    this.container.empty();

    const modeGroup = this.createSwitchGroup('claudian-permission-switch-group--mode', '切换规划模式');
    this.modeGroupEl = modeGroup.groupEl;
    this.modeLabelEl = modeGroup.labelEl;
    this.modeToggleEl = modeGroup.toggleEl;
    this.modeToggleEl.addEventListener('click', async (e) => {
      e.stopPropagation();
      await this.toggleMode();
    });

    const accessGroup = this.createSwitchGroup('claudian-permission-switch-group--access', '切换写入权限');
    this.accessGroupEl = accessGroup.groupEl;
    this.accessLabelEl = accessGroup.labelEl;
    this.accessToggleEl = accessGroup.toggleEl;
    this.accessToggleEl.addEventListener('click', async (e) => {
      e.stopPropagation();
      await this.toggleAccess();
    });

    this.updateDisplay();
  }

  private createSwitchGroup(modifierClass: string, ariaLabel: string): {
    groupEl: HTMLElement;
    labelEl: HTMLElement;
    toggleEl: HTMLButtonElement;
  } {
    const groupEl = this.container.createDiv({ cls: 'claudian-permission-switch-group' });
    groupEl.addClass(modifierClass);

    const labelEl = groupEl.createSpan({ cls: 'claudian-permission-label' });
    const toggleEl = groupEl.createEl('button', { cls: 'claudian-toggle-switch' }) as HTMLButtonElement;
    toggleEl.setAttribute('type', 'button');
    toggleEl.setAttribute('role', 'switch');
    toggleEl.setAttribute('aria-label', ariaLabel);

    return { groupEl, labelEl, toggleEl };
  }

  private syncSwitch(toggleEl: HTMLButtonElement | null, active: boolean, disabled: boolean): void {
    if (!toggleEl) {
      return;
    }

    toggleEl.toggleClass('active', active);
    toggleEl.toggleClass('is-disabled', disabled);
    toggleEl.disabled = disabled;
    toggleEl.setAttribute('aria-checked', active ? 'true' : 'false');
    toggleEl.setAttribute('aria-disabled', disabled ? 'true' : 'false');
  }

  private async toggleMode(): Promise<void> {
    const settings = this.callbacks.getSettings();
    if (!isCodexToolbarSettings(settings)) {
      return;
    }

    const nextMode: PermissionMode = settings.permissionMode === 'plan'
      ? (settings.prePlanPermissionMode ?? 'normal')
      : 'plan';

    if (settings.permissionMode === nextMode) {
      this.updateDisplay();
      return;
    }

    await this.callbacks.onPermissionModeChange(nextMode);
    this.updateDisplay();
  }

  private async toggleAccess(): Promise<void> {
    const settings = this.callbacks.getSettings();
    if (!isCodexToolbarSettings(settings) || settings.permissionMode === 'plan') {
      this.updateDisplay();
      return;
    }

    const nextMode: PermissionMode = settings.permissionMode === 'yolo' ? 'normal' : 'yolo';
    await this.callbacks.onPermissionModeChange(nextMode);
    this.updateDisplay();
  }

  updateDisplay() {
    const settings = this.callbacks.getSettings();
    if (
      !this.modeGroupEl ||
      !this.modeLabelEl ||
      !this.modeToggleEl ||
      !this.accessGroupEl ||
      !this.accessLabelEl ||
      !this.accessToggleEl ||
      !isCodexToolbarSettings(settings)
    ) {
      return;
    }

    const isPlanMode = settings.permissionMode === 'plan';
    const accessMode = isPlanMode
      ? (settings.prePlanPermissionMode ?? 'normal')
      : settings.permissionMode;

    this.modeLabelEl.setText(isPlanMode ? '规划' : '执行');
    this.modeLabelEl.toggleClass('plan-active', isPlanMode);
    this.syncSwitch(this.modeToggleEl, isPlanMode, false);

    this.accessLabelEl.setText(accessMode === 'yolo' ? '放行' : '安全');
    this.accessLabelEl.removeClass('plan-active');
    this.accessGroupEl.toggleClass('is-disabled', isPlanMode);
    this.syncSwitch(this.accessToggleEl, accessMode === 'yolo', isPlanMode);
  }

  setVisible(visible: boolean): void {
    this.container.style.display = visible ? '' : 'none';
  }
}

export class PermissionToggle implements ToolbarPermissionToggleLike {
  private readonly codexToggle: CodexPermissionToggle;

  constructor(parentEl: HTMLElement, callbacks: ToolbarCallbacks) {
    this.codexToggle = new CodexPermissionToggle(parentEl, callbacks);
  }

  updateDisplay() {
    this.codexToggle.updateDisplay();
  }
}

class ActiveNoteAttachButton {
  private readonly container: HTMLElement;
  private readonly buttonEl: HTMLButtonElement;
  private readonly callbacks: ToolbarCallbacks;

  constructor(parentEl: HTMLElement, callbacks: ToolbarCallbacks) {
    this.callbacks = callbacks;
    this.container = parentEl.createDiv({ cls: 'claudian-active-note-button' });
    this.buttonEl = this.container.createEl('button', { cls: 'claudian-active-note-button-icon' }) as HTMLButtonElement;
    this.buttonEl.setAttribute('type', 'button');
    this.buttonEl.setAttribute('aria-label', '将当前笔记加入对话上下文');
    this.buttonEl.setAttribute('title', '将当前笔记加入对话上下文');
    setIcon(this.buttonEl, 'file-plus');

    this.buttonEl.addEventListener('mousedown', (e) => {
      e.preventDefault();
    });

    this.buttonEl.addEventListener('click', async (e) => {
      e.stopPropagation();
      await this.callbacks.onAttachActiveFile?.();
    });
  }
}

class InboxCaptureButton {
  constructor(parentEl: HTMLElement, callbacks: ToolbarCallbacks) {
    const button = parentEl.createEl('button', {
      cls: 'second-brain-capture-button',
      attr: { type: 'button', title: '不调用模型，原样保存到收件箱' },
    }) as HTMLButtonElement;
    const icon = button.createSpan({ cls: 'second-brain-capture-button-icon' });
    setIcon(icon, 'inbox');
    button.createSpan({ text: '存入收件箱' });
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      await callbacks.onCaptureInput?.();
    });
  }
}

export type AddExternalContextResult =
  | { success: true; normalizedPath: string }
  | { success: false; error: string };

export class ExternalContextSelector {
  private container: HTMLElement;
  private iconEl: HTMLElement | null = null;
  private badgeEl: HTMLElement | null = null;
  private dropdownEl: HTMLElement | null = null;
  private callbacks: ToolbarCallbacks;
  /**
   * Current external context paths. May contain:
   * - Persistent paths only (new sessions via clearExternalContexts)
   * - Restored session paths (loaded sessions via setExternalContexts)
   * - Mixed paths during active sessions
   */
  private externalContextPaths: string[] = [];
  /** Paths that persist across all sessions (stored in settings). */
  private persistentPaths: Set<string> = new Set();
  private onChangeCallback: ((paths: string[]) => void) | null = null;
  private onPersistenceChangeCallback: ((paths: string[]) => void) | null = null;

  constructor(parentEl: HTMLElement, callbacks: ToolbarCallbacks) {
    this.callbacks = callbacks;
    this.container = parentEl.createDiv({ cls: 'claudian-external-context-selector' });
    this.render();
  }

  setOnChange(callback: (paths: string[]) => void): void {
    this.onChangeCallback = callback;
  }

  setOnPersistenceChange(callback: (paths: string[]) => void): void {
    this.onPersistenceChangeCallback = callback;
  }

  getExternalContexts(): string[] {
    return [...this.externalContextPaths];
  }

  getPersistentPaths(): string[] {
    return [...this.persistentPaths];
  }

  setPersistentPaths(paths: string[]): void {
    // Validate paths - remove non-existent directories
    const validPaths = filterValidPaths(paths);
    const invalidPaths = paths.filter(p => !validPaths.includes(p));

    this.persistentPaths = new Set(validPaths);
    // Merge persistent paths into external context paths
    this.mergePersistentPaths();
    this.updateDisplay();
    this.renderDropdown();

    // If invalid paths were removed, notify user and save updated list
    if (invalidPaths.length > 0) {
      const pathNames = invalidPaths.map(p => this.shortenPath(p)).join(', ');
      new Notice(`Removed ${invalidPaths.length} invalid external context path(s): ${pathNames}`, 5000);
      this.onPersistenceChangeCallback?.([...this.persistentPaths]);
    }
  }

  togglePersistence(path: string): void {
    if (this.persistentPaths.has(path)) {
      this.persistentPaths.delete(path);
    } else {
      // Validate path still exists before persisting
      if (!isValidDirectoryPath(path)) {
        new Notice(`Cannot persist "${this.shortenPath(path)}" - directory no longer exists`, 4000);
        return;
      }
      this.persistentPaths.add(path);
    }
    this.onPersistenceChangeCallback?.([...this.persistentPaths]);
    this.renderDropdown();
  }

  private mergePersistentPaths(): void {
    const pathSet = new Set(this.externalContextPaths);
    for (const path of this.persistentPaths) {
      pathSet.add(path);
    }
    this.externalContextPaths = [...pathSet];
  }

  /**
   * Restore exact external context paths from a saved conversation.
   * Does NOT merge with persistent paths - preserves the session's historical state.
   * Use clearExternalContexts() for new sessions to start with current persistent paths.
   */
  setExternalContexts(paths: string[]): void {
    this.externalContextPaths = [...paths];
    this.updateDisplay();
    this.renderDropdown();
  }

  /**
   * Remove a path from external contexts (and persistent paths if applicable).
   * Exposed for testing the remove button behavior.
   */
  removePath(pathStr: string): void {
    this.externalContextPaths = this.externalContextPaths.filter(p => p !== pathStr);
    // Also remove from persistent paths if it was persistent
    if (this.persistentPaths.has(pathStr)) {
      this.persistentPaths.delete(pathStr);
      this.onPersistenceChangeCallback?.([...this.persistentPaths]);
    }
    this.onChangeCallback?.(this.externalContextPaths);
    this.updateDisplay();
    this.renderDropdown();
  }

  /**
   * Add an external context path programmatically (e.g., from /add-dir command).
   * Validates the path and handles duplicates/conflicts.
   * @param pathInput - Path string (supports ~/ expansion)
   * @returns Result with success status and normalized path, or error message on failure
   */
  addExternalContext(pathInput: string): AddExternalContextResult {
    const trimmed = pathInput?.trim();
    if (!trimmed) {
      return { success: false, error: 'No path provided. Usage: /add-dir /absolute/path' };
    }

    // Strip surrounding quotes if present (e.g., "/path/with spaces")
    let cleanPath = trimmed;
    if ((cleanPath.startsWith('"') && cleanPath.endsWith('"')) ||
        (cleanPath.startsWith("'") && cleanPath.endsWith("'"))) {
      cleanPath = cleanPath.slice(1, -1);
    }

    // Expand home directory and normalize path
    const expandedPath = expandHomePath(cleanPath);
    const normalizedPath = normalizePathForFilesystem(expandedPath);

    if (!path.isAbsolute(normalizedPath)) {
      return { success: false, error: 'Path must be absolute. Usage: /add-dir /absolute/path' };
    }

    // Validate path exists and is a directory with specific error messages
    const validation = validateDirectoryPath(normalizedPath);
    if (!validation.valid) {
      return { success: false, error: `${validation.error}: ${pathInput}` };
    }

    // Check for duplicate (normalized comparison for cross-platform support)
    if (isDuplicatePath(normalizedPath, this.externalContextPaths)) {
      return { success: false, error: 'This folder is already added as an external context.' };
    }

    // Check for nested/overlapping paths
    const conflict = findConflictingPath(normalizedPath, this.externalContextPaths);
    if (conflict) {
      return { success: false, error: this.formatConflictMessage(normalizedPath, conflict) };
    }

    // Add the path
    this.externalContextPaths = [...this.externalContextPaths, normalizedPath];
    this.onChangeCallback?.(this.externalContextPaths);
    this.updateDisplay();
    this.renderDropdown();

    return { success: true, normalizedPath };
  }

  /**
   * Clear session-only external context paths (call on new conversation).
   * Uses persistent paths from settings if provided, otherwise falls back to local cache.
   * Validates paths before using them (silently filters invalid during session init).
   */
  clearExternalContexts(persistentPathsFromSettings?: string[]): void {
    // Use settings value if provided (most up-to-date), otherwise use local cache
    if (persistentPathsFromSettings) {
      // Validate paths - silently filter during session initialization (not user action)
      const validPaths = filterValidPaths(persistentPathsFromSettings);
      this.persistentPaths = new Set(validPaths);
    }
    this.externalContextPaths = [...this.persistentPaths];
    this.updateDisplay();
    this.renderDropdown();
  }

  private render() {
    this.container.empty();

    const iconWrapper = this.container.createDiv({ cls: 'claudian-external-context-icon-wrapper' });

    this.iconEl = iconWrapper.createDiv({ cls: 'claudian-external-context-icon' });
    setIcon(this.iconEl, 'folder');

    this.badgeEl = iconWrapper.createDiv({ cls: 'claudian-external-context-badge' });

    this.updateDisplay();

    // Click to open native folder picker
    iconWrapper.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openFolderPicker();
    });

    this.dropdownEl = this.container.createDiv({ cls: 'claudian-external-context-dropdown' });
    this.renderDropdown();
  }

  private async openFolderPicker() {
    try {
      // Access Electron's dialog through remote
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { remote } = require('electron');
      const result = await remote.dialog.showOpenDialog({
        properties: ['openDirectory'],
        title: 'Select External Context',
      });

      if (!result.canceled && result.filePaths.length > 0) {
        const selectedPath = result.filePaths[0];

        // Check for duplicate (normalized comparison for cross-platform support)
        if (isDuplicatePath(selectedPath, this.externalContextPaths)) {
          new Notice('这个文件夹已经加入外部资料。', 3000);
          return;
        }

        // Check for nested/overlapping paths
        const conflict = findConflictingPath(selectedPath, this.externalContextPaths);
        if (conflict) {
          new Notice(this.formatConflictMessage(selectedPath, conflict), 5000);
          return;
        }

        this.externalContextPaths = [...this.externalContextPaths, selectedPath];
        this.onChangeCallback?.(this.externalContextPaths);
        this.updateDisplay();
        this.renderDropdown();
      }
    } catch {
      new Notice('无法打开文件夹选择器。', 5000);
    }
  }

  /** Formats a conflict error message for display. */
  private formatConflictMessage(newPath: string, conflict: { path: string; type: 'parent' | 'child' }): string {
    const shortNew = this.shortenPath(newPath);
    const shortExisting = this.shortenPath(conflict.path);
    return conflict.type === 'parent'
      ? `Cannot add "${shortNew}" - it's inside existing path "${shortExisting}"`
      : `Cannot add "${shortNew}" - it contains existing path "${shortExisting}"`;
  }

  private renderDropdown() {
    if (!this.dropdownEl) return;

    this.dropdownEl.empty();

    // Header
    const headerEl = this.dropdownEl.createDiv({ cls: 'claudian-external-context-header' });
    headerEl.setText('外部资料');

    // Path list
    const listEl = this.dropdownEl.createDiv({ cls: 'claudian-external-context-list' });

    if (this.externalContextPaths.length === 0) {
      const emptyEl = listEl.createDiv({ cls: 'claudian-external-context-empty' });
      emptyEl.setText('点击文件夹图标添加');
    } else {
      for (const pathStr of this.externalContextPaths) {
        const itemEl = listEl.createDiv({ cls: 'claudian-external-context-item' });

        const pathTextEl = itemEl.createSpan({ cls: 'claudian-external-context-text' });
        // Show shortened path for display
        const displayPath = this.shortenPath(pathStr);
        pathTextEl.setText(displayPath);
        pathTextEl.setAttribute('title', pathStr);

        // Lock toggle button
        const isPersistent = this.persistentPaths.has(pathStr);
        const lockBtn = itemEl.createSpan({ cls: 'claudian-external-context-lock' });
        if (isPersistent) {
          lockBtn.addClass('locked');
        }
        setIcon(lockBtn, isPersistent ? 'lock' : 'unlock');
        lockBtn.setAttribute('title', isPersistent ? 'Persistent (click to make session-only)' : 'Session-only (click to persist)');
        lockBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.togglePersistence(pathStr);
        });

        const removeBtn = itemEl.createSpan({ cls: 'claudian-external-context-remove' });
        setIcon(removeBtn, 'x');
        removeBtn.setAttribute('title', '移除路径');
        removeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.removePath(pathStr);
        });
      }
    }
  }

  /** Shorten path for display (replace home dir with ~) */
  private shortenPath(fullPath: string): string {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const os = require('os');
      const homeDir = os.homedir();
      const normalize = (value: string) => value.replace(/\\/g, '/');
      const normalizedFull = normalize(fullPath);
      const normalizedHome = normalize(homeDir);
      const compareFull = process.platform === 'win32'
        ? normalizedFull.toLowerCase()
        : normalizedFull;
      const compareHome = process.platform === 'win32'
        ? normalizedHome.toLowerCase()
        : normalizedHome;
      if (compareFull.startsWith(compareHome)) {
        // Use normalized path length and normalize the result for consistent display
        const remainder = normalizedFull.slice(normalizedHome.length);
        return '~' + remainder;
      }
    } catch {
      // Fall through to return full path
    }
    return fullPath;
  }

  updateDisplay() {
    if (!this.iconEl || !this.badgeEl) return;

    const count = this.externalContextPaths.length;

    if (count > 0) {
      this.iconEl.addClass('active');
      this.iconEl.setAttribute('title', `${count} external context${count > 1 ? 's' : ''} (click to add more)`);

      // Show badge only when more than 1 path
      if (count > 1) {
        this.badgeEl.setText(String(count));
        this.badgeEl.addClass('visible');
      } else {
        this.badgeEl.removeClass('visible');
      }
    } else {
      this.iconEl.removeClass('active');
      this.iconEl.setAttribute('title', '添加外部资料');
      this.badgeEl.removeClass('visible');
    }
  }
}

export class McpServerSelector {
  private container: HTMLElement;
  private forceHidden = false;
  private iconEl: HTMLElement | null = null;
  private badgeEl: HTMLElement | null = null;
  private dropdownEl: HTMLElement | null = null;
  private mcpManager: McpServerManager | null = null;
  private enabledServers: Set<string> = new Set();
  private onChangeCallback: ((enabled: Set<string>) => void) | null = null;

  constructor(parentEl: HTMLElement) {
    this.container = parentEl.createDiv({ cls: 'claudian-mcp-selector' });
    this.render();
  }

  setMcpManager(manager: McpServerManager | null): void {
    this.mcpManager = manager;
    this.pruneEnabledServers();
    this.updateDisplay();
    this.renderDropdown();
  }

  setOnChange(callback: (enabled: Set<string>) => void): void {
    this.onChangeCallback = callback;
  }

  getEnabledServers(): Set<string> {
    return new Set(this.enabledServers);
  }

  addMentionedServers(names: Set<string>): void {
    let changed = false;
    for (const name of names) {
      if (!this.enabledServers.has(name)) {
        this.enabledServers.add(name);
        changed = true;
      }
    }
    if (changed) {
      this.updateDisplay();
      this.renderDropdown();
    }
  }

  clearEnabled(): void {
    this.enabledServers.clear();
    this.updateDisplay();
    this.renderDropdown();
  }

  setEnabledServers(names: string[]): void {
    this.enabledServers = new Set(names);
    this.pruneEnabledServers();
    this.updateDisplay();
    this.renderDropdown();
  }

  setVisible(visible: boolean): void {
    this.forceHidden = !visible;
    if (!visible) {
      this.container.style.display = 'none';
      return;
    }
    this.updateDisplay();
  }

  private pruneEnabledServers(): void {
    if (!this.mcpManager) return;
    const activeNames = new Set(this.mcpManager.getServers().filter((s) => s.enabled).map((s) => s.name));
    let changed = false;
    for (const name of this.enabledServers) {
      if (!activeNames.has(name)) {
        this.enabledServers.delete(name);
        changed = true;
      }
    }
    if (changed) {
      this.onChangeCallback?.(this.enabledServers);
    }
  }

  private render() {
    this.container.empty();

    const iconWrapper = this.container.createDiv({ cls: 'claudian-mcp-selector-icon-wrapper' });

    this.iconEl = iconWrapper.createDiv({ cls: 'claudian-mcp-selector-icon' });
    this.iconEl.innerHTML = MCP_ICON_SVG;

    this.badgeEl = iconWrapper.createDiv({ cls: 'claudian-mcp-selector-badge' });

    this.updateDisplay();

    this.dropdownEl = this.container.createDiv({ cls: 'claudian-mcp-selector-dropdown' });
    this.renderDropdown();

    // Re-render dropdown content on hover (CSS handles visibility)
    this.container.addEventListener('mouseenter', () => {
      this.renderDropdown();
    });
  }

  private renderDropdown() {
    if (!this.dropdownEl) return;
    this.pruneEnabledServers();
    this.dropdownEl.empty();

    // Header
    const headerEl = this.dropdownEl.createDiv({ cls: 'claudian-mcp-selector-header' });
    headerEl.setText('MCP 服务');

    // Server list
    const listEl = this.dropdownEl.createDiv({ cls: 'claudian-mcp-selector-list' });

    const allServers = this.mcpManager?.getServers() || [];
    const servers = allServers.filter(s => s.enabled);

    if (servers.length === 0) {
      const emptyEl = listEl.createDiv({ cls: 'claudian-mcp-selector-empty' });
      emptyEl.setText(allServers.length === 0 ? 'No MCP servers configured' : 'All MCP servers disabled');
      return;
    }

    for (const server of servers) {
      this.renderServerItem(listEl, server);
    }
  }

  private renderServerItem(listEl: HTMLElement, server: ClaudianMcpServer) {
    const itemEl = listEl.createDiv({ cls: 'claudian-mcp-selector-item' });
    itemEl.dataset.serverName = server.name;

    const isEnabled = this.enabledServers.has(server.name);
    if (isEnabled) {
      itemEl.addClass('enabled');
    }

    // Checkbox
    const checkEl = itemEl.createDiv({ cls: 'claudian-mcp-selector-check' });
    if (isEnabled) {
      checkEl.innerHTML = CHECK_ICON_SVG;
    }

    // Info
    const infoEl = itemEl.createDiv({ cls: 'claudian-mcp-selector-item-info' });

    const nameEl = infoEl.createSpan({ cls: 'claudian-mcp-selector-item-name' });
    nameEl.setText(server.name);

    // Badges
    if (server.contextSaving) {
      const csEl = infoEl.createSpan({ cls: 'claudian-mcp-selector-cs-badge' });
      csEl.setText('@');
      csEl.setAttribute('title', '按需加载，也可以通过 @' + server.name + ' 启用');
    }

    // Click to toggle (use mousedown for more reliable capture)
    itemEl.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.toggleServer(server.name, itemEl);
    });
  }

  private toggleServer(name: string, itemEl: HTMLElement) {
    if (this.enabledServers.has(name)) {
      this.enabledServers.delete(name);
    } else {
      this.enabledServers.add(name);
    }

    // Update item visually in-place (immediate feedback)
    const isEnabled = this.enabledServers.has(name);
    const checkEl = itemEl.querySelector('.claudian-mcp-selector-check') as HTMLElement | null;

    if (isEnabled) {
      itemEl.addClass('enabled');
      if (checkEl) checkEl.innerHTML = CHECK_ICON_SVG;
    } else {
      itemEl.removeClass('enabled');
      if (checkEl) checkEl.innerHTML = '';
    }

    this.updateDisplay();
    this.onChangeCallback?.(this.enabledServers);
  }

  updateDisplay() {
    this.pruneEnabledServers();
    if (!this.iconEl || !this.badgeEl) return;

    if (this.forceHidden) {
      this.container.style.display = 'none';
      return;
    }

    const count = this.enabledServers.size;
    const hasServers = (this.mcpManager?.getServers().length || 0) > 0;

    // Show/hide container based on whether there are servers
    if (!hasServers) {
      this.container.style.display = 'none';
      return;
    }
    this.container.style.display = '';

    if (count > 0) {
      this.iconEl.addClass('active');
      this.iconEl.setAttribute('title', `${count} MCP server${count > 1 ? 's' : ''} enabled (click to manage)`);

      // Show badge only when more than 1
      if (count > 1) {
        this.badgeEl.setText(String(count));
        this.badgeEl.addClass('visible');
      } else {
        this.badgeEl.removeClass('visible');
      }
    } else {
      this.iconEl.removeClass('active');
      this.iconEl.setAttribute('title', 'MCP 服务（点击启用）');
      this.badgeEl.removeClass('visible');
    }
  }
}

export class ContextUsageMeter {
  private container: HTMLElement;
  private fillPath: SVGPathElement | null = null;
  private percentEl: HTMLElement | null = null;
  private circumference: number = 0;

  constructor(parentEl: HTMLElement) {
    this.container = parentEl.createDiv({ cls: 'claudian-context-meter' });
    this.render();
    // Initially hidden
    this.container.style.display = 'none';
  }

  private render() {
    const size = 16;
    const strokeWidth = 2;
    const radius = (size - strokeWidth) / 2;
    const cx = size / 2;
    const cy = size / 2;

    // 240° arc: from 150° to 390° (upper-left through bottom to upper-right)
    const startAngle = 150;
    const endAngle = 390;
    const arcDegrees = endAngle - startAngle;
    const arcRadians = (arcDegrees * Math.PI) / 180;
    this.circumference = radius * arcRadians;

    const startRad = (startAngle * Math.PI) / 180;
    const endRad = (endAngle * Math.PI) / 180;
    const x1 = cx + radius * Math.cos(startRad);
    const y1 = cy + radius * Math.sin(startRad);
    const x2 = cx + radius * Math.cos(endRad);
    const y2 = cy + radius * Math.sin(endRad);

    const gaugeEl = this.container.createDiv({ cls: 'claudian-context-meter-gauge' });
    gaugeEl.innerHTML = `
      <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
        <path class="claudian-meter-bg"
          d="M ${x1} ${y1} A ${radius} ${radius} 0 1 1 ${x2} ${y2}"
          fill="none" stroke-width="${strokeWidth}" stroke-linecap="round"/>
        <path class="claudian-meter-fill"
          d="M ${x1} ${y1} A ${radius} ${radius} 0 1 1 ${x2} ${y2}"
          fill="none" stroke-width="${strokeWidth}" stroke-linecap="round"
          stroke-dasharray="${this.circumference}" stroke-dashoffset="${this.circumference}"/>
      </svg>
    `;
    this.fillPath = gaugeEl.querySelector('.claudian-meter-fill');

    this.percentEl = this.container.createSpan({ cls: 'claudian-context-meter-percent' });
  }

  update(usage: UsageInfo | null): void {
    if (!usage || usage.contextTokens <= 0) {
      this.container.style.display = 'none';
      return;
    }
    this.container.style.display = 'flex';
    const fillLength = (usage.percentage / 100) * this.circumference;
    if (this.fillPath) {
      this.fillPath.style.strokeDashoffset = String(this.circumference - fillLength);
    }

    if (this.percentEl) {
      this.percentEl.setText(`${usage.percentage}%`);
    }

    // Toggle warning class for > 80%
    if (usage.percentage > 80) {
      this.container.addClass('warning');
    } else {
      this.container.removeClass('warning');
    }

    // Set tooltip with detailed usage
    let tooltip = `${this.formatTokens(usage.contextTokens)} / ${this.formatTokens(usage.contextWindow)}`;
    if (usage.percentage > 80) {
      tooltip += ' (Approaching limit, run `/compact` to continue)';
    }
    this.container.setAttribute('data-tooltip', tooltip);
  }

  private formatTokens(tokens: number): string {
    if (tokens >= 1000) {
      return `${Math.round(tokens / 1000)}k`;
    }
    return String(tokens);
  }
}

export function createInputToolbar(
  parentEl: HTMLElement,
  callbacks: ToolbarCallbacks
): {
  modelSelector: ModelSelector;
  thinkingBudgetSelector: ThinkingBudgetSelector;
  contextUsageMeter: ContextUsageMeter | null;
  externalContextSelector: ExternalContextSelector;
  mcpServerSelector: McpServerSelector;
  permissionToggle: PermissionToggle;
} {
  const modelSelector = new ModelSelector(parentEl, callbacks);
  const thinkingBudgetSelector = new ThinkingBudgetSelector(parentEl, callbacks);
  const contextUsageMeter = new ContextUsageMeter(parentEl);
  new ActiveNoteAttachButton(parentEl, callbacks);
  new InboxCaptureButton(parentEl, callbacks);
  const externalContextSelector = new ExternalContextSelector(parentEl, callbacks);
  const mcpServerSelector = new McpServerSelector(parentEl);
  const permissionToggle = new PermissionToggle(parentEl, callbacks);

  return { modelSelector, thinkingBudgetSelector, contextUsageMeter, externalContextSelector, mcpServerSelector, permissionToggle };
}

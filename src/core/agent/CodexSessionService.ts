/* eslint-disable simple-import-sort/imports */
import { type ChildProcessWithoutNullStreams,spawn } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';

import type ClaudianPlugin from '../../main';
import { type CodexApprovalFlagScope,detectCodexCliCapabilities } from '../../utils/codexCli';
import { stripCurrentNoteContext } from '../../utils/context';
import { getEnhancedPath, parseEnvironmentVariables } from '../../utils/env';
import { getVaultPath } from '../../utils/path';
import { buildContextFromHistory, buildPromptWithHistoryContext } from '../../utils/session';
import { getCodexCommandsForDropdown, getKnowledgeCommandsForDropdown } from '../commands';
import type { McpServerManager } from '../mcp';
import { buildCodexRuntimeProfile, getModelProviderRuntimeEnvironment } from '../model';
import type { TodoItem } from '../tools';
import { TOOL_TODO_WRITE } from '../tools/toolNames';
import {
  BACKEND_CODEX,
  type BackendCapabilities,
  type ChatMessage,
  type Conversation,
  type ExitPlanModeCallback,
  getBackendCapabilities,
  type ImageAttachment,
  type PermissionMode,
  type SlashCommand,
  type StreamChunk,
  type UsageInfo,
} from '../types';
import type {
  AgentSessionService,
  ApprovalCallback,
  AskUserQuestionCallback,
  EnsureReadyOptions,
  QueryOptions,
  RewindFilesResult,
} from './AgentSessionService';
import type { ClosePersistentQueryOptions } from './types';

interface CodexUsagePayload {
  cached_input_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function getCodexErrorMessage(event: Record<string, unknown>): string | null {
  const directMessage = getString(event.message);
  if (directMessage) {
    return directMessage;
  }

  const error = event.error;
  if (typeof error === 'string') {
    return getString(error);
  }
  if (!isRecord(error)) {
    return null;
  }

  return getString(error.message) ?? getString(error.code);
}

function buildTodoWriteInput(
  itemsValue: unknown,
  options: { markFirstIncompleteInProgress: boolean },
): Record<string, unknown> | null {
  if (!Array.isArray(itemsValue)) {
    return null;
  }

  const todos: TodoItem[] = [];
  let firstIncompleteMarked = false;

  for (const item of itemsValue) {
    if (!isRecord(item)) {
      continue;
    }

    const text = getString(item.text);
    if (!text) {
      continue;
    }

    const isCompleted = item.completed === true;
    let status: TodoItem['status'] = isCompleted ? 'completed' : 'pending';

    if (!isCompleted && options.markFirstIncompleteInProgress && !firstIncompleteMarked) {
      status = 'in_progress';
      firstIncompleteMarked = true;
    }

    todos.push({
      content: text,
      activeForm: text,
      status,
    });
  }

  return todos.length > 0 ? { todos } : null;
}

function buildTodoResultText(input: Record<string, unknown>): string {
  const todos = Array.isArray(input.todos) ? input.todos : [];
  if (todos.length === 0) {
    return 'Tasks updated.';
  }

  const completed = todos.filter((todo) => isRecord(todo) && todo.status === 'completed').length;
  if (completed === todos.length) {
    return 'All tasks completed.';
  }

  return `Tasks updated (${completed}/${todos.length}).`;
}

function buildCommandResultText(output: string | null, exitCode: number | null): string {
  const trimmedOutput = output?.trimEnd() ?? '';
  if (trimmedOutput) {
    return trimmedOutput;
  }

  if (exitCode === null) {
    return 'Command finished.';
  }

  return exitCode === 0
    ? 'Command completed successfully.'
    : `Command failed with exit code ${exitCode}.`;
}

function getImageExtension(mediaType: ImageAttachment['mediaType']): string {
  switch (mediaType) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    default:
      return 'bin';
  }
}

export class CodexSessionService implements AgentSessionService {
  private readonly plugin: ClaudianPlugin;
  private readonly mcpManager: McpServerManager;
  private readonly readyStateListeners = new Set<(ready: boolean) => void>();

  private activeChild: ChildProcessWithoutNullStreams | null = null;
  private permissionModeSyncCallback: ((sdkMode: string) => void) | null = null;
  private currentSessionId: string | null = null;
  private currentExternalContextPaths: string[] = [];
  private userCancelled = false;

  constructor(plugin: ClaudianPlugin, mcpManager: McpServerManager) {
    this.plugin = plugin;
    this.mcpManager = mcpManager;
  }

  getBackendId(): 'codex' {
    return BACKEND_CODEX;
  }

  getBackendCapabilities(): BackendCapabilities {
    return getBackendCapabilities(BACKEND_CODEX);
  }

  onReadyStateChange(listener: (ready: boolean) => void): () => void {
    this.readyStateListeners.add(listener);

    try {
      listener(this.isReady());
    } catch {
      // Ignore listener errors
    }

    return () => {
      this.readyStateListeners.delete(listener);
    };
  }

  private notifyReadyStateChange(): void {
    const ready = this.isReady();

    for (const listener of this.readyStateListeners) {
      try {
        listener(ready);
      } catch {
        // Ignore listener errors
      }
    }
  }

  setPendingResumeAt(_uuid: string | undefined): void {
    // Codex CLI does not expose resume-at semantics.
  }

  applyForkState(conv: Pick<Conversation, 'sessionId' | 'sdkSessionId' | 'forkSource'>): string | null {
    return conv.sessionId ?? null;
  }

  async ensureReady(options?: EnsureReadyOptions): Promise<boolean> {
    if (options?.sessionId !== undefined) {
      this.currentSessionId = options.sessionId ?? null;
    }

    if (options?.externalContextPaths !== undefined) {
      this.currentExternalContextPaths = [...options.externalContextPaths];
    }

    this.notifyReadyStateChange();
    return this.isReady();
  }

  closePersistentQuery(_reason?: string, _options?: ClosePersistentQueryOptions): void {
    this.killActiveChild();
  }

  async *query(
    prompt: string,
    images?: ImageAttachment[],
    conversationHistory?: ChatMessage[],
    queryOptions?: QueryOptions,
  ): AsyncGenerator<StreamChunk> {
    const vaultPath = getVaultPath(this.plugin.app);
    if (!vaultPath) {
      yield { type: 'error', content: 'Could not determine vault path' };
      return;
    }

    const codexPath = this.plugin.getResolvedCodexCliPath();
    if (!codexPath) {
      yield { type: 'error', content: 'Codex CLI not found. Please install Codex CLI and ensure it is on PATH.' };
      return;
    }

    if (queryOptions?.externalContextPaths !== undefined) {
      this.currentExternalContextPaths = [...queryOptions.externalContextPaths];
    }

    const shouldInjectHistory = !this.currentSessionId && !!conversationHistory?.length;
    const basePromptToSend = shouldInjectHistory
      ? this.buildPromptWithHistory(prompt, conversationHistory)
      : prompt;
    const promptToSend = this.decoratePromptForMode(basePromptToSend, this.plugin.settings.permissionMode);

    yield* this.runCodexQuery({
      codexPath,
      conversationHistory,
      images,
      originalPrompt: prompt,
      prompt: promptToSend,
      queryOptions,
      resumeSessionId: shouldInjectHistory ? null : this.currentSessionId,
      retryOnSessionMismatch: !shouldInjectHistory,
      vaultPath,
    });
  }

  cancel(): void {
    this.userCancelled = true;
    this.killActiveChild();
  }

  resetSession(): void {
    this.currentSessionId = null;
  }

  async reloadMcpServers(): Promise<void> {
    await this.mcpManager.loadServers();
  }

  getSessionId(): string | null {
    return this.currentSessionId;
  }

  consumeSessionInvalidation(): boolean {
    return false;
  }

  isReady(): boolean {
    return this.plugin.getResolvedCodexCliPath() !== null;
  }

  setSessionId(id: string | null, externalContextPaths?: string[]): void {
    this.currentSessionId = id;
    if (externalContextPaths !== undefined) {
      this.currentExternalContextPaths = [...externalContextPaths];
    }

    void this.ensureReady({
      sessionId: id ?? undefined,
      externalContextPaths,
    });
  }

  cleanup(): void {
    this.cancel();
    this.currentSessionId = null;
  }

  setApprovalCallback(_callback: ApprovalCallback | null): void {}

  setApprovalDismisser(_dismisser: (() => void) | null): void {}

  setAskUserQuestionCallback(_callback: AskUserQuestionCallback | null): void {}

  setExitPlanModeCallback(_callback: ExitPlanModeCallback | null): void {}

  setPermissionModeSyncCallback(callback: ((sdkMode: string) => void) | null): void {
    this.permissionModeSyncCallback = callback;
  }

  async getSupportedCommands(): Promise<SlashCommand[]> {
    const localCommands = (this.plugin.settings.slashCommands ?? [])
      .filter((command) => command.userInvocable !== false)
      .map((command) => ({
        ...command,
        source: command.source ?? 'user',
      }));

    return [
      ...getCodexCommandsForDropdown(),
      ...getKnowledgeCommandsForDropdown(),
      ...localCommands,
    ];
  }

  async rewind(_sdkUserUuid: string, _sdkAssistantUuid: string): Promise<RewindFilesResult> {
    throw new Error('Codex backend does not support rewind yet.');
  }

  private decoratePromptForMode(prompt: string, mode: PermissionMode): string {
    if (mode !== 'plan') {
      return prompt;
    }

    const trimmedPrompt = prompt.trimStart();
    if (trimmedPrompt.startsWith('/plan')) {
      return prompt;
    }

    return prompt.trim().length > 0 ? `/plan\n\n${prompt}` : '/plan';
  }

  private async *runCodexQuery(options: {
    codexPath: string;
    conversationHistory?: ChatMessage[];
    images?: ImageAttachment[];
    originalPrompt: string;
    prompt: string;
    queryOptions?: QueryOptions;
    resumeSessionId: string | null;
    retryOnSessionMismatch: boolean;
    vaultPath: string;
  }): AsyncGenerator<StreamChunk> {
    const {
      codexPath,
      conversationHistory,
      images,
      originalPrompt,
      prompt,
      queryOptions,
      resumeSessionId,
      retryOnSessionMismatch,
      vaultPath,
    } = options;

    const customEnv = parseEnvironmentVariables(this.plugin.getActiveEnvironmentVariables());
    const providerEnv = getModelProviderRuntimeEnvironment(
      this.plugin.settings,
      this.plugin.app.secretStorage,
    );
    const enhancedPath = getEnhancedPath(customEnv.PATH, codexPath);
    const env = {
      ...process.env,
      ...customEnv,
      ...providerEnv,
      PATH: enhancedPath,
    };

    const tempImages = await this.prepareImages(images);

    try {
      const args = this.buildCodexArgs({
        codexPath,
        imagePaths: tempImages.imagePaths,
        permissionMode: this.plugin.settings.permissionMode,
        prompt,
        queryOptions,
        resumeSessionId,
        vaultPath,
      });

      this.userCancelled = false;
      const child = spawn(codexPath, args, {
        cwd: vaultPath,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });

      if (!child.stdin || !child.stdout || !child.stderr) {
        yield { type: 'error', content: 'Failed to create Codex process streams.' };
        return;
      }

      this.activeChild = child;
      child.stdin.on('error', () => {});
      child.stdin.end(prompt);

      const stdoutRl = readline.createInterface({ input: child.stdout });
      const stderrRl = readline.createInterface({ input: child.stderr });

      const queue: StreamChunk[] = [];
      const stderrLines: string[] = [];
      const emittedCommandIds = new Set<string>();
      let sawStructuredEvent = false;
      let sawErrorChunk = false;
      let parseError: string | null = null;
      let processError: string | null = null;
      let retryWithHistory = false;
      let done = false;
      let resolveNext: (() => void) | null = null;
      let closeCode: number | null = null;
      let closeSignal: NodeJS.Signals | null = null;

      const pushChunk = (chunk: StreamChunk): void => {
        queue.push(chunk);
        if (resolveNext) {
          resolveNext();
          resolveNext = null;
        }
      };

      const finish = (): void => {
        done = true;
        if (resolveNext) {
          resolveNext();
          resolveNext = null;
        }
      };

      stdoutRl.on('line', (line) => {
        if (!line.trim() || retryWithHistory) {
          return;
        }

        let event: unknown;
        try {
          event = JSON.parse(line) as unknown;
          sawStructuredEvent = true;
        } catch {
          parseError = parseError ?? `Failed to parse Codex event: ${line}`;
          return;
        }

        const handled = this.handleEvent({
          allowSessionMismatchRetry: retryOnSessionMismatch,
          conversationHistoryAvailable: !!conversationHistory?.length,
          emittedCommandIds,
          expectedSessionId: resumeSessionId,
          event,
        });

        if (handled.retryWithHistory) {
          retryWithHistory = true;
          this.killActiveChild();
          return;
        }

        for (const chunk of handled.chunks) {
          if (chunk.type === 'error') {
            sawErrorChunk = true;
          }
          pushChunk(chunk);
        }
      });

      stderrRl.on('line', (line) => {
        if (line.trim()) {
          stderrLines.push(line.trim());
        }
      });

      child.once('error', (error) => {
        processError = error instanceof Error ? error.message : String(error);
        finish();
      });

      child.once('close', (code, signal) => {
        closeCode = code;
        closeSignal = signal;
        finish();
      });

      while (!done || queue.length > 0) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }

        await new Promise<void>((resolve) => {
          resolveNext = resolve;
        });
      }

      stdoutRl.close();
      stderrRl.close();
      this.activeChild = null;

      if (retryWithHistory && conversationHistory?.length) {
        this.currentSessionId = null;
        const rebuiltPrompt = this.buildPromptWithHistory(originalPrompt, conversationHistory);
        yield* this.runCodexQuery({
          codexPath,
          conversationHistory: undefined,
          images,
          originalPrompt,
          prompt: rebuiltPrompt,
          queryOptions,
          resumeSessionId: null,
          retryOnSessionMismatch: false,
          vaultPath,
        });
        return;
      }

      if (this.userCancelled) {
        return;
      }

      if (processError) {
        yield { type: 'error', content: processError };
        return;
      }

      if (!sawStructuredEvent && parseError) {
        yield { type: 'error', content: parseError };
        return;
      }

      if (closeCode !== null && closeCode !== 0 && closeSignal === null) {
        if (!sawErrorChunk) {
          const stderrText = stderrLines.join('\n');
          yield {
            type: 'error',
            content: stderrText || `Codex exited with code ${closeCode}.`,
          };
        }
        return;
      }

      yield { type: 'done' };
    } finally {
      this.activeChild = null;
      this.userCancelled = false;
      await tempImages.cleanup();
    }
  }

  private buildCodexArgs(options: {
    codexPath: string;
    imagePaths: string[];
    permissionMode: PermissionMode;
    prompt: string;
    queryOptions?: QueryOptions;
    resumeSessionId: string | null;
    vaultPath: string;
  }): string[] {
    const { codexPath, imagePaths, permissionMode, queryOptions, resumeSessionId, vaultPath } = options;
    const capabilities = detectCodexCliCapabilities(codexPath);
    const performanceMode = this.plugin.settings.codexPerformanceMode ?? 'fast';
    const runtimeProfile = buildCodexRuntimeProfile(
      this.plugin.settings,
      performanceMode,
      queryOptions?.model?.trim(),
    );
    const args = [
      ...this.buildCodexGlobalArgs(permissionMode, vaultPath, capabilities.approvalFlagScope),
      ...runtimeProfile.rootArgs,
      'exec',
      ...this.buildCodexExecApprovalArgs(capabilities.approvalFlagScope),
    ];

    // Codex 0.114.x exposes --ask-for-approval at the root CLI level, not under
    // `codex exec --help`. Keep approval args placement capability-driven so CLI
    // upgrades do not silently break non-interactive launches.

    if (resumeSessionId) {
      args.push('resume');
    }

    const externalContextPaths = queryOptions?.externalContextPaths ?? this.currentExternalContextPaths;
    const extraDirs = [...new Set(externalContextPaths)].filter((dir) => dir && dir !== vaultPath);
    for (const dir of extraDirs) {
      args.push('--add-dir', dir);
    }

    for (const imagePath of imagePaths) {
      args.push('--image', imagePath);
    }

    args.push('--model', runtimeProfile.model, ...runtimeProfile.execConfigArgs);

    args.push('--skip-git-repo-check', '--json');

    if (resumeSessionId) {
      args.push(resumeSessionId);
    }

    args.push('-');
    return args;
  }

  private buildCodexGlobalArgs(
    mode: PermissionMode,
    vaultPath: string,
    approvalFlagScope: CodexApprovalFlagScope
  ): string[] {
    const args = [
      '-s',
      mode === 'yolo' ? 'danger-full-access' : 'workspace-write',
      '-C',
      vaultPath,
    ];

    if (approvalFlagScope === 'root' || approvalFlagScope === 'both') {
      args.unshift('never');
      args.unshift('-a');
    }

    return args;
  }

  private buildCodexExecApprovalArgs(approvalFlagScope: CodexApprovalFlagScope): string[] {
    if (approvalFlagScope === 'exec') {
      return ['-a', 'never'];
    }

    return [];
  }

  private syncPermissionModeFromPayload(payload: Record<string, unknown>): void {
    const permissionMode = getString(payload.permission_mode) ?? getString(payload.permissionMode);
    if (!permissionMode || !this.permissionModeSyncCallback) {
      return;
    }

    try {
      this.permissionModeSyncCallback(permissionMode);
    } catch {
      // Ignore callback errors
    }
  }

  private handleEvent(options: {
    allowSessionMismatchRetry: boolean;
    conversationHistoryAvailable: boolean;
    emittedCommandIds: Set<string>;
    expectedSessionId: string | null;
    event: unknown;
  }): { chunks: StreamChunk[]; retryWithHistory: boolean } {
    const { allowSessionMismatchRetry, conversationHistoryAvailable, emittedCommandIds, expectedSessionId, event } = options;
    if (!isRecord(event)) {
      return { chunks: [], retryWithHistory: false };
    }

    this.syncPermissionModeFromPayload(event);

    const eventType = getString(event.type);
    if (!eventType) {
      return { chunks: [], retryWithHistory: false };
    }

    if (eventType === 'thread.started') {
      const threadId = getString(event.thread_id);
      if (!threadId) {
        return { chunks: [], retryWithHistory: false };
      }

      if (
        allowSessionMismatchRetry &&
        expectedSessionId &&
        threadId !== expectedSessionId &&
        conversationHistoryAvailable
      ) {
        return { chunks: [], retryWithHistory: true };
      }

      this.currentSessionId = threadId;
      return { chunks: [], retryWithHistory: false };
    }

    if (eventType === 'turn.completed') {
      const usage = this.toUsageInfo(event.usage);
      return usage
        ? { chunks: [{ type: 'usage', usage, sessionId: this.currentSessionId }], retryWithHistory: false }
        : { chunks: [], retryWithHistory: false };
    }

    if (eventType === 'turn.failed' || eventType === 'error') {
      return {
        chunks: [{
          type: 'error',
          content: getCodexErrorMessage(event) ?? 'Codex turn failed.',
        }],
        retryWithHistory: false,
      };
    }

    if (eventType !== 'item.started' && eventType !== 'item.updated' && eventType !== 'item.completed') {
      return { chunks: [], retryWithHistory: false };
    }

    const item = isRecord(event.item) ? event.item : null;
    if (!item) {
      return { chunks: [], retryWithHistory: false };
    }

    this.syncPermissionModeFromPayload(item);

    const itemType = getString(item.type);
    if (!itemType) {
      return { chunks: [], retryWithHistory: false };
    }

    if (itemType === 'agent_message' && eventType === 'item.completed') {
      const text = getString(item.text);
      return text
        ? { chunks: [{ type: 'text', content: text }], retryWithHistory: false }
        : { chunks: [], retryWithHistory: false };
    }

    if (itemType === 'reasoning' && eventType === 'item.completed') {
      const text = getString(item.text);
      return text
        ? { chunks: [{ type: 'thinking', content: text }], retryWithHistory: false }
        : { chunks: [], retryWithHistory: false };
    }

    if (itemType === 'todo_list') {
      const input = buildTodoWriteInput(item.items, {
        markFirstIncompleteInProgress: eventType === 'item.started',
      });
      if (!input) {
        return { chunks: [], retryWithHistory: false };
      }

      const id = getString(item.id) ?? `codex-todos-${randomUUID()}`;
      const chunks: StreamChunk[] = [
        {
          type: 'tool_use',
          id,
          name: TOOL_TODO_WRITE,
          input,
        },
      ];

      if (eventType === 'item.completed') {
        chunks.push({
          type: 'tool_result',
          id,
          content: buildTodoResultText(input),
        });
      }

      return { chunks, retryWithHistory: false };
    }

    if (itemType !== 'command_execution') {
      return { chunks: [], retryWithHistory: false };
    }

    const id = getString(item.id) ?? `codex-command-${randomUUID()}`;
    const command = getString(item.command) ?? 'command';
    const chunks: StreamChunk[] = [];

    if (!emittedCommandIds.has(id)) {
      emittedCommandIds.add(id);
      chunks.push({
        type: 'tool_use',
        id,
        name: 'command_execution',
        input: { command },
      });
    }

    if (eventType === 'item.completed') {
      const exitCode = typeof item.exit_code === 'number' ? item.exit_code : null;
      const aggregatedOutput = getString(item.aggregated_output);
      chunks.push({
        type: 'tool_result',
        id,
        content: buildCommandResultText(aggregatedOutput, exitCode),
        isError: exitCode !== null && exitCode !== 0,
      });
    }

    return { chunks, retryWithHistory: false };
  }

  private toUsageInfo(value: unknown): UsageInfo | null {
    if (!isRecord(value)) {
      return null;
    }

    const usage = value as CodexUsagePayload;
    return {
      inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: typeof usage.cached_input_tokens === 'number' ? usage.cached_input_tokens : 0,
      contextWindow: 0,
      contextTokens: 0,
      percentage: 0,
    };
  }

  private buildPromptWithHistory(prompt: string, conversationHistory: ChatMessage[]): string {
    const historyContext = buildContextFromHistory(conversationHistory);
    const actualPrompt = stripCurrentNoteContext(prompt);
    return buildPromptWithHistoryContext(historyContext, prompt, actualPrompt, conversationHistory);
  }

  private async prepareImages(images?: ImageAttachment[]): Promise<{
    cleanup: () => Promise<void>;
    imagePaths: string[];
  }> {
    if (!images || images.length === 0) {
      return {
        cleanup: async () => {},
        imagePaths: [],
      };
    }

    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'claudian-codex-'));
    const imagePaths: string[] = [];

    for (const [index, image] of images.entries()) {
      const extension = getImageExtension(image.mediaType);
      const filePath = path.join(tempDir, `${index}-${randomUUID()}.${extension}`);
      const buffer = Buffer.from(image.data, 'base64');
      await fs.promises.writeFile(filePath, buffer);
      imagePaths.push(filePath);
    }

    return {
      cleanup: async () => {
        await fs.promises.rm(tempDir, { force: true, recursive: true });
      },
      imagePaths,
    };
  }

  private killActiveChild(): void {
    if (!this.activeChild || this.activeChild.killed) {
      return;
    }

    try {
      this.activeChild.kill('SIGTERM');
    } catch {
      // Ignore kill errors
    }
  }
}

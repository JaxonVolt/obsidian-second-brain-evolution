import type { ApprovalDecision, BackendCapabilities, BackendId, ChatMessage, CodexPerformanceMode, Conversation, ExitPlanModeCallback, ImageAttachment, SlashCommand, StreamChunk } from '../types';
import type { ClosePersistentQueryOptions } from './types';

export interface ApprovalCallbackOptions {
  decisionReason?: string;
  blockedPath?: string;
  agentID?: string;
}

export type ApprovalCallback = (
  toolName: string,
  input: Record<string, unknown>,
  description: string,
  options?: ApprovalCallbackOptions,
) => Promise<ApprovalDecision>;

export type AskUserQuestionCallback = (
  input: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<Record<string, string> | null>;

export interface QueryOptions {
  allowedTools?: string[];
  model?: string;
  performanceMode?: CodexPerformanceMode;
  sandboxMode?: 'read-only' | 'workspace-write';
  /** Extra developer instructions for the current channel only. */
  additionalDeveloperInstructions?: string;
  mcpMentions?: Set<string>;
  enabledMcpServers?: Set<string>;
  forceColdStart?: boolean;
  externalContextPaths?: string[];
  /** Existing plugin transcript for on-demand recovery of older conversation details. */
  historySourcePath?: string;
}

export interface EnsureReadyOptions {
  sessionId?: string;
  force?: boolean;
  externalContextPaths?: string[];
  preserveHandlers?: boolean;
}

export interface RewindFilesResult {
  canRewind: boolean;
  error?: string;
  filesChanged?: string[];
}

/**
 * Runtime-agnostic chat session interface used by the UI layer.
 *
 * ClaudianService is the first concrete implementation. Future backends
 * (for example Codex) can implement the same surface without forcing the
 * chat feature to depend on Claude-specific internals.
 */
export interface AgentSessionService {
  getBackendId(): BackendId;
  getBackendCapabilities(): BackendCapabilities;
  onReadyStateChange(listener: (ready: boolean) => void): () => void;
  setPendingResumeAt(uuid: string | undefined): void;
  applyForkState(conv: Pick<Conversation, 'sessionId' | 'sdkSessionId' | 'forkSource'>): string | null;
  ensureReady(options?: EnsureReadyOptions): Promise<boolean>;
  closePersistentQuery(reason?: string, options?: ClosePersistentQueryOptions): void;
  query(
    prompt: string,
    images?: ImageAttachment[],
    previousMessages?: ChatMessage[],
    queryOptions?: QueryOptions,
  ): AsyncGenerator<StreamChunk>;
  cancel(): void;
  resetSession(): void;
  reloadMcpServers(): Promise<void>;
  getSessionId(): string | null;
  consumeSessionInvalidation(): boolean;
  isReady(): boolean;
  setSessionId(id: string | null, externalContextPaths?: string[]): void;
  cleanup(): void;
  setApprovalCallback(callback: ApprovalCallback | null): void;
  setApprovalDismisser(dismisser: (() => void) | null): void;
  setAskUserQuestionCallback(callback: AskUserQuestionCallback | null): void;
  setExitPlanModeCallback(callback: ExitPlanModeCallback | null): void;
  setPermissionModeSyncCallback(callback: ((sdkMode: string) => void) | null): void;
  getSupportedCommands(): Promise<SlashCommand[]>;
  rewind(sdkUserUuid: string, sdkAssistantUuid: string): Promise<RewindFilesResult>;
}


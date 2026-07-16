/**
 * Backend type definitions and capability flags.
 *
 * These describe which agent runtime powers a conversation and which
 * features the UI can rely on for that runtime.
 */

/** Supported backend identifiers. */
export const BACKEND_CLAUDE = 'claude' as const;
export const BACKEND_CODEX = 'codex' as const;

/** Default backend for legacy conversations and fresh installs. */
export const DEFAULT_BACKEND_ID = BACKEND_CODEX;

/** All known backends in stable display order. */
export const SUPPORTED_BACKEND_IDS = [
  BACKEND_CLAUDE,
  BACKEND_CODEX,
] as const;

/** Runtime/backend identifier. */
export type BackendId = (typeof SUPPORTED_BACKEND_IDS)[number];

/** UI-facing capability snapshot for a backend. */
export interface BackendCapabilities {
  id: BackendId;
  displayName: string;
  supportsModelSelection: boolean;
  supportsThinkingBudget: boolean;
  supportsReasoningEffort: boolean;
  supportsPlanMode: boolean;
  supportsAskUserQuestion: boolean;
  supportsSubagents: boolean;
  supportsPlugins: boolean;
  supportsSkills: boolean;
  supportsSessionResume: boolean;
  supportsFork: boolean;
  supportsRewind: boolean;
  supportsNativeHistory: boolean;
  supportsImageInput: boolean;
  supportsMcp: boolean;
}

const BACKEND_CAPABILITIES: Record<BackendId, BackendCapabilities> = {
  [BACKEND_CLAUDE]: {
    id: BACKEND_CLAUDE,
    displayName: 'Claude Code',
    supportsModelSelection: true,
    supportsThinkingBudget: true,
    supportsReasoningEffort: false,
    supportsPlanMode: true,
    supportsAskUserQuestion: true,
    supportsSubagents: true,
    supportsPlugins: true,
    supportsSkills: true,
    supportsSessionResume: true,
    supportsFork: true,
    supportsRewind: true,
    supportsNativeHistory: true,
    supportsImageInput: true,
    supportsMcp: true,
  },
  [BACKEND_CODEX]: {
    id: BACKEND_CODEX,
    displayName: 'Codex',
    supportsModelSelection: true,
    supportsThinkingBudget: false,
    supportsReasoningEffort: true,
    supportsPlanMode: true,
    supportsAskUserQuestion: false,
    supportsSubagents: false,
    supportsPlugins: false,
    supportsSkills: false,
    supportsSessionResume: true,
    supportsFork: false,
    supportsRewind: false,
    supportsNativeHistory: false,
    supportsImageInput: true,
    supportsMcp: false,
  },
};

/** Type guard for persisted backend ids. */
export function isBackendId(value: unknown): value is BackendId {
  return typeof value === 'string' && (SUPPORTED_BACKEND_IDS as readonly string[]).includes(value);
}

/** Normalizes a persisted backend id with a safe fallback. */
export function normalizeBackendId(
  value: unknown,
  fallback: BackendId = DEFAULT_BACKEND_ID,
): BackendId {
  return isBackendId(value) ? value : fallback;
}

/** Returns the capability descriptor for a backend. */
export function getBackendCapabilities(backendId: BackendId): BackendCapabilities {
  return BACKEND_CAPABILITIES[backendId];
}

/** Returns all supported backends with capabilities in stable order. */
export function getSupportedBackends(): BackendCapabilities[] {
  return SUPPORTED_BACKEND_IDS.map((backendId) => BACKEND_CAPABILITIES[backendId]);
}

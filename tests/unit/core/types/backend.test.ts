import {
  BACKEND_CLAUDE,
  BACKEND_CODEX,
  DEFAULT_BACKEND_ID,
  getBackendCapabilities,
  getSupportedBackends,
  isBackendId,
  normalizeBackendId,
} from '@/core/types';

describe('backend types', () => {
  it('uses Codex as the default backend', () => {
    expect(DEFAULT_BACKEND_ID).toBe(BACKEND_CODEX);
  });

  it('recognizes valid backend ids', () => {
    expect(isBackendId(BACKEND_CLAUDE)).toBe(true);
    expect(isBackendId(BACKEND_CODEX)).toBe(true);
    expect(isBackendId('unknown')).toBe(false);
  });

  it('normalizes invalid backend ids to the fallback', () => {
    expect(normalizeBackendId('codex')).toBe(BACKEND_CODEX);
    expect(normalizeBackendId('invalid')).toBe(DEFAULT_BACKEND_ID);
    expect(normalizeBackendId(undefined, BACKEND_CODEX)).toBe(BACKEND_CODEX);
  });

  it('returns backend capabilities for Claude', () => {
    const capabilities = getBackendCapabilities(BACKEND_CLAUDE);

    expect(capabilities.id).toBe(BACKEND_CLAUDE);
    expect(capabilities.displayName).toBe('Claude Code');
    expect(capabilities.supportsModelSelection).toBe(true);
    expect(capabilities.supportsThinkingBudget).toBe(true);
    expect(capabilities.supportsReasoningEffort).toBe(false);
    expect(capabilities.supportsPlanMode).toBe(true);
    expect(capabilities.supportsSkills).toBe(true);
    expect(capabilities.supportsRewind).toBe(true);
    expect(capabilities.supportsNativeHistory).toBe(true);
  });

  it('returns backend capabilities for Codex', () => {
    const capabilities = getBackendCapabilities(BACKEND_CODEX);

    expect(capabilities.id).toBe(BACKEND_CODEX);
    expect(capabilities.displayName).toBe('Codex');
    expect(capabilities.supportsModelSelection).toBe(true);
    expect(capabilities.supportsThinkingBudget).toBe(false);
    expect(capabilities.supportsReasoningEffort).toBe(true);
    expect(capabilities.supportsPlanMode).toBe(true);
    expect(capabilities.supportsPlugins).toBe(false);
    expect(capabilities.supportsSkills).toBe(false);
    expect(capabilities.supportsFork).toBe(false);
    expect(capabilities.supportsRewind).toBe(false);
    expect(capabilities.supportsMcp).toBe(false);
  });

  it('lists supported backends in stable order', () => {
    expect(getSupportedBackends().map((backend) => backend.id)).toEqual([
      BACKEND_CLAUDE,
      BACKEND_CODEX,
    ]);
  });
});

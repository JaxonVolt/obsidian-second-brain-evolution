/* eslint-disable simple-import-sort/imports */
import type ClaudianPlugin from '../../main';
import type { McpServerManager } from '../mcp';
import type { BackendId } from '../types';
import type { AgentSessionService } from './AgentSessionService';
import { CodexSessionService } from './CodexSessionService';

/**
 * Creates a concrete session service for the requested backend.
 *
 * This build intentionally exposes only the local Codex runtime.
 */
export function createAgentSessionService(
  plugin: ClaudianPlugin,
  mcpManager: McpServerManager,
  _backendId: BackendId,
): AgentSessionService {
  return new CodexSessionService(plugin, mcpManager);
}

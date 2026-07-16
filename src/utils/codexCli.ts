import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { HostnameCliPaths } from '../core/types/settings';
import { getHostnameKey, parseEnvironmentVariables } from './env';
import { expandHomePath, parsePathEntries, resolveNvmDefaultBin } from './path';


export type CodexApprovalFlagScope = 'root' | 'exec' | 'both' | 'unsupported';

export interface CodexCliCapabilities {
  version: string | null;
  approvalFlagScope: CodexApprovalFlagScope;
}

const codexCliCapabilitiesCache = new Map<string, CodexCliCapabilities>();

function readCommandOutput(commandPath: string, args: string[]): string {
  try {
    const result = spawnSync(commandPath, args, {
      encoding: 'utf8',
      timeout: 2000,
    });
    const stdout = typeof result.stdout === 'string' ? result.stdout : '';
    const stderr = typeof result.stderr === 'string' ? result.stderr : '';
    return `${stdout}
${stderr}`.trim();
  } catch {
    return '';
  }
}

function extractVersion(output: string): string | null {
  const match = output.match(/codex-cli\s+([^\s]+)/i);
  return match?.[1] ?? null;
}

function hasApprovalFlag(helpText: string): boolean {
  return helpText.includes('--ask-for-approval');
}

function resolveApprovalFlagScope(rootHelp: string, execHelp: string): CodexApprovalFlagScope {
  const supportsRoot = hasApprovalFlag(rootHelp);
  const supportsExec = hasApprovalFlag(execHelp);

  if (supportsRoot && supportsExec) {
    return 'both';
  }
  if (supportsRoot) {
    return 'root';
  }
  if (supportsExec) {
    return 'exec';
  }
  return 'unsupported';
}

export function clearCodexCliCapabilitiesCache(): void {
  codexCliCapabilitiesCache.clear();
}

export function detectCodexCliCapabilities(commandPath: string): CodexCliCapabilities {
  const trimmedPath = commandPath.trim();
  if (!trimmedPath) {
    return { version: null, approvalFlagScope: 'unsupported' };
  }

  const cached = codexCliCapabilitiesCache.get(trimmedPath);
  if (cached) {
    return cached;
  }

  const versionOutput = readCommandOutput(trimmedPath, ['--version']);
  const rootHelp = readCommandOutput(trimmedPath, ['--help']);
  const execHelp = readCommandOutput(trimmedPath, ['exec', '--help']);

  const capabilities: CodexCliCapabilities = {
    version: extractVersion(versionOutput || rootHelp),
    approvalFlagScope: resolveApprovalFlagScope(rootHelp, execHelp),
  };

  codexCliCapabilitiesCache.set(trimmedPath, capabilities);
  return capabilities;
}

function isExistingFile(filePath: string): boolean {
  try {
    if (!fs.existsSync(filePath)) {
      return false;
    }

    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function resolveConfiguredPath(configuredPath: string | undefined): string | null {
  const trimmed = (configuredPath ?? '').trim();
  if (!trimmed) {
    return null;
  }

  try {
    const expandedPath = expandHomePath(trimmed);
    return isExistingFile(expandedPath) ? expandedPath : null;
  } catch {
    return null;
  }
}

function dedupePaths(entries: string[]): string[] {
  const seen = new Set<string>();

  return entries.filter((entry) => {
    const key = process.platform === 'win32' ? entry.toLowerCase() : entry;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function findFirstExistingPath(entries: string[], candidates: string[]): string | null {
  for (const dir of entries) {
    for (const candidate of candidates) {
      const fullPath = path.join(dir, candidate);
      if (isExistingFile(fullPath)) {
        return fullPath;
      }
    }
  }

  return null;
}

function resolveCodexFromPathEntries(entries: string[]): string | null {
  if (entries.length === 0) {
    return null;
  }

  const candidates = process.platform === 'win32'
    ? ['codex.exe', 'codex']
    : ['codex'];

  return findFirstExistingPath(entries, candidates);
}

export function findCodexCliPath(pathValue?: string): string | null {
  const homeDir = os.homedir();
  const customEntries = dedupePaths(parsePathEntries(pathValue));
  const customResolution = resolveCodexFromPathEntries(customEntries);
  if (customResolution) {
    return customResolution;
  }

  const commonPaths: string[] = process.platform === 'win32'
    ? [
        path.join(homeDir, 'AppData', 'Roaming', 'npm', 'codex.exe'),
        path.join(homeDir, 'AppData', 'Local', 'Programs', 'Codex', 'codex.exe'),
        path.join(homeDir, '.local', 'bin', 'codex.exe'),
      ]
    : [
        path.join(homeDir, '.local', 'bin', 'codex'),
        path.join(homeDir, '.volta', 'bin', 'codex'),
        path.join(homeDir, '.asdf', 'shims', 'codex'),
        path.join(homeDir, '.asdf', 'bin', 'codex'),
        path.join(homeDir, 'bin', 'codex'),
        path.join(homeDir, '.npm-global', 'bin', 'codex'),
        '/usr/local/bin/codex',
        '/opt/homebrew/bin/codex',
      ];

  const npmPrefix = process.env.npm_config_prefix;
  if (npmPrefix) {
    commonPaths.push(
      process.platform === 'win32'
        ? path.join(expandHomePath(npmPrefix), 'codex.exe')
        : path.join(expandHomePath(npmPrefix), 'bin', 'codex')
    );
  }

  const nvmBin = resolveNvmDefaultBin(homeDir);
  if (nvmBin) {
    commonPaths.push(path.join(nvmBin, process.platform === 'win32' ? 'codex.exe' : 'codex'));
  }

  for (const candidate of commonPaths) {
    if (isExistingFile(candidate)) {
      return candidate;
    }
  }

  const envEntries = dedupePaths(parsePathEntries(process.env.PATH));
  return resolveCodexFromPathEntries(envEntries);
}

export function resolveConfiguredCodexCliPath(
  hostnamePaths: HostnameCliPaths | undefined,
  legacyPath: string | undefined,
  envText: string
): string | null {
  const hostnameKey = getHostnameKey();
  const hostnamePath = hostnamePaths?.[hostnameKey];

  const configuredPath = resolveConfiguredPath(hostnamePath) ?? resolveConfiguredPath(legacyPath);
  if (configuredPath) {
    return configuredPath;
  }

  const customEnv = parseEnvironmentVariables(envText || '');
  return findCodexCliPath(customEnv.PATH);
}

export function resolveCodexCliPath(envText: string): string | null {
  return resolveConfiguredCodexCliPath(undefined, undefined, envText);
}

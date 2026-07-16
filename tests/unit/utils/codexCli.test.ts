import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';

import { clearCodexCliCapabilitiesCache, detectCodexCliCapabilities, findCodexCliPath, resolveCodexCliPath, resolveConfiguredCodexCliPath } from '@/utils/codexCli';

jest.mock('child_process', () => ({
  spawnSync: jest.fn(),
}));
jest.mock('fs');
jest.mock('os');

describe('codexCli', () => {
  const mockedSpawnSync = spawnSync as jest.MockedFunction<typeof spawnSync>;
  const mockedExists = fs.existsSync as jest.Mock;
  const mockedStat = fs.statSync as jest.Mock;
  const mockedHome = os.homedir as jest.Mock;
  const mockedHostname = os.hostname as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    clearCodexCliCapabilitiesCache();
    mockedHome.mockReturnValue('/Users/test');
    mockedHostname.mockReturnValue('test-host');
    mockedExists.mockReturnValue(false);
    mockedStat.mockReturnValue({ isFile: () => true });
  });

  describe('findCodexCliPath', () => {
    it('finds codex from a provided PATH entry', () => {
      mockedExists.mockImplementation((target: string) => target === '/custom/bin/codex');

      expect(findCodexCliPath('/custom/bin')).toBe('/custom/bin/codex');
    });

    it('falls back to common install locations', () => {
      mockedExists.mockImplementation((target: string) => target === '/opt/homebrew/bin/codex');

      expect(findCodexCliPath('')).toBe('/opt/homebrew/bin/codex');
    });
  });


  describe('detectCodexCliCapabilities', () => {
    it('detects root-scoped approval flags from latest Codex help output', () => {
      mockedSpawnSync
        .mockReturnValueOnce({ stdout: 'codex-cli 0.114.0\n', stderr: '' } as any)
        .mockReturnValueOnce({ stdout: '... --ask-for-approval ...', stderr: '' } as any)
        .mockReturnValueOnce({ stdout: '... --full-auto only ...', stderr: '' } as any);

      const result = detectCodexCliCapabilities('/usr/local/bin/codex');

      expect(result).toEqual({
        version: '0.114.0',
        approvalFlagScope: 'root',
      });
    });

    it('caches capability detection per binary path', () => {
      mockedSpawnSync
        .mockReturnValueOnce({ stdout: 'codex-cli 0.114.0\n', stderr: '' } as any)
        .mockReturnValueOnce({ stdout: '... --ask-for-approval ...', stderr: '' } as any)
        .mockReturnValueOnce({ stdout: '...', stderr: '' } as any);

      const first = detectCodexCliCapabilities('/usr/local/bin/codex');
      const second = detectCodexCliCapabilities('/usr/local/bin/codex');

      expect(first).toEqual(second);
      expect(mockedSpawnSync).toHaveBeenCalledTimes(3);
    });
  });

  describe('resolveConfiguredCodexCliPath', () => {
    it('prefers hostname-specific configured path', () => {
      mockedExists.mockImplementation((target: string) => target === '/configured/host/codex');

      const result = resolveConfiguredCodexCliPath(
        { 'test-host': '/configured/host/codex' },
        '/configured/legacy/codex',
        ''
      );

      expect(result).toBe('/configured/host/codex');
    });

    it('falls back to legacy configured path', () => {
      mockedExists.mockImplementation((target: string) => target === '/configured/legacy/codex');

      const result = resolveConfiguredCodexCliPath(
        { 'other-host': '/configured/host/codex' },
        '/configured/legacy/codex',
        ''
      );

      expect(result).toBe('/configured/legacy/codex');
    });

    it('falls back to environment PATH auto-detection', () => {
      mockedExists.mockImplementation((target: string) => target === '/env/bin/codex');

      const result = resolveConfiguredCodexCliPath({}, '', 'PATH=/env/bin');

      expect(result).toBe('/env/bin/codex');
    });
  });

  describe('resolveCodexCliPath', () => {
    it('uses environment PATH when no manual paths are provided', () => {
      mockedExists.mockImplementation((target: string) => target === '/runtime/bin/codex');

      const result = resolveCodexCliPath('PATH=/runtime/bin');

      expect(result).toBe('/runtime/bin/codex');
    });
  });
});

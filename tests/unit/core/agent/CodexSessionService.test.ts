import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

import { CodexSessionService } from '@/core/agent/CodexSessionService';
import type { McpServerManager } from '@/core/mcp';
import type ClaudianPlugin from '@/main';
import { detectCodexCliCapabilities } from '@/utils/codexCli';

jest.mock('child_process', () => ({
  spawn: jest.fn(),
}));

jest.mock('@/utils/codexCli', () => ({
  detectCodexCliCapabilities: jest.fn(() => ({
    version: '0.114.0',
    approvalFlagScope: 'root',
  })),
}));

type MockMcpServerManager = jest.Mocked<McpServerManager>;

type MockChildProcess = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: jest.Mock<boolean, [NodeJS.Signals?]>;
  killed: boolean;
  written: () => string;
};

function createMockChildProcess(): MockChildProcess {
  const proc = new EventEmitter() as MockChildProcess;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let written = '';

  stdin.on('data', (chunk) => {
    written += chunk.toString();
  });

  proc.stdin = stdin;
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.killed = false;
  proc.written = () => written;
  proc.kill = jest.fn((signal?: NodeJS.Signals) => {
    proc.killed = true;
    setImmediate(() => {
      proc.emit('close', null, signal ?? 'SIGTERM');
    });
    return true;
  });

  return proc;
}

async function collectChunks(gen: AsyncGenerator<any>): Promise<any[]> {
  const chunks: any[] = [];
  for await (const chunk of gen) {
    chunks.push(chunk);
  }
  return chunks;
}

describe('CodexSessionService', () => {
  const spawnMock = spawn as jest.MockedFunction<typeof spawn>;
  const detectCodexCliCapabilitiesMock = detectCodexCliCapabilities as jest.MockedFunction<typeof detectCodexCliCapabilities>;
  let mockPlugin: Partial<ClaudianPlugin>;
  let mockMcpManager: MockMcpServerManager;
  let service: CodexSessionService;

  beforeEach(() => {
    jest.clearAllMocks();
    detectCodexCliCapabilitiesMock.mockReturnValue({
      version: '0.114.0',
      approvalFlagScope: 'root',
    });
    mockPlugin = {
      app: {
        vault: { adapter: { basePath: '/mock/vault/path' } },
      },
      settings: {
        permissionMode: 'normal' as const,
        codexModel: '',
        codexReasoningEffort: '',
        codexPlanModeReasoningEffort: '',
      },
      getActiveEnvironmentVariables: jest.fn().mockReturnValue(''),
      getResolvedCodexCliPath: jest.fn().mockReturnValue('/usr/local/bin/codex'),
    } as unknown as ClaudianPlugin;

    mockMcpManager = {
      loadServers: jest.fn().mockResolvedValue(undefined),
    } as unknown as MockMcpServerManager;

    service = new CodexSessionService(mockPlugin as ClaudianPlugin, mockMcpManager);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('maps Codex JSONL events into stream chunks', async () => {
    const proc = createMockChildProcess();
    spawnMock.mockReturnValue(proc as unknown as ReturnType<typeof spawn>);

    const chunksPromise = collectChunks(service.query('Say hello'));
    await new Promise((resolve) => setImmediate(resolve));

    proc.stdout.write('{"type":"thread.started","thread_id":"thread-123"}\n');
    proc.stdout.write('{"type":"turn.started"}\n');
    proc.stdout.write('{"type":"item.completed","item":{"id":"reason-1","type":"reasoning","text":"Thinking..."}}\n');
    proc.stdout.write('{"type":"item.started","item":{"id":"cmd-1","type":"command_execution","command":"/bin/zsh -lc pwd","status":"in_progress"}}\n');
    proc.stdout.write('{"type":"item.completed","item":{"id":"cmd-1","type":"command_execution","command":"/bin/zsh -lc pwd","aggregated_output":"/mock/vault/path\\n","exit_code":0,"status":"completed"}}\n');
    proc.stdout.write('{"type":"item.completed","item":{"id":"msg-1","type":"agent_message","text":"hello"}}\n');
    proc.stdout.write('{"type":"turn.completed","usage":{"input_tokens":12,"cached_input_tokens":3,"output_tokens":4}}\n');
    proc.stdout.end();
    proc.stderr.end();
    proc.emit('close', 0, null);

    const chunks = await chunksPromise;

    expect(service.getSessionId()).toBe('thread-123');
    expect(chunks).toEqual([
      { type: 'thinking', content: 'Thinking...' },
      {
        type: 'tool_use',
        id: 'cmd-1',
        name: 'command_execution',
        input: { command: '/bin/zsh -lc pwd' },
      },
      {
        type: 'tool_result',
        id: 'cmd-1',
        content: '/mock/vault/path',
        isError: false,
      },
      { type: 'text', content: 'hello' },
      {
        type: 'usage',
        usage: {
          inputTokens: 12,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 3,
          contextWindow: 0,
          contextTokens: 0,
          percentage: 0,
        },
        sessionId: 'thread-123',
      },
      { type: 'done' },
    ]);

    expect(spawnMock).toHaveBeenCalledWith(
      '/usr/local/bin/codex',
      expect.arrayContaining(['exec', '--skip-git-repo-check', '--json', '-']),
      expect.objectContaining({ cwd: '/mock/vault/path' })
    );
    expect(proc.written()).toBe('Say hello');
  });

  it('surfaces structured turn failures without a duplicate exit-code error', async () => {
    const proc = createMockChildProcess();
    spawnMock.mockReturnValue(proc as unknown as ReturnType<typeof spawn>);

    const chunksPromise = collectChunks(service.query('Trigger a failure'));
    await new Promise((resolve) => setImmediate(resolve));

    proc.stdout.write('{"type":"thread.started","thread_id":"thread-failed"}\n');
    proc.stdout.write('{"type":"turn.failed","error":{"message":"Usage limit reached"}}\n');
    proc.stdout.end();
    proc.stderr.end();
    proc.emit('close', 1, null);

    await expect(chunksPromise).resolves.toEqual([
      { type: 'error', content: 'Usage limit reached' },
    ]);
  });

  it('places root approval args before exec for current Codex CLI builds', async () => {
    const proc = createMockChildProcess();
    spawnMock.mockReturnValue(proc as unknown as ReturnType<typeof spawn>);

    const chunksPromise = collectChunks(service.query('Check ordering'));
    await new Promise((resolve) => setImmediate(resolve));

    proc.stdout.write('{"type":"thread.started","thread_id":"thread-order-root"}\n');
    proc.stdout.end();
    proc.stderr.end();
    proc.emit('close', 0, null);

    await chunksPromise;

    const args = spawnMock.mock.calls[0]?.[1] ?? [];
    expect(args.indexOf('-a')).toBeGreaterThanOrEqual(0);
    expect(args.indexOf('exec')).toBeGreaterThan(args.indexOf('-a'));
    expect(args[args.indexOf('-a') + 1]).toBe('never');
  });

  it('falls back to exec-scoped approval args when CLI reports that layout', async () => {
    detectCodexCliCapabilitiesMock.mockReturnValue({
      version: 'future',
      approvalFlagScope: 'exec',
    });

    const proc = createMockChildProcess();
    spawnMock.mockReturnValue(proc as unknown as ReturnType<typeof spawn>);

    const chunksPromise = collectChunks(service.query('Check future ordering'));
    await new Promise((resolve) => setImmediate(resolve));

    proc.stdout.write('{"type":"thread.started","thread_id":"thread-order-exec"}\n');
    proc.stdout.end();
    proc.stderr.end();
    proc.emit('close', 0, null);

    await chunksPromise;

    const args = spawnMock.mock.calls[0]?.[1] ?? [];
    expect(args.indexOf('exec')).toBeGreaterThanOrEqual(0);
    expect(args.indexOf('-a')).toBeGreaterThan(args.indexOf('exec'));
  });

  it('retries with rebuilt history when resume starts a different thread', async () => {
    const firstProc = createMockChildProcess();
    const secondProc = createMockChildProcess();
    spawnMock
      .mockReturnValueOnce(firstProc as unknown as ReturnType<typeof spawn>)
      .mockReturnValueOnce(secondProc as unknown as ReturnType<typeof spawn>);

    service.setSessionId('session-old');

    const history = [
      { id: 'u1', role: 'user' as const, content: 'Original question', timestamp: 1 },
      { id: 'a1', role: 'assistant' as const, content: 'Original answer', timestamp: 2 },
    ];

    const chunksPromise = collectChunks(service.query('Follow up', undefined, history));
    await new Promise((resolve) => setImmediate(resolve));

    firstProc.stdout.write('{"type":"thread.started","thread_id":"session-new"}\n');

    await new Promise((resolve) => setImmediate(resolve));

    secondProc.stdout.write('{"type":"thread.started","thread_id":"session-rebuilt"}\n');
    secondProc.stdout.write('{"type":"item.completed","item":{"id":"msg-2","type":"agent_message","text":"continued"}}\n');
    secondProc.stdout.write('{"type":"turn.completed","usage":{"input_tokens":5,"cached_input_tokens":1,"output_tokens":2}}\n');
    secondProc.stdout.end();
    secondProc.stderr.end();
    secondProc.emit('close', 0, null);

    const chunks = await chunksPromise;

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[0][1]).toContain('resume');
    expect(spawnMock.mock.calls[1][1]).not.toContain('resume');
    expect(secondProc.written()).toContain('User: Original question');
    expect(secondProc.written()).toContain('Assistant: Original answer');
    expect(secondProc.written()).toContain('User: Follow up');
    expect(service.getSessionId()).toBe('session-rebuilt');
    expect(chunks).toEqual([
      { type: 'text', content: 'continued' },
      {
        type: 'usage',
        usage: {
          inputTokens: 5,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 1,
          contextWindow: 0,
          contextTokens: 0,
          percentage: 0,
        },
        sessionId: 'session-rebuilt',
      },
      { type: 'done' },
    ]);
  });

  it('maps todo_list events into TodoWrite chunks', async () => {
    const proc = createMockChildProcess();
    spawnMock.mockReturnValue(proc as unknown as ReturnType<typeof spawn>);

    const chunksPromise = collectChunks(service.query('Create a plan'));
    await new Promise((resolve) => setImmediate(resolve));

    proc.stdout.write('{"type":"thread.started","thread_id":"thread-todos"}\n');
    proc.stdout.write('{"type":"item.started","item":{"id":"todo-1","type":"todo_list","items":[{"text":"Identify source and target names","completed":false},{"text":"Rename file and verify references","completed":false}]}}\n');
    proc.stdout.write('{"type":"item.completed","item":{"id":"todo-1","type":"todo_list","items":[{"text":"Identify source and target names","completed":true},{"text":"Rename file and verify references","completed":false}]}}\n');
    proc.stdout.end();
    proc.stderr.end();
    proc.emit('close', 0, null);

    const chunks = await chunksPromise;

    expect(chunks).toEqual([
      {
        type: 'tool_use',
        id: 'todo-1',
        name: 'TodoWrite',
        input: {
          todos: [
            { content: 'Identify source and target names', activeForm: 'Identify source and target names', status: 'in_progress' },
            { content: 'Rename file and verify references', activeForm: 'Rename file and verify references', status: 'pending' },
          ],
        },
      },
      {
        type: 'tool_use',
        id: 'todo-1',
        name: 'TodoWrite',
        input: {
          todos: [
            { content: 'Identify source and target names', activeForm: 'Identify source and target names', status: 'completed' },
            { content: 'Rename file and verify references', activeForm: 'Rename file and verify references', status: 'pending' },
          ],
        },
      },
      {
        type: 'tool_result',
        id: 'todo-1',
        content: 'Tasks updated (1/2).',
      },
      { type: 'done' },
    ]);
  });

  it('returns Codex slash commands plus user-invocable local commands', async () => {
    (mockPlugin.settings as any).slashCommands = [
      {
        id: 'cmd-review',
        name: 'review',
        description: 'Review code with a checklist',
        content: 'Review this code:\n$ARGUMENTS',
      },
      {
        id: 'skill-hidden',
        name: 'hidden-skill',
        description: 'Should stay hidden',
        content: 'Do not expose',
        userInvocable: false,
      },
    ];

    const commands = await service.getSupportedCommands();

    expect(commands.map((command) => command.name)).toEqual(expect.arrayContaining([
      'help',
      'plan',
      'compact',
      'review',
    ]));
    expect(commands.map((command) => command.name)).not.toContain('hidden-skill');
    expect(commands.find((command) => command.name === 'review')).toMatchObject({
      description: 'Review code with a checklist',
      content: 'Review this code:\n$ARGUMENTS',
    });
  });

  it('passes reasoning effort settings and uses /plan prompt prefix in plan mode', async () => {
    (mockPlugin.settings as any).permissionMode = 'plan';
    (mockPlugin.settings as any).codexPerformanceMode = 'deep';

    const proc = createMockChildProcess();
    spawnMock.mockReturnValue(proc as unknown as ReturnType<typeof spawn>);

    const chunksPromise = collectChunks(service.query('Create a migration plan'));
    await new Promise((resolve) => setImmediate(resolve));

    proc.stdout.write('{"type":"thread.started","thread_id":"thread-plan"}\n');
    proc.stdout.end();
    proc.stderr.end();
    proc.emit('close', 0, null);

    const chunks = await chunksPromise;

    expect(chunks).toEqual([{ type: 'done' }]);
    expect(proc.written()).toBe('/plan\n\nCreate a migration plan');
    expect(spawnMock).toHaveBeenCalledWith(
      '/usr/local/bin/codex',
      expect.arrayContaining([
        '--model',
        'gpt-5.6-sol',
        '-c',
        'model_reasoning_effort="high"',
        '-c',
        'plan_mode_reasoning_effort="high"',
      ]),
      expect.any(Object),
    );
  });

  it('prefers query option model over the configured Codex model', async () => {
    (mockPlugin.settings as any).codexPerformanceMode = 'fast';

    const proc = createMockChildProcess();
    spawnMock.mockReturnValue(proc as unknown as ReturnType<typeof spawn>);

    const chunksPromise = collectChunks(service.query('Use the override', undefined, undefined, {
      model: 'o4-mini',
    }));
    await new Promise((resolve) => setImmediate(resolve));

    proc.stdout.write('{"type":"thread.started","thread_id":"thread-model"}\n');
    proc.stdout.end();
    proc.stderr.end();
    proc.emit('close', 0, null);

    await chunksPromise;

    const spawnArgs = spawnMock.mock.calls[0]?.[1] ?? [];
    const modelFlagIndex = spawnArgs.indexOf('--model');

    expect(modelFlagIndex).toBeGreaterThanOrEqual(0);
    expect(spawnArgs[modelFlagIndex + 1]).toBe('o4-mini');
    expect(spawnArgs.filter((arg) => arg === '--model')).toHaveLength(1);
  });

  it('uses Terra with medium reasoning in fast mode', async () => {
    (mockPlugin.settings as any).codexPerformanceMode = 'fast';

    const proc = createMockChildProcess();
    spawnMock.mockReturnValue(proc as unknown as ReturnType<typeof spawn>);

    const chunksPromise = collectChunks(service.query('Quick vault question'));
    await new Promise((resolve) => setImmediate(resolve));

    proc.stdout.write('{"type":"thread.started","thread_id":"thread-fast"}\n');
    proc.stdout.end();
    proc.stderr.end();
    proc.emit('close', 0, null);

    await chunksPromise;

    expect(spawnMock).toHaveBeenCalledWith(
      '/usr/local/bin/codex',
      expect.arrayContaining([
        '--model',
        'gpt-5.6-terra',
        '-c',
        'model_reasoning_effort="medium"',
      ]),
      expect.any(Object),
    );
  });
});

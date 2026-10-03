import {
  classifyWeChatIntent,
  extractWeChatAction,
  extractWeChatCaptureDecision,
  formatPendingActionReplies,
  parseWeChatCollaborationCommand,
  WeChatActionExecutor,
  WeChatCollaborationService,
  type WeChatPendingAction,
} from '../../../../src/core/wechat/WeChatCollaborationService';
import type SecondBrainPlugin from '../../../../src/main';

function createHarness(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const folders = new Set<string>();
  const adapter = {
    exists: jest.fn(async (path: string) => files.has(path) || folders.has(path)),
    read: jest.fn(async (path: string) => {
      if (!files.has(path)) throw new Error(`missing: ${path}`);
      return files.get(path)!;
    }),
    write: jest.fn(async (path: string, content: string) => { files.set(path, content); }),
    mkdir: jest.fn(async (path: string) => { folders.add(path); }),
    remove: jest.fn(async (path: string) => { files.delete(path); folders.delete(path); }),
  };
  const plugin = { app: { vault: { adapter } } } as unknown as SecondBrainPlugin;
  return { adapter, executor: new WeChatActionExecutor(plugin), files, folders };
}

describe('WeChat collaboration routing', () => {
  it('sends every ordinary natural-language message to the agent', () => {
    expect(classifyWeChatIntent('今天看完了接触器课程').kind).toBe('chat');
    expect(classifyWeChatIntent('我下一步应该学什么？').kind).toBe('chat');
    expect(classifyWeChatIntent('帮我总结今天的学习').kind).toBe('chat');
    expect(classifyWeChatIntent('我今天学完了接触器，帮我总结掌握情况').kind).toBe('chat');
    expect(classifyWeChatIntent('把这条结论加入项目笔记').kind).toBe('chat');
    expect(classifyWeChatIntent('在学习课程记录中新建一个文件夹叫变频器').kind).toBe('chat');
    expect(classifyWeChatIntent('我今天有什么事情要做').kind).toBe('chat');
  });

  it('supports explicit chat and capture prefixes', () => {
    expect(classifyWeChatIntent('对话：这是陈述但请回答')).toEqual({
      kind: 'chat', text: '这是陈述但请回答', forced: true,
    });
    expect(classifyWeChatIntent('记录：这是一个想法')).toEqual({
      kind: 'capture', text: '这是一个想法', forced: true,
    });
  });

  it('parses natural confirmation while retaining QR compatibility', () => {
    expect(parseWeChatCollaborationCommand('深度通道')).toEqual({ kind: 'mode', mode: 'deep' });
    expect(parseWeChatCollaborationCommand('确认执行 QR-A12B34')).toEqual({ kind: 'confirm-action', id: 'QR-A12B34' });
    expect(parseWeChatCollaborationCommand('确认')).toEqual({ kind: 'confirm-action' });
    expect(parseWeChatCollaborationCommand('取消')).toEqual({ kind: 'cancel-action' });
  });

  it('routes daily-note wording to the deterministic shared command', () => {
    for (const input of ['打开今天的日志', '创建今天的日记', '打开或创建今日日记', '/today']) {
      expect(parseWeChatCollaborationCommand(input)).toEqual({ kind: 'today' });
    }
  });

  it('routes natural butler-brief wording locally without capturing news briefs', () => {
    for (const input of [
      '管家简报',
      '今天的管家简报',
      '给我发一份管家简报',
      '麻烦给我发送一下今日的管家简报',
      '像之前一样的管家简报',
      '今日简报',
    ]) {
      expect(parseWeChatCollaborationCommand(input)).toEqual({ kind: 'butler-brief' });
    }
    expect(parseWeChatCollaborationCommand('新闻简报')).toBeNull();
    expect(parseWeChatCollaborationCommand('科技新闻简报')).toBeNull();
  });

  it('asks for a plain confirmation and keeps the QR id only for audit', () => {
    const replies = formatPendingActionReplies({
      kind: 'files',
      id: 'QR-A12B34',
      title: '更新日志',
      summary: '追加一条记录',
      request: '更新',
      createdAt: '2026-08-09T08:00:00.000Z',
      expiresAt: '2026-08-09T08:30:00.000Z',
      changes: [{ operation: 'append', path: '020_行动系统/a.md', content: 'x' }],
      baselines: [{ path: '020_行动系统/a.md', exists: true, sha256: 'hash' }],
    });
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain('待确认操作 QR-A12B34');
    expect(replies[0]).toContain('执行请回复：确认');
    expect(replies[0]).toContain('放弃请回复：取消');
  });
});

describe('WeChat action proposal parsing', () => {
  it('extracts and hides the agent capture decision marker', () => {
    expect(extractWeChatCaptureDecision('这是一条自然回应。\n<wechat_capture/>')).toEqual({
      cleanedText: '这是一条自然回应。',
      shouldCapture: true,
    });
    expect(extractWeChatCaptureDecision('普通问答')).toEqual({
      cleanedText: '普通问答',
      shouldCapture: false,
    });
  });

  it('extracts one validated action and hides the machine marker', () => {
    const result = extractWeChatAction(`建议追加一条记录。\n<wechat_action>{"title":"更新项目","summary":"追加验收结果","changes":[{"operation":"append","path":"020_行动系统/项目.md","content":"- 已完成验收"}]}</wechat_action>`);
    expect(result.reply).toBe('建议追加一条记录。');
    expect(result.proposal?.changes).toEqual([
      { operation: 'append', path: '020_行动系统/项目.md', content: '- 已完成验收' },
    ]);
  });

  it('rejects traversal, hidden paths and raw inbox writes', () => {
    for (const path of ['../越界.md', '.obsidian/data.md', '010_收件箱/原始输入_raw/a.md']) {
      const result = extractWeChatAction(`<wechat_action>${JSON.stringify({
        title: '危险修改',
        summary: '不应通过',
        changes: [{ operation: 'append', path, content: 'x' }],
      })}</wechat_action>`);
      expect(result.proposal).toBeNull();
      expect(result.error).toContain('修改提案格式无效');
    }
  });

  it('rejects mkdir operations targeting hidden or raw-input paths', () => {
    for (const path of ['.second-brain/cache', '010_收件箱/原始输入_raw']) {
      const result = extractWeChatAction(`<wechat_action>${JSON.stringify({
        title: '危险目录',
        summary: '不应通过',
        changes: [{ operation: 'mkdir', path }],
      })}</wechat_action>`);
      expect(result.proposal).toBeNull();
      expect(result.error).toContain('修改提案格式无效');
    }
  });
});

describe('WeChat conversation synchronization', () => {
  const now = new Date('2026-08-09T13:34:15.000Z');

  it('normalizes verified note references in the model reply without a second model call', async () => {
    const conversation = { id: 'wechat-conversation', title: '微信会话', messages: [], sessionId: null };
    const file = { path: '资料/使用指南.md', name: '使用指南.md', basename: '使用指南', extension: 'md' };
    const plugin = {
      app: { vault: {
        adapter: { basePath: 'F:/Example Vault' },
        getFiles: () => [file], getFileByPath: (path: string) => path === file.path ? file : null,
      } },
      settings: { wechatDefaultPerformanceMode: 'fast', slashCommands: [] },
      llmWikiService: { buildContext: jest.fn(async () => '') },
      mcpManager: {},
      getConversationById: jest.fn(async () => conversation),
      ensureWeChatConversationTab: jest.fn(async () => undefined),
      updateConversation: jest.fn(async () => undefined),
    } as unknown as SecondBrainPlugin;
    const service = new WeChatCollaborationService(plugin, {
      loadConversationPreferences: jest.fn(async () => ({ mode: 'fast', conversationId: conversation.id })),
    } as any);
    const query = jest.fn(async function* () { yield { type: 'text', content: '请读 使用指南。' }; });
    (service as any).agent = { setSessionId: jest.fn(), getSessionId: () => 'session', query, cancel: jest.fn() };
    const result = await service.runChat('查找使用指南', [], now);
    expect(result.replies).toEqual(['请读 [[资料/使用指南|使用指南]]。']);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('uses one agent pass, hides the capture marker and excludes the current inbound exchange from history', async () => {
    const conversation = {
      id: 'wechat-conversation',
      title: '微信会话',
      messages: [
        { id: 'old-user', role: 'user', content: '昨天的问题', timestamp: now.getTime() - 2_000 },
        { id: 'old-assistant', role: 'assistant', content: '昨天的回答', timestamp: now.getTime() - 1_000 },
        { id: 'current-user', role: 'user', content: '今天学完了接触器课程', timestamp: now.getTime() },
        { id: 'progress', role: 'assistant', content: '正在使用快速通道处理。', timestamp: now.getTime() + 1 },
      ],
      sessionId: null,
    };
    const plugin = {
      settings: {
        wechatDefaultPerformanceMode: 'fast',
        slashCommands: [],
        wechatAdditionalInstructions: '微信端附加规则',
      },
      llmWikiService: { buildContext: jest.fn(async () => '') },
      mcpManager: {},
      getConversationById: jest.fn(async () => conversation),
      ensureWeChatConversationTab: jest.fn(async () => undefined),
      updateConversation: jest.fn(async () => undefined),
    } as unknown as SecondBrainPlugin;
    const stateStore = {
      loadConversationPreferences: jest.fn(async () => ({ mode: 'fast', conversationId: conversation.id })),
    };
    const query = jest.fn(async function* () {
      yield { type: 'text', content: '这项进度值得保留。\n<wechat_capture/>' };
    });
    const service = new WeChatCollaborationService(plugin, stateStore as any);
    (service as any).agent = {
      setSessionId: jest.fn(),
      getSessionId: jest.fn(() => 'codex-session'),
      query,
      cancel: jest.fn(),
      cleanup: jest.fn(),
    };

    const result = await service.runChat('今天学完了接触器课程', [], now, {
      excludeLatestInboundFromHistory: true,
    });

    expect(result.captureRequested).toBe(true);
    expect(result.replies).toEqual(['这项进度值得保留。']);
    const queryCall = query.mock.calls[0] as unknown[];
    expect(queryCall[2]).toEqual(conversation.messages.slice(0, 2));
    expect(queryCall[3]).toEqual(expect.objectContaining({
      sandboxMode: 'read-only',
      additionalDeveloperInstructions: '微信端附加规则',
    }));
  });

  it('records inbound and assistant messages separately and refreshes the fixed conversation', async () => {
    const conversation = { id: 'wechat-conversation', title: '微信会话', messages: [], sessionId: null };
    const plugin = {
      settings: { wechatDefaultPerformanceMode: 'fast' },
      getConversationById: jest.fn(async () => conversation),
      ensureWeChatConversationTab: jest.fn(async () => undefined),
      updateConversation: jest.fn(async (_id: string, updates: any) => {
        Object.assign(conversation, updates);
      }),
      syncConversationViews: jest.fn(async () => undefined),
    } as unknown as SecondBrainPlugin;
    const stateStore = {
      loadConversationPreferences: jest.fn(async () => ({ mode: 'fast', conversationId: conversation.id })),
    };
    const service = new WeChatCollaborationService(plugin, stateStore as any);

    await service.recordInbound('我今天有什么事情要做', now);
    await service.recordAssistant('今天有三项优先事项。', now);

    expect(conversation.messages).toEqual([
      expect.objectContaining({ role: 'user', content: '我今天有什么事情要做' }),
      expect.objectContaining({ role: 'assistant', content: '今天有三项优先事项。' }),
    ]);
    expect(plugin.syncConversationViews).toHaveBeenCalledTimes(2);
  });

  it('confirms the newest pending action without requiring the QR text', async () => {
    const pending: WeChatPendingAction = {
      kind: 'custom-instructions',
      id: 'QR-A12B34',
      title: '更新插件自定义指令',
      summary: '追加一条规则',
      request: '更新规则',
      createdAt: now.toISOString(),
      expiresAt: '2099-08-09T13:35:15.000Z',
      operation: 'replace',
      content: '新规则',
      previousContent: '',
      baselineSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    };
    const plugin = {
      settings: { systemPrompt: '', wechatDefaultPerformanceMode: 'fast' },
      saveSettings: jest.fn(async () => undefined),
      getAllViews: jest.fn(() => []),
    } as unknown as SecondBrainPlugin;
    const stateStore = {
      loadPendingAction: jest.fn(async () => pending),
      clearPendingAction: jest.fn(async () => undefined),
    };
    const service = new WeChatCollaborationService(plugin, stateStore as any);

    await expect(service.confirmPendingAction(undefined, now)).resolves.toContain('已完成 QR-A12B34');
    expect(plugin.settings.systemPrompt).toBe('新规则');
    expect(stateStore.clearPendingAction).toHaveBeenCalledTimes(1);
  });
});

describe('WeChatActionExecutor', () => {
  const now = new Date('2026-08-09T12:00:00.000Z');

  it('snapshots and applies create, append and unique replacement', async () => {
    const { executor, files } = createHarness({
      '020_行动系统/项目.md': '标题\n旧内容\n',
      '300_个人内燃机/日志.md': '开始\n',
    });
    const pending = await executor.prepare({
      title: '受控修改',
      summary: '三种操作',
      changes: [
        { operation: 'replace', path: '020_行动系统/项目.md', oldText: '旧内容', newText: '新内容' },
        { operation: 'append', path: '300_个人内燃机/日志.md', content: '继续' },
        { operation: 'create', path: '500_永久笔记与知识资产/新笔记.md', content: '# 新笔记\n' },
      ],
    }, '执行测试', now);

    const result = await executor.apply(pending, new Date(now.getTime() + 1_000));
    expect(files.get('020_行动系统/项目.md')).toContain('新内容');
    expect(files.get('300_个人内燃机/日志.md')).toBe('开始\n继续');
    expect(files.get('500_永久笔记与知识资产/新笔记.md')).toBe('# 新笔记\n');
    expect(files.has(`${result.snapshotPath}/manifest.json`)).toBe(true);
    expect([...files.keys()].filter((path) => path.startsWith(result.snapshotPath) && path.includes('before-'))).toHaveLength(2);
  });

  it('creates one confirmed folder under an existing parent', async () => {
    const { executor, folders } = createHarness();
    folders.add('100_领域与职责/学习课程记录');
    const pending = await executor.prepare({
      title: '新建文件夹',
      summary: '新增变频器课程目录',
      changes: [{
        operation: 'mkdir',
        path: '100_领域与职责/学习课程记录/变频器',
      }],
    }, '在学习课程记录中新建一个文件夹叫变频器', now);

    const result = await executor.apply(pending, new Date(now.getTime() + 1_000));

    expect(folders.has('100_领域与职责/学习课程记录/变频器')).toBe(true);
    expect(result.changedPaths).toEqual(['100_领域与职责/学习课程记录/变频器']);
  });

  it('rejects folder creation when the parent is missing', async () => {
    const { executor, folders } = createHarness();
    await expect(executor.prepare({
      title: '新建文件夹',
      summary: '不应创建',
      changes: [{ operation: 'mkdir', path: '不存在的父目录/变频器' }],
    }, '新建文件夹', now)).rejects.toThrow('父文件夹不存在');
    expect(folders.has('不存在的父目录/变频器')).toBe(false);
  });

  it('stops when a target changed after proposal preparation', async () => {
    const { executor, files } = createHarness({ '020_行动系统/项目.md': '原文' });
    const pending = await executor.prepare({
      title: '追加', summary: '测试',
      changes: [{ operation: 'append', path: '020_行动系统/项目.md', content: '新增' }],
    }, '测试', now);
    files.set('020_行动系统/项目.md', '用户后来修改');

    await expect(executor.apply(pending, new Date(now.getTime() + 1_000)))
      .rejects.toThrow('确认前已发生变化');
    expect(files.get('020_行动系统/项目.md')).toBe('用户后来修改');
  });

  it('rejects expired actions before writing a snapshot', async () => {
    const { executor, files } = createHarness({ '020_行动系统/项目.md': '原文' });
    const pending = await executor.prepare({
      title: '追加', summary: '测试',
      changes: [{ operation: 'append', path: '020_行动系统/项目.md', content: '新增' }],
    }, '测试', now);
    const expired: WeChatPendingAction = { ...pending, expiresAt: new Date(now.getTime() - 1).toISOString() };

    await expect(executor.apply(expired, now)).rejects.toThrow('已经过期');
    expect([...files.keys()].some((path) => path.startsWith('.second-brain/snapshots/'))).toBe(false);
  });

  it('rolls back earlier files when a later write fails', async () => {
    const { adapter, executor, files } = createHarness({
      '020_行动系统/a.md': 'A',
      '020_行动系统/b.md': 'B',
    });
    const pending = await executor.prepare({
      title: '两处追加', summary: '测试失败回滚',
      changes: [
        { operation: 'append', path: '020_行动系统/a.md', content: '1' },
        { operation: 'append', path: '020_行动系统/b.md', content: '2' },
      ],
    }, '测试', now);
    adapter.write.mockImplementation(async (path: string, content: string) => {
      if (path === '020_行动系统/b.md') throw new Error('disk full');
      files.set(path, content);
    });

    await expect(executor.apply(pending, new Date(now.getTime() + 1_000))).rejects.toThrow('disk full');
    expect(files.get('020_行动系统/a.md')).toBe('A');
    expect(files.get('020_行动系统/b.md')).toBe('B');
  });
});

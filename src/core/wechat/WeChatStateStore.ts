import { spawn } from 'child_process';

import { mutatePluginData } from '../storage/PluginDataMutation';
import type { WeChatCredential } from './types';
import type {
  WeChatConversationPreferences,
  WeChatPendingAction,
} from './WeChatCollaborationService';
import type { WeChatDigestDraft } from './WeChatDigestCommands';

export interface SecretProtector {
  protect(value: string): Promise<string>;
  unprotect(value: string): Promise<string>;
}

interface DataHost {
  loadData(): Promise<Record<string, unknown> | null>;
  saveData(data: Record<string, unknown>): Promise<void>;
}

interface PersistedCredential extends Omit<WeChatCredential, 'token'> {
  encryptedToken: string;
}

export interface WeChatOutboundContext {
  userId: string;
  contextToken: string;
  updatedAt: string;
}

interface PersistedOutboundContext extends Omit<WeChatOutboundContext, 'contextToken'> {
  encryptedContextToken: string;
}

export interface WeChatButlerDeliveryState {
  pendingDate?: string;
  lastSentDate?: string;
  lastAttemptAt?: string;
  lastError?: string;
  lastBriefActionIds?: string[];
}

interface PersistedWeChatState {
  credential?: PersistedCredential;
  cursor?: string;
  processedMessageIds?: string[];
  digestDraft?: WeChatDigestDraft;
  conversation?: WeChatConversationPreferences;
  pendingAction?: WeChatPendingAction;
  outboundContext?: PersistedOutboundContext;
  butlerDelivery?: WeChatButlerDeliveryState;
}

interface PluginData extends Record<string, unknown> {
  wechat?: PersistedWeChatState;
}

const PROTECT_SCRIPT = [
  '$ErrorActionPreference="Stop";',
  'Add-Type -AssemblyName System.Security;',
  '$value=[Console]::In.ReadToEnd();',
  '$bytes=[Text.Encoding]::UTF8.GetBytes($value);',
  '$result=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);',
  '[Console]::Out.Write([Convert]::ToBase64String($result));',
].join('');

const UNPROTECT_SCRIPT = [
  '$ErrorActionPreference="Stop";',
  'Add-Type -AssemblyName System.Security;',
  '$value=[Console]::In.ReadToEnd();',
  '$bytes=[Convert]::FromBase64String($value);',
  '$result=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);',
  '[Console]::Out.Write([Text.Encoding]::UTF8.GetString($result));',
].join('');

function runPowerShell(script: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`Windows 凭据加密失败：${stderr.trim() || code}`));
    });
    child.stdin.end(input);
  });
}

export class WindowsDpapiProtector implements SecretProtector {
  async protect(value: string): Promise<string> {
    if (process.platform !== 'win32') throw new Error('当前版本仅支持在 Windows 上安全保存微信凭据。');
    return runPowerShell(PROTECT_SCRIPT, value);
  }

  async unprotect(value: string): Promise<string> {
    if (process.platform !== 'win32') throw new Error('当前版本仅支持在 Windows 上读取微信凭据。');
    return runPowerShell(UNPROTECT_SCRIPT, value);
  }
}

export class WeChatStateStore {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private host: DataHost,
    private protector: SecretProtector = new WindowsDpapiProtector(),
    private maxProcessedIds = 500,
  ) {}

  async saveCredential(credential: WeChatCredential): Promise<void> {
    const encryptedToken = await this.protector.protect(credential.token);
    await this.mutate((state) => {
      state.credential = {
        accountId: credential.accountId,
        baseUrl: credential.baseUrl,
        userId: credential.userId,
        connectedAt: credential.connectedAt,
        encryptedToken,
      };
      state.cursor = '';
      state.processedMessageIds = [];
    });
  }

  async loadCredential(): Promise<WeChatCredential | null> {
    await this.writeQueue;
    const state = await this.loadState();
    if (!state.credential) return null;
    const token = await this.protector.unprotect(state.credential.encryptedToken);
    return { ...state.credential, token };
  }

  async hasCredential(): Promise<boolean> {
    await this.writeQueue;
    return Boolean((await this.loadState()).credential);
  }

  async loadCursor(): Promise<string> {
    await this.writeQueue;
    return (await this.loadState()).cursor ?? '';
  }

  async saveCursor(cursor: string): Promise<void> {
    await this.mutate((state) => { state.cursor = cursor; });
  }

  async hasProcessed(messageId: string): Promise<boolean> {
    await this.writeQueue;
    return ((await this.loadState()).processedMessageIds ?? []).includes(messageId);
  }

  async markProcessed(messageId: string): Promise<void> {
    await this.mutate((state) => {
      const next = [...(state.processedMessageIds ?? []).filter((id) => id !== messageId), messageId];
      state.processedMessageIds = next.slice(-this.maxProcessedIds);
    });
  }

  async loadDigestDraft(): Promise<WeChatDigestDraft | null> {
    await this.writeQueue;
    return (await this.loadState()).digestDraft ?? null;
  }

  async saveDigestDraft(draft: WeChatDigestDraft): Promise<void> {
    await this.mutate((state) => { state.digestDraft = draft; });
  }

  async clearDigestDraft(): Promise<void> {
    await this.mutate((state) => { delete state.digestDraft; });
  }

  async loadConversationPreferences(): Promise<WeChatConversationPreferences | null> {
    await this.writeQueue;
    return (await this.loadState()).conversation ?? null;
  }

  async saveConversationPreferences(preferences: WeChatConversationPreferences): Promise<void> {
    await this.mutate((state) => { state.conversation = preferences; });
  }

  async loadPendingAction(): Promise<WeChatPendingAction | null> {
    await this.writeQueue;
    return (await this.loadState()).pendingAction ?? null;
  }

  async savePendingAction(action: WeChatPendingAction): Promise<void> {
    await this.mutate((state) => { state.pendingAction = action; });
  }

  async clearPendingAction(): Promise<void> {
    await this.mutate((state) => { delete state.pendingAction; });
  }

  async saveOutboundContext(context: WeChatOutboundContext): Promise<void> {
    const encryptedContextToken = await this.protector.protect(context.contextToken);
    await this.mutate((state) => {
      state.outboundContext = {
        userId: context.userId,
        updatedAt: context.updatedAt,
        encryptedContextToken,
      };
    });
  }

  async loadOutboundContext(): Promise<WeChatOutboundContext | null> {
    await this.writeQueue;
    const state = await this.loadState();
    if (!state.outboundContext) return null;
    const contextToken = await this.protector.unprotect(state.outboundContext.encryptedContextToken);
    return {
      userId: state.outboundContext.userId,
      updatedAt: state.outboundContext.updatedAt,
      contextToken,
    };
  }

  async loadButlerDelivery(): Promise<WeChatButlerDeliveryState> {
    await this.writeQueue;
    return { ...((await this.loadState()).butlerDelivery ?? {}) };
  }

  async saveButlerDelivery(delivery: WeChatButlerDeliveryState): Promise<void> {
    await this.mutate((state) => { state.butlerDelivery = { ...delivery }; });
  }

  async clear(): Promise<void> {
    await this.mutate((state) => {
      delete state.credential;
      delete state.cursor;
      delete state.processedMessageIds;
      delete state.digestDraft;
      delete state.conversation;
      delete state.pendingAction;
      delete state.outboundContext;
      delete state.butlerDelivery;
    });
  }

  private async loadState(): Promise<PersistedWeChatState> {
    const data = await this.host.loadData() as PluginData | null;
    return data?.wechat ?? {};
  }

  private async mutate(mutator: (state: PersistedWeChatState) => void): Promise<void> {
    const operation = mutatePluginData(this.host, (raw) => {
      const data = raw as PluginData;
      const state: PersistedWeChatState = { ...(data.wechat ?? {}) };
      mutator(state);
      data.wechat = state;
    });
    this.writeQueue = operation.catch(() => undefined);
    return operation;
  }
}

import { createHash } from 'crypto';

import type SecondBrainPlugin from '../../main';
import type { WorkbenchAction, WorkbenchActionPriority } from '../knowledge/ActionWorkbenchService';
import { InboxCaptureService } from '../knowledge/InboxCaptureService';
import { InboxDigestService, type RoutingProposal } from '../knowledge/InboxDigestService';
import { IlinkApiError, IlinkClient } from './IlinkClient';
import { IlinkLoginSession } from './IlinkLoginSession';
import {
  ILINK_API_BASE_URL,
  type IlinkMessage,
  type IlinkMessageItem,
  type IlinkQrStatusResponse,
  MessageItemType,
  type WeChatChannelState,
  type WeChatCredential,
} from './types';
import {
  classifyWeChatIntent,
  parseWeChatCollaborationCommand,
  type WeChatCollaborationCommand,
  WeChatCollaborationService,
} from './WeChatCollaborationService';
import {
  formatDigestDraftMessages,
  formatDigestProposal,
  isDigestDraftExpired,
  parseRoutingCategory,
  parseWechatDigestCommand,
  type WeChatDigestCommand,
  type WeChatDigestDraft,
} from './WeChatDigestCommands';
import { WeChatMediaService } from './WeChatMediaService';
import { WeChatStateStore } from './WeChatStateStore';

export interface WeChatStatusSnapshot {
  state: WeChatChannelState;
  detail: string;
  lastInboundAt?: number;
  lastDeliveryLagMs?: number;
  lastProcessingMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function extractSharedCardText(item: IlinkMessageItem): string {
  const values: Record<'title' | 'url' | 'description', string[]> = {
    title: [],
    url: [],
    description: [],
  };
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number) => {
    if (!isRecord(value) || depth > 4 || seen.has(value)) return;
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === 'string') {
        const text = child.trim();
        if (!text || text.length > 4000) continue;
        if (key === 'title') values.title.push(text);
        if (key === 'url' && /^https?:\/\//i.test(text)) values.url.push(text);
        if (key === 'description' || key === 'desc' || key === 'des') values.description.push(text);
      } else if (isRecord(child) && !['media', 'thumb_media'].includes(key)) {
        visit(child, depth + 1);
      }
    }
  };
  visit(item, 0);
  const parts = [values.title[0], values.description[0], values.url[0]].filter(Boolean);
  return parts.length ? `[微信分享卡片]\n${parts.join('\n')}` : '';
}

function extractItemText(item: IlinkMessageItem, depth = 0): string {
  if (depth > 3) return '';
  let direct = '';
  if (item.type === MessageItemType.TEXT && item.text_item?.text?.trim()) {
    direct = item.text_item.text.trim();
  } else if (item.type === MessageItemType.VOICE && item.voice_item?.text?.trim()) {
    direct = `[语音转文字]\n${item.voice_item.text.trim()}`;
  } else {
    direct = extractSharedCardText(item);
  }

  const quoted: string[] = [];
  if (item.ref_msg?.title?.trim()) quoted.push(item.ref_msg.title.trim());
  if (item.ref_msg?.message_item) {
    const nested = extractItemText(item.ref_msg.message_item, depth + 1);
    if (nested) quoted.push(nested);
  }
  const reference = quoted.length ? `[引用]\n${[...new Set(quoted)].join('\n')}` : '';
  return [reference, direct].filter(Boolean).join('\n');
}

export function extractWechatText(message: IlinkMessage): string {
  const parts = (message.item_list ?? []).map((item) => extractItemText(item)).filter(Boolean);
  return parts.join('\n\n');
}

function collectWechatMediaItems(items: IlinkMessageItem[] = []): IlinkMessageItem[] {
  const result: IlinkMessageItem[] = [];
  for (const item of items) {
    if ([MessageItemType.IMAGE, MessageItemType.FILE, MessageItemType.VIDEO, MessageItemType.VOICE].includes(item.type as 2)) {
      result.push(item);
    }
    if (item.ref_msg?.message_item) result.push(...collectWechatMediaItems([item.ref_msg.message_item]));
  }
  return result;
}

export function getWechatMessageKey(message: IlinkMessage): string {
  if (message.message_id !== undefined) return String(message.message_id);
  if (message.client_id) return message.client_id;
  const payload = JSON.stringify({
    from: message.from_user_id,
    created: message.create_time_ms,
    items: message.item_list,
  });
  return createHash('sha256').update(payload).digest('hex').slice(0, 24);
}

export function splitWechatReply(text: string, maxLength = 1800): string[] {
  const normalized = text.trim();
  if (!normalized) return [];
  if (normalized.length <= maxLength) return [normalized];
  const chunks: string[] = [];
  let remaining = normalized;
  while (remaining.length > maxLength) {
    const window = remaining.slice(0, maxLength + 1);
    const preferred = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'));
    const cut = preferred >= Math.floor(maxLength * 0.55) ? preferred : maxLength;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks.filter(Boolean);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function captureCode(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `WX-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

function digestCode(now: Date): string {
  return captureCode(now).replace(/^WX-/, 'FL-');
}

function localDateKey(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function parseBriefTime(value: string): { hours: number; minutes: number } {
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/u);
  const hours = match ? Number(match[1]) : 8;
  const minutes = match ? Number(match[2]) : 0;
  return {
    hours: Number.isFinite(hours) ? Math.max(0, Math.min(23, hours)) : 8,
    minutes: Number.isFinite(minutes) ? Math.max(0, Math.min(59, minutes)) : 0,
  };
}

function resolveNaturalDate(text: string, now: Date): string {
  const explicit = text.match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})日?/u);
  const target = new Date(now);
  if (explicit) {
    target.setFullYear(Number(explicit[1]), Number(explicit[2]) - 1, Number(explicit[3]));
    return localDateKey(target);
  }
  const monthDay = text.match(/(\d{1,2})月(\d{1,2})日?/u);
  if (monthDay) {
    target.setMonth(Number(monthDay[1]) - 1, Number(monthDay[2]));
    if (target.getTime() < now.getTime() - 86_400_000) target.setFullYear(target.getFullYear() + 1);
    return localDateKey(target);
  }
  if (/后天/u.test(text)) target.setDate(target.getDate() + 2);
  else if (/明天/u.test(text)) target.setDate(target.getDate() + 1);
  else {
    const weekday = text.match(/(?:下周|周|星期)([一二三四五六日天])/u)?.[1];
    if (!weekday) return '';
    const number = '日一二三四五六'.indexOf(weekday === '天' ? '日' : weekday);
    let offset = (number - target.getDay() + 7) % 7;
    if (/下周/u.test(text) || offset === 0) offset += 7;
    target.setDate(target.getDate() + offset);
  }
  return localDateKey(target);
}

function parseOrdinal(value: string): number {
  if (/^\d+$/u.test(value)) return Number(value);
  const simple = '一二三四五六七八九';
  if (value === '十') return 10;
  const index = simple.indexOf(value);
  return index >= 0 ? index + 1 : 0;
}

const BRIEF_PRIORITY_ORDER: Record<WorkbenchActionPriority, number> = {
  high: 0,
  medium: 1,
  low: 2,
  none: 3,
};

function briefTitleKey(title: string): string {
  return title.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function uniqueBriefActions(actions: WorkbenchAction[]): WorkbenchAction[] {
  const seenIds = new Set<string>();
  const seenTitles = new Set<string>();
  return actions.filter((action) => {
    const titleKey = briefTitleKey(action.title);
    if (seenIds.has(action.id) || (titleKey && seenTitles.has(titleKey))) return false;
    seenIds.add(action.id);
    if (titleKey) seenTitles.add(titleKey);
    return true;
  });
}

function sortBriefActions(actions: WorkbenchAction[]): WorkbenchAction[] {
  return [...actions].sort((left, right) => (
    BRIEF_PRIORITY_ORDER[left.priority] - BRIEF_PRIORITY_ORDER[right.priority]
    || (left.dueDate || '9999-99-99').localeCompare(right.dueDate || '9999-99-99')
    || left.title.localeCompare(right.title, 'zh-CN')
  ));
}

export class WeChatChannelService {
  private client = new IlinkClient();
  private stateStore: WeChatStateStore;
  private inbox: InboxCaptureService;
  private media: WeChatMediaService;
  private collaboration: WeChatCollaborationService;
  private controller: AbortController | null = null;
  private monitorPromise: Promise<void> | null = null;
  private briefTimer: number | null = null;
  private briefCatchUpAttemptedDate = '';
  private briefInFlight: Promise<boolean> | null = null;
  private snapshot: WeChatStatusSnapshot = { state: '未连接', detail: '尚未绑定微信 Bot。' };

  constructor(private plugin: SecondBrainPlugin) {
    this.stateStore = new WeChatStateStore(plugin);
    this.inbox = new InboxCaptureService(plugin.app);
    this.media = new WeChatMediaService(plugin.app);
    this.collaboration = new WeChatCollaborationService(plugin, this.stateStore);
  }

  getStatus(): WeChatStatusSnapshot {
    return { ...this.snapshot };
  }

  isRunning(): boolean {
    return this.controller !== null && !this.controller.signal.aborted;
  }

  hasCredential(): Promise<boolean> {
    return this.stateStore.hasCredential();
  }

  async ensureDesktopConversationTab(): Promise<void> {
    const preferences = await this.stateStore.loadConversationPreferences();
    if (preferences?.conversationId) {
      await this.plugin.ensureWeChatConversationTab(preferences.conversationId);
    }
  }

  createLoginSession(): IlinkLoginSession {
    return new IlinkLoginSession(this.client);
  }

  async completeLogin(response: IlinkQrStatusResponse): Promise<void> {
    if (!response.bot_token || !response.ilink_bot_id || !response.ilink_user_id) {
      throw new Error('微信确认成功，但没有返回完整的 Bot 凭据。');
    }
    const baseUrl = response.baseurl?.trim() || ILINK_API_BASE_URL;
    if (!baseUrl.startsWith('https://')) throw new Error('微信返回了不安全的服务地址。');
    await this.stateStore.saveCredential({
      accountId: response.ilink_bot_id,
      baseUrl,
      userId: response.ilink_user_id,
      token: response.bot_token,
      connectedAt: new Date().toISOString(),
    });
    this.plugin.settings.wechatAutoStart = true;
    await this.plugin.saveSettings();
    await this.start();
  }

  async start(): Promise<void> {
    if (this.isRunning()) return;
    this.briefCatchUpAttemptedDate = '';
    let credential: WeChatCredential;
    try {
      const loaded = await this.stateStore.loadCredential();
      if (!loaded) {
        this.setStatus('未连接', '请先使用微信扫码绑定。');
        return;
      }
      credential = loaded;
    } catch (error) {
      this.setStatus('需要重新连接', error instanceof Error ? error.message : '无法读取微信凭据。');
      return;
    }

    this.controller = new AbortController();
    this.setStatus('连接中', '正在连接腾讯 iLink 服务。');
    try {
      await this.client.notifyStart(credential.baseUrl, credential.token);
    } catch {
      // getUpdates is the authoritative connection check.
    }
    this.setStatus('运行中', '微信远程收件箱正在接收消息。');
    this.monitorPromise = this.monitor(credential, this.controller.signal);
    this.scheduleButlerBrief();
  }

  async stop(): Promise<void> {
    const controller = this.controller;
    this.controller = null;
    controller?.abort();
    await this.monitorPromise;
    this.monitorPromise = null;
    if (this.briefTimer !== null) {
      window.clearTimeout(this.briefTimer);
      this.briefTimer = null;
    }
    const credential = await this.stateStore.loadCredential().catch(() => null);
    if (credential) await this.client.notifyStop(credential.baseUrl, credential.token).catch(() => undefined);
    this.collaboration.cleanup();
    if (this.snapshot.state !== '需要重新连接') this.setStatus('已停止', '微信连接已停止。');
  }

  async disconnect(): Promise<void> {
    await this.stop();
    await this.stateStore.clear();
    this.setStatus('未连接', '本机微信凭据已经清除。');
  }

  rescheduleButlerBrief(): void {
    this.scheduleButlerBrief();
  }

  private async monitor(credential: WeChatCredential, signal: AbortSignal): Promise<void> {
    let cursor = await this.stateStore.loadCursor();
    let timeoutMs = 35_000;
    let failures = 0;
    while (!signal.aborted) {
      try {
        const response = await this.client.getUpdates({
          baseUrl: credential.baseUrl,
          token: credential.token,
          cursor,
          timeoutMs,
          signal,
        });
        if (signal.aborted) return;
        const errorCode = response.errcode ?? response.ret ?? 0;
        if (errorCode === -14) {
          this.setStatus('需要重新连接', '微信连接已经失效，请重新扫码。');
          this.controller = null;
          return;
        }
        if (errorCode !== 0) throw new Error(response.errmsg || `iLink 错误 ${errorCode}`);
        failures = 0;
        if (response.longpolling_timeout_ms && response.longpolling_timeout_ms > 0) {
          timeoutMs = response.longpolling_timeout_ms;
        }
        for (const message of response.msgs ?? []) {
          await this.processMessage(message, credential);
        }
        if (response.get_updates_buf) {
          cursor = response.get_updates_buf;
          await this.stateStore.saveCursor(cursor);
        }
      } catch {
        if (signal.aborted) return;
        failures++;
        const delay = failures >= 3 ? 30_000 : 2_000;
        this.setStatus('发生错误', `微信连接暂时中断，${Math.round(delay / 1000)} 秒后重试。`);
        await sleep(delay, signal);
        if (!signal.aborted) this.setStatus('连接中', '正在重新连接微信。');
      }
    }
  }

  private async processMessage(message: IlinkMessage, credential: WeChatCredential): Promise<void> {
    const fromUserId = message.from_user_id?.trim();
    if (!fromUserId || fromUserId !== credential.userId) return;
    const messageKey = getWechatMessageKey(message);
    if (await this.stateStore.hasProcessed(messageKey)) return;

    const receivedAt = Date.now();
    const now = message.create_time_ms && Number.isFinite(message.create_time_ms)
      ? new Date(message.create_time_ms)
      : new Date();
    if (message.context_token) {
      await this.stateStore.saveOutboundContext({
        userId: fromUserId,
        contextToken: message.context_token,
        updatedAt: now.toISOString(),
      }).catch(() => undefined);
      window.setTimeout(() => { void this.trySendButlerBrief(new Date()); }, 1_000);
    }
    const completeStatus = (detail: string): void => {
      this.snapshot = {
        ...this.snapshot,
        state: '运行中',
        detail,
        lastInboundAt: receivedAt,
        lastDeliveryLagMs: Math.max(0, receivedAt - now.getTime()),
        lastProcessingMs: Math.max(0, Date.now() - receivedAt),
      };
    };
    const text = extractWechatText(message);
    const attachmentPaths: string[] = [];
    const mediaErrors: string[] = [];
    if (this.plugin.settings.wechatCaptureMedia) {
      const maxBytes = Math.max(1, Math.min(100, this.plugin.settings.wechatMaxAttachmentMB)) * 1024 * 1024;
      for (const item of collectWechatMediaItems(message.item_list)) {
        try {
          const path = await this.media.save(item, now, maxBytes);
          if (path) attachmentPaths.push(path);
        } catch (error) {
          mediaErrors.push(error instanceof Error ? error.message : '附件保存失败');
        }
      }
    }

    const sections: string[] = [];
    if (text) sections.push(text);
    if (attachmentPaths.length) {
      sections.push(`## 微信附件\n\n${attachmentPaths.map((path) => `- [[${path}]]`).join('\n')}`);
    }
    if (mediaErrors.length) {
      sections.push(`## 接收异常\n\n${mediaErrors.map((error) => `- ${error}`).join('\n')}`);
    }
    if (!sections.length) sections.push('收到一条当前版本暂不支持解析的微信消息。');

    const collaborationEnabled = this.plugin.settings.wechatCollaborationEnabled;
    const intent = text ? classifyWeChatIntent(text) : { kind: 'capture' as const, text: '', forced: false };
    const digestCommand = attachmentPaths.length === 0 && mediaErrors.length === 0
      ? parseWechatDigestCommand(text)
      : null;
    const collaborationCommand = collaborationEnabled && attachmentPaths.length === 0 && mediaErrors.length === 0
      ? parseWeChatCollaborationCommand(text)
      : null;

    if (collaborationCommand?.kind === 'new') {
      await this.processCollaborationCommandSafely(collaborationCommand, text, message, credential, now);
      await this.stateStore.markProcessed(messageKey);
      completeStatus('最近一条微信协作指令已处理。');
      return;
    }

    await this.collaboration.recordInbound(sections.join('\n\n'), now).catch(() => undefined);

    if (text && message.context_token) {
      const butlerReply = await this.tryHandleButlerFeedback(text, now).catch(() => null);
      if (butlerReply) {
        await this.sendReplies(credential, message.context_token, [butlerReply]);
        await this.stateStore.markProcessed(messageKey);
        completeStatus('最近一条管家反馈已同步到行动工作台。');
        return;
      }
    }

    if (digestCommand) {
      await this.processDigestCommandSafely(digestCommand, message, credential, now);
      await this.stateStore.markProcessed(messageKey);
      completeStatus('最近一条微信分流指令已处理。');
      return;
    }

    if (collaborationCommand) {
      await this.processCollaborationCommandSafely(collaborationCommand, text, message, credential, now);
      await this.stateStore.markProcessed(messageKey);
      completeStatus('最近一条微信协作指令已处理。');
      return;
    }

    const shouldCaptureBeforeAgent = !collaborationEnabled
      || intent.kind === 'capture'
      || !text
      || attachmentPaths.length > 0
      || mediaErrors.length > 0;
    let capturePath: string | null = null;
    if (shouldCaptureBeforeAgent) {
      capturePath = await this.inbox.capture(sections.join('\n\n'), now, {
        source: 'wechat-ilink',
        metadata: {
          wechat_message_id: messageKey,
          wechat_user_id: fromUserId,
          attachment_count: attachmentPaths.length,
        },
      });
    }

    if (!collaborationEnabled || intent.kind === 'capture' || !text) {
      await this.stateStore.markProcessed(messageKey);
      let receipt = capturePath ? `已收录到微信收件箱：${capturePath}` : '微信消息已接收。';
      if (message.context_token && capturePath) {
        const summary = attachmentPaths.length
          ? `已收录文字和 ${attachmentPaths.length} 个附件`
          : '已原样收录到微信收件箱';
        receipt = `${summary}。\n编号：${captureCode(now)}\n稍后可以发送“消化这批”。\n位置：${capturePath}`;
        await this.sendReplies(credential, message.context_token, [receipt]).catch(() => undefined);
      }
      if (!message.context_token) await this.collaboration.recordAssistant(receipt, new Date()).catch(() => undefined);
      completeStatus('最近一条微信消息已收录。');
      return;
    }

    if (!message.context_token) {
      if (!capturePath) {
        capturePath = await this.inbox.capture(text, now, {
          source: 'wechat-ilink',
          metadata: { wechat_message_id: messageKey, wechat_user_id: fromUserId, attachment_count: 0 },
        });
      }
      await this.stateStore.markProcessed(messageKey);
      const receipt = `消息缺少会话凭据，已转存收件箱：${capturePath}`;
      await this.collaboration.recordAssistant(receipt, new Date()).catch(() => undefined);
      completeStatus('消息缺少会话凭据，已转存收件箱。');
      return;
    }

    try {
      const mode = (await this.stateStore.loadConversationPreferences())?.mode
        ?? this.plugin.settings.wechatDefaultPerformanceMode
        ?? 'fast';
      const attachmentNotice = capturePath ? `，附件和原始记录已保存：${capturePath}` : '';
      await this.sendReplies(credential, message.context_token, [
        `正在使用${mode === 'fast' ? '快速' : '深度'}通道处理${attachmentNotice}。`,
      ]);
      const result = await this.collaboration.runChat(intent.text, attachmentPaths, now, {
        excludeLatestInboundFromHistory: true,
      });
      const replies = [...result.replies];
      if (result.captureRequested && !(intent.kind === 'chat' && intent.forced)) {
        if (!capturePath) {
          capturePath = await this.inbox.capture(sections.join('\n\n'), now, {
            source: 'wechat-ilink',
            metadata: {
              wechat_message_id: messageKey,
              wechat_user_id: fromUserId,
              attachment_count: attachmentPaths.length,
              capture_decision: 'agent',
            },
          });
        }
        replies.push(`已按内容判断收录到微信收件箱：${capturePath}`);
      }
      await this.sendReplies(credential, message.context_token, replies);
      completeStatus('最近一条微信对话已完成。');
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const failureReply = `本次对话未完成：${reason}\n没有执行任何笔记修改。${capturePath ? `\n原始记录：${capturePath}` : ''}`;
      await this.sendReplies(credential, message.context_token, [failureReply]).catch(() => undefined);
      completeStatus('最近一条微信对话处理失败。');
    } finally {
      await this.stateStore.markProcessed(messageKey);
    }
  }

  private async processCollaborationCommandSafely(
    command: WeChatCollaborationCommand,
    originalText: string,
    message: IlinkMessage,
    credential: WeChatCredential,
    now: Date,
  ): Promise<void> {
    if (!message.context_token) {
      if (command.kind === 'new') {
        await this.collaboration.recordInbound(originalText, now).catch(() => undefined);
      }
      return;
    }
    let inboundRecorded = command.kind !== 'new';
    try {
      let replies: string[];
      if (command.kind === 'new') {
        replies = [await this.collaboration.startNewConversation(now)];
        await this.collaboration.recordInbound(originalText, now);
        inboundRecorded = true;
      }
      else if (command.kind === 'status') replies = [await this.collaboration.getStatusText()];
      else if (command.kind === 'help') replies = [this.collaboration.getHelpText()];
      else if (command.kind === 'mode') replies = [await this.collaboration.setMode(command.mode)];
      else if (command.kind === 'today') replies = [await this.collaboration.openTodayNote()];
      else if (command.kind === 'butler-brief') replies = [(await this.buildButlerBrief(now)).text];
      else if (command.kind === 'cancel-action') replies = [await this.collaboration.cancelPendingAction()];
      else if (command.kind === 'confirm-action') {
        const target = command.id ? ` ${command.id}` : '最新待确认操作';
        await this.sendReplies(credential, message.context_token, [`正在核对${target}、创建快照并执行。`]);
        replies = [await this.collaboration.confirmPendingAction(command.id)];
      } else {
        await this.sendReplies(credential, message.context_token, ['正在总结当前微信会话。']);
        replies = (await this.collaboration.summarize(now, {
          excludeLatestInboundFromHistory: true,
        })).replies;
      }
      await this.sendReplies(credential, message.context_token, replies);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const failureReply = `操作未执行：${reason}`;
      if (!inboundRecorded) await this.collaboration.recordInbound(originalText, now).catch(() => undefined);
      await this.sendReplies(credential, message.context_token, [failureReply]).catch(() => undefined);
    }
  }

  private async processDigestCommandSafely(
    command: WeChatDigestCommand,
    message: IlinkMessage,
    credential: WeChatCredential,
    now: Date,
  ): Promise<void> {
    try {
      if (!message.context_token) throw new Error('本条微信消息缺少会话凭据，未执行任何操作。');
      await this.processDigestCommand(command, message.context_token, credential, now);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (message.context_token) {
        await this.sendReplies(credential, message.context_token, [`操作未执行：${reason}`]).catch(() => undefined);
      }
    }
  }

  private async processDigestCommand(
    command: WeChatDigestCommand,
    contextToken: string,
    credential: WeChatCredential,
    now: Date,
  ): Promise<void> {
    if (command.kind === 'analyze') {
      const existing = await this.loadActiveDraft();
      if (existing && !command.force) {
        await this.sendReplies(credential, contextToken, [
          `已有待确认批次 ${existing.id}。回复“查看分流”继续检查，或回复“重新消化”覆盖它。`,
        ]);
        return;
      }
      await this.sendReplies(credential, contextToken, ['正在使用只读快速通道分析，完成前不会改动任何笔记。']);
      const proposals = await new InboxDigestService(this.plugin.app, this.plugin).analyze(10);
      if (proposals.length === 0) {
        await this.sendReplies(credential, contextToken, ['当前没有待消化的原始输入。']);
        return;
      }
      const draft: WeChatDigestDraft = {
        id: digestCode(now),
        createdAt: now.toISOString(),
        proposals,
      };
      await this.stateStore.saveDigestDraft(draft);
      await this.sendReplies(credential, contextToken, formatDigestDraftMessages(draft));
      return;
    }

    const draft = await this.loadActiveDraft();
    if (!draft) throw new Error('没有待确认的分流建议，请先发送“消化这批”。');

    if (command.kind === 'show') {
      await this.sendReplies(credential, contextToken, formatDigestDraftMessages(draft));
      return;
    }
    if (command.kind === 'cancel') {
      await this.stateStore.clearDigestDraft();
      await this.sendReplies(credential, contextToken, [`已取消批次 ${draft.id}，没有改动任何笔记。`]);
      return;
    }
    if (command.kind === 'select') {
      const proposal = this.getDraftProposal(draft, command.index);
      proposal.selected = command.selected && proposal.category !== 'inbox';
      await this.stateStore.saveDigestDraft(draft);
      await this.sendReplies(credential, contextToken, [
        `${formatDigestProposal(proposal, command.index)}\n\n继续修改，或回复“确认归位”。`,
      ]);
      return;
    }
    if (command.kind === 'edit') {
      const proposal = this.getDraftProposal(draft, command.index);
      if (command.field === 'category') {
        const category = parseRoutingCategory(command.value);
        if (!category) throw new Error('无法识别该分类。可用：今日日记、心智复盘、下一步行动、活跃项目、来源资料、永久笔记、输出与作品、归档、仅留原始记录、暂留收件箱。');
        proposal.category = category;
        proposal.selected = category !== 'inbox';
      } else {
        proposal[command.field] = command.value.trim();
      }
      await this.stateStore.saveDigestDraft(draft);
      await this.sendReplies(credential, contextToken, [
        `已修改：\n${formatDigestProposal(proposal, command.index)}\n\n继续修改，或回复“确认归位”。`,
      ]);
      return;
    }

    if (command.batchId && command.batchId !== draft.id.toUpperCase()) {
      throw new Error(`批次号不一致。当前待确认批次为 ${draft.id}。`);
    }
    await this.sendReplies(credential, contextToken, [`正在归位批次 ${draft.id}，完成后会返回结果。`]);
    const result = await new InboxDigestService(this.plugin.app, this.plugin).apply(draft.proposals, now);
    await this.stateStore.clearDigestDraft();
    await this.sendReplies(credential, contextToken, [
      `处理完成。\n新建：${result.created.length}\n更新：${result.updated.length}\n复用已有：${result.reused.length}\n仅留原始：${result.retained.length}\n处理原始输入：${result.processedSources.length}\n快照：${result.snapshotPath}`,
    ]);
  }

  private async loadActiveDraft(): Promise<WeChatDigestDraft | null> {
    const draft = await this.stateStore.loadDigestDraft();
    if (!draft) return null;
    if (!isDigestDraftExpired(draft)) return draft;
    await this.stateStore.clearDigestDraft();
    return null;
  }

  private getDraftProposal(draft: WeChatDigestDraft, index: number): RoutingProposal {
    if (!Number.isInteger(index) || index < 1 || index > draft.proposals.length) {
      throw new Error(`序号应为 1 到 ${draft.proposals.length}。`);
    }
    return draft.proposals[index - 1];
  }

  private async sendReplies(credential: WeChatCredential, contextToken: string, texts: string[]): Promise<void> {
    for (const text of texts) {
      for (const chunk of splitWechatReply(text)) {
        await this.client.sendText({
          baseUrl: credential.baseUrl,
          token: credential.token,
          toUserId: credential.userId,
          contextToken,
          text: chunk,
        });
      }
      await this.collaboration.recordAssistant(text, new Date()).catch(() => undefined);
    }
  }

  private scheduleButlerBrief(): void {
    if (this.briefTimer !== null) window.clearTimeout(this.briefTimer);
    this.briefTimer = null;
    if (!this.isRunning() || !this.plugin.settings.wechatButlerEnabled) return;
    const now = new Date();
    const { hours, minutes } = parseBriefTime(this.plugin.settings.wechatButlerBriefTime);
    const target = new Date(now);
    target.setHours(hours, minutes, 0, 0);
    const today = localDateKey(now);
    const shouldCatchUp = target.getTime() <= now.getTime()
      && this.plugin.settings.wechatButlerCatchUp
      && this.briefCatchUpAttemptedDate !== today;
    const delay = shouldCatchUp
      ? 2_500
      : target.getTime() <= now.getTime()
        ? target.setDate(target.getDate() + 1) - now.getTime()
        : target.getTime() - now.getTime();
    this.briefTimer = window.setTimeout(() => {
      this.briefTimer = null;
      this.briefCatchUpAttemptedDate = localDateKey(new Date());
      void this.trySendButlerBrief(new Date()).finally(() => this.scheduleButlerBrief());
    }, Math.max(1_000, delay));
  }

  private async trySendButlerBrief(now: Date): Promise<boolean> {
    if (this.briefInFlight) return this.briefInFlight;
    const operation = this.sendButlerBriefOnce(now).catch((error: unknown) => {
      this.snapshot.detail = `管家简报已暂停：${error instanceof Error ? error.message : String(error)}`;
      return false;
    });
    this.briefInFlight = operation;
    try {
      return await operation;
    } finally {
      this.briefInFlight = null;
    }
  }

  private async sendButlerBriefOnce(now: Date): Promise<boolean> {
    if (!this.plugin.settings.wechatButlerEnabled) return false;
    const date = localDateKey(now);
    const delivery = await this.stateStore.loadButlerDelivery();
    if (delivery.lastSentDate === date) return true;
    if (delivery.pendingDate === date) {
      this.snapshot.detail = '管家简报上次发送结果未确认，今天已暂停自动重发；可手动请求简报。';
      return false;
    }
    // Repair older installations whose sent date was overwritten by tab-state saves.
    const preferences = await this.stateStore.loadConversationPreferences();
    const conversation = preferences?.conversationId
      ? await this.plugin.getConversationById(preferences.conversationId)
      : null;
    const existing = conversation?.messages.some((message) =>
      message.role === 'assistant'
      && message.content.startsWith(`早上好，${date} 的管家简报。`)
      && localDateKey(new Date(message.timestamp)) === date);
    if (existing) {
      await this.stateStore.saveButlerDelivery({ ...delivery, lastSentDate: date, pendingDate: undefined, lastError: undefined });
      return true;
    }
    const { hours, minutes } = parseBriefTime(this.plugin.settings.wechatButlerBriefTime);
    const target = new Date(now);
    target.setHours(hours, minutes, 0, 0);
    if (now.getTime() < target.getTime()) return false;
    if (!this.plugin.settings.wechatButlerCatchUp && now.getTime() - target.getTime() > 15 * 60 * 1000) return false;
    const [credential, context] = await Promise.all([
      this.stateStore.loadCredential(),
      this.stateStore.loadOutboundContext(),
    ]);
    if (!credential || !context) {
      await this.stateStore.saveButlerDelivery({
        ...delivery,
        lastAttemptAt: now.toISOString(),
        lastError: '尚未获得可用于主动发送的微信会话令牌。',
      });
      return false;
    }
    const { text, actionIds } = await this.buildButlerBrief(now);
    // Persist intent before the external side effect; uncertain sends are never retried automatically.
    const pending = { ...delivery, pendingDate: date, lastAttemptAt: now.toISOString(), lastError: undefined };
    await this.stateStore.saveButlerDelivery(pending);
    try {
      await this.client.sendText({
        baseUrl: credential.baseUrl,
        token: credential.token,
        toUserId: context.userId,
        contextToken: context.contextToken,
        text,
      });
    } catch (error) {
      const stale = error instanceof IlinkApiError && error.status === -2;
      await this.stateStore.saveButlerDelivery({
        ...pending,
        pendingDate: stale ? undefined : date,
        lastError: stale ? '微信会话令牌已过期，下一次收到你的消息后再补发。' : `发送结果未确认，今天暂停自动重发：${error instanceof Error ? error.message : String(error)}`,
      });
      this.snapshot.detail = stale ? '管家简报等待新的微信会话令牌。' : '管家简报发送结果未确认，今天已暂停自动重发。';
      return false;
    }
    await this.stateStore.saveButlerDelivery({
      lastSentDate: date,
      lastAttemptAt: now.toISOString(),
      lastBriefActionIds: actionIds,
    });
    await this.collaboration.recordAssistant(text, now).catch(() => undefined);
    return true;
  }

  private async buildButlerBrief(now: Date): Promise<{ text: string; actionIds: string[] }> {
    const [brief, allActions] = await Promise.all([
      this.plugin.actionWorkbenchService.getBrief(now),
      this.plugin.actionWorkbenchService.listActions(),
    ]);
    const maxItems = Math.max(1, Math.min(20, this.plugin.settings.wechatButlerMaxItems));
    const todayActions = sortBriefActions(uniqueBriefActions(brief.today));
    const selectedToday = todayActions.slice(0, maxItems);
    const selectedIds = new Set(selectedToday.map((action) => action.id));
    const selectedTitles = new Set(selectedToday.map((action) => briefTitleKey(action.title)));
    const priorityActions = sortBriefActions(uniqueBriefActions(allActions.filter((action) => (
      !['completed', 'cancelled'].includes(action.status)
      && ['high', 'medium'].includes(action.priority)
      && !selectedIds.has(action.id)
      && !selectedTitles.has(briefTitleKey(action.title))
    ))));
    const selectedPriority = priorityActions.slice(0, Math.max(0, maxItems - selectedToday.length));
    const selected = [...selectedToday, ...selectedPriority];
    const lines = [`早上好，${localDateKey(now)} 的管家简报。`, ''];
    lines.push('今天的任务：');
    if (selectedToday.length === 0) {
      lines.push('- 暂无');
    } else {
      selectedToday.forEach((action, index) => lines.push(this.formatBriefAction(action, index + 1, now)));
      if (todayActions.length > selectedToday.length) {
        lines.push(`- 另有 ${todayActions.length - selectedToday.length} 项今天任务未展示（已达到简报行动上限）`);
      }
    }
    lines.push('', '其他高、普通优先级行动：');
    if (selectedPriority.length === 0) {
      lines.push('- 暂无');
    } else {
      selectedPriority.forEach((action, index) => {
        lines.push(this.formatBriefAction(action, selectedToday.length + index + 1, now, true));
      });
      const omitted = priorityActions.length - selectedPriority.length;
      if (omitted > 0) lines.push(`- 另有 ${omitted} 项未展示（已达到简报行动上限）`);
    }
    if (this.plugin.settings.wechatButlerIncludeInsights) {
      const [lifecycle, insights] = await Promise.all([
        this.plugin.actionLifecycleServiceForButler(),
        this.plugin.proactiveInsightSummaryForButler(),
      ]);
      const questions = [...lifecycle, ...insights].slice(0, 3);
      if (questions.length) {
        lines.push('', '需要你决定：');
        questions.forEach((question) => lines.push(`- ${question}`));
      }
    }
    lines.push('', '直接告诉我哪些完成了、改到哪天、优先级如何，或者暂时不做。');
    return { text: lines.join('\n'), actionIds: selected.map((action) => action.id) };
  }

  private formatBriefAction(action: WorkbenchAction, index: number, now: Date, includeStatus = false): string {
    const statusLabels: Partial<Record<WorkbenchAction['status'], string>> = {
      inbox: '收集箱',
      planned: '计划中',
      waiting: '等待中',
    };
    const labels = [
      action.priority !== 'none' ? action.priority === 'high' ? '高' : action.priority === 'low' ? '低' : '普通' : '',
      includeStatus ? statusLabels[action.status] ?? '' : '',
      action.dueDate ? action.dueDate < localDateKey(now) ? `逾期 ${action.dueDate}` : action.dueDate : '',
    ].filter(Boolean).join(' · ');
    return `${index}. ${action.title}${labels ? `（${labels}）` : ''}`;
  }

  private async tryHandleButlerFeedback(text: string, now: Date): Promise<string | null> {
    if (!/(?:完成|做完|恢复|改到|延期|推迟|优先级|不做|取消|放弃|等待)/u.test(text)) return null;
    const delivery = await this.stateStore.loadButlerDelivery();
    const ids = delivery.lastBriefActionIds ?? [];
    if (ids.length === 0) return null;
    const actions = (await this.plugin.actionWorkbenchService.listActions()).filter((action) => ids.includes(action.id));
    const segments = text.split(/[，,。；;\n]+/u).map((item) => item.trim()).filter(Boolean);
    const results: string[] = [];
    for (const segment of segments) {
      const indexMatch = segment.match(/(?:第\s*)?(\d+|[一二三四五六七八九十])\s*项?/u);
      const ordinal = indexMatch ? parseOrdinal(indexMatch[1]) : 0;
      let action = ordinal ? actions.find((item) => item.id === ids[ordinal - 1]) : undefined;
      if (!action) {
        const titleHint = segment
          .replace(/(?:完成|做完|恢复|改到|延期|推迟|优先级|不做|取消|放弃|等待).*/u, '')
          .trim();
        action = actions.find((item) => segment.includes(item.title) || (titleHint.length >= 2 && item.title.includes(titleHint)));
      }
      if (!action) continue;
      if (/(?:恢复|重新开始|继续做)/u.test(segment) && ['completed', 'cancelled'].includes(action.status)) {
        await this.plugin.actionWorkbenchService.restoreAction(action.id, now);
        results.push(`已恢复“${action.title}”`);
      } else if (/(?:完成|做完|已经办好|已办)/u.test(segment)) {
        await this.plugin.actionWorkbenchService.completeAction(action.id, now);
        results.push(`已完成“${action.title}”`);
      } else if (/(?:不做|取消|放弃)/u.test(segment)) {
        await this.plugin.actionWorkbenchService.cancelAction(action.id, now);
        results.push(`已取消并归档“${action.title}”`);
      } else if (/(?:等待|等回复|等通知)/u.test(segment)) {
        await this.plugin.actionWorkbenchService.updateAction(action.id, { status: 'waiting' }, now);
        results.push(`已将“${action.title}”转为等待`);
      } else if (/(?:改到|延期|推迟)/u.test(segment)) {
        const dueDate = resolveNaturalDate(segment, now);
        if (!dueDate) continue;
        await this.plugin.actionWorkbenchService.updateAction(action.id, { dueDate, status: 'planned' }, now);
        results.push(`已将“${action.title}”调整到 ${dueDate}`);
      } else if (/优先级/u.test(segment)) {
        const priority: WorkbenchActionPriority = /高/u.test(segment) ? 'high' : /低/u.test(segment) ? 'low' : 'medium';
        await this.plugin.actionWorkbenchService.updateAction(action.id, { priority }, now);
        results.push(`已调整“${action.title}”的优先级`);
      }
    }
    return results.length ? `${results.join('；')}。电脑端行动工作台已同步，需要撤销时直接告诉我。` : null;
  }

  private setStatus(state: WeChatChannelState, detail: string): void {
    this.snapshot = { ...this.snapshot, state, detail };
  }
}

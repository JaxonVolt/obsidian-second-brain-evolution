import { createHash } from 'crypto';

import type SecondBrainPlugin from '../../main';
import { InboxCaptureService } from '../knowledge/InboxCaptureService';
import { InboxDigestService, type RoutingProposal } from '../knowledge/InboxDigestService';
import { IlinkClient } from './IlinkClient';
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

export class WeChatChannelService {
  private client = new IlinkClient();
  private stateStore: WeChatStateStore;
  private inbox: InboxCaptureService;
  private media: WeChatMediaService;
  private controller: AbortController | null = null;
  private monitorPromise: Promise<void> | null = null;
  private snapshot: WeChatStatusSnapshot = { state: '未连接', detail: '尚未绑定微信 Bot。' };

  constructor(private plugin: SecondBrainPlugin) {
    this.stateStore = new WeChatStateStore(plugin);
    this.inbox = new InboxCaptureService(plugin.app);
    this.media = new WeChatMediaService(plugin.app);
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
  }

  async stop(): Promise<void> {
    const controller = this.controller;
    this.controller = null;
    controller?.abort();
    await this.monitorPromise;
    this.monitorPromise = null;
    const credential = await this.stateStore.loadCredential().catch(() => null);
    if (credential) await this.client.notifyStop(credential.baseUrl, credential.token).catch(() => undefined);
    if (this.snapshot.state !== '需要重新连接') this.setStatus('已停止', '微信连接已停止。');
  }

  async disconnect(): Promise<void> {
    await this.stop();
    await this.stateStore.clear();
    this.setStatus('未连接', '本机微信凭据已经清除。');
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

    const now = message.create_time_ms && Number.isFinite(message.create_time_ms)
      ? new Date(message.create_time_ms)
      : new Date();
    const text = extractWechatText(message);
    const command = parseWechatDigestCommand(text);
    if (command) {
      await this.processDigestCommandSafely(command, message, credential, now);
      await this.stateStore.markProcessed(messageKey);
      this.snapshot = { ...this.snapshot, state: '运行中', detail: '最近一条微信分流指令已处理。', lastInboundAt: Date.now() };
      return;
    }

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

    const path = await this.inbox.capture(sections.join('\n\n'), now, {
      source: 'wechat-ilink',
      metadata: {
        wechat_message_id: messageKey,
        wechat_user_id: fromUserId,
        attachment_count: attachmentPaths.length,
      },
    });
    await this.stateStore.markProcessed(messageKey);
    this.snapshot = { ...this.snapshot, state: '运行中', detail: '最近一条微信消息已收录。', lastInboundAt: Date.now() };

    if (message.context_token) {
      const summary = attachmentPaths.length
        ? `已收录文字和 ${attachmentPaths.length} 个附件`
        : '已原样收录到微信收件箱';
      await this.client.sendText({
        baseUrl: credential.baseUrl,
        token: credential.token,
        toUserId: fromUserId,
        contextToken: message.context_token,
        text: `${summary}。\n编号：${captureCode(now)}\n稍后可以发送“消化这批”。\n位置：${path}`,
      }).catch(() => undefined);
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
        if (!category) throw new Error('无法识别该分类。可用：今日日记、心智复盘、下一步行动、活跃项目、来源资料、永久笔记、输出与作品、归档、暂留收件箱。');
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
      `归位完成。\n新建：${result.created.length}\n更新：${result.updated.length}\n处理原始输入：${result.processedSources.length}\n快照：${result.snapshotPath}`,
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
      await this.client.sendText({
        baseUrl: credential.baseUrl,
        token: credential.token,
        toUserId: credential.userId,
        contextToken,
        text,
      });
    }
  }

  private setStatus(state: WeChatChannelState, detail: string): void {
    this.snapshot = { ...this.snapshot, state, detail };
  }
}

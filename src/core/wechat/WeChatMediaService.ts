import { createDecipheriv } from 'crypto';
import { type App, requestUrl } from 'obsidian';

import { ILINK_CDN_BASE_URL, type IlinkMediaReference, type IlinkMessageItem, MessageItemType } from './types';

export const WECHAT_ATTACHMENT_DIR = '010_收件箱/微信附件';

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function parseAesKey(value: string): Buffer {
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex');
  }
  throw new Error('微信附件的加密密钥格式无效。');
}

export function decryptIlinkMedia(encrypted: Buffer, aesKeyBase64: string): Buffer {
  const decipher = createDecipheriv('aes-128-ecb', parseAesKey(aesKeyBase64), null);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

export function sanitizeWechatFileName(value: string): string {
  const base = value.replace(/\\/g, '/').split('/').pop() ?? '';
  const sanitized = Array.from(base, (character) =>
    character.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(character) ? '_' : character
  ).join('').replace(/^\.+/, '').trim();
  return sanitized.slice(0, 120) || '附件.bin';
}

function imageExtension(buffer: Buffer): string {
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return '.jpg';
  if (buffer.subarray(0, 4).toString('ascii') === 'GIF8') return '.gif';
  if (buffer.subarray(8, 12).toString('ascii') === 'WEBP') return '.webp';
  return '.bin';
}

function mediaRef(item: IlinkMessageItem): { media?: IlinkMediaReference; aesKey?: string; fileName: string } {
  if (item.type === MessageItemType.IMAGE) {
    const image = item.image_item;
    const aesKey = image?.aeskey
      ? Buffer.from(image.aeskey, 'hex').toString('base64')
      : image?.media?.aes_key;
    return { media: image?.media, aesKey, fileName: '微信图片' };
  }
  if (item.type === MessageItemType.FILE) {
    return {
      media: item.file_item?.media,
      aesKey: item.file_item?.media?.aes_key,
      fileName: sanitizeWechatFileName(item.file_item?.file_name ?? '附件.bin'),
    };
  }
  if (item.type === MessageItemType.VIDEO) {
    return { media: item.video_item?.media, aesKey: item.video_item?.media?.aes_key, fileName: '微信视频.mp4' };
  }
  return { media: item.voice_item?.media, aesKey: item.voice_item?.media?.aes_key, fileName: '微信语音.silk' };
}

export class WeChatMediaService {
  constructor(private app: App, private fetchFn?: typeof fetch) {}

  async save(item: IlinkMessageItem, now: Date, maxBytes: number): Promise<string | null> {
    if (![MessageItemType.IMAGE, MessageItemType.FILE, MessageItemType.VIDEO, MessageItemType.VOICE].includes(item.type as 2)) {
      return null;
    }
    const ref = mediaRef(item);
    if (!ref.media?.full_url && !ref.media?.encrypt_query_param) return null;
    const url = ref.media.full_url
      ?? `${ILINK_CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(ref.media.encrypt_query_param ?? '')}`;
    if (!url.startsWith('https://')) throw new Error('拒绝下载非 HTTPS 微信附件。');

    let status: number;
    let declaredSize: number;
    let encrypted: Buffer;
    if (this.fetchFn) {
      const response = await this.fetchFn(url);
      status = response.status;
      declaredSize = Number(response.headers.get('content-length') ?? 0);
      encrypted = Buffer.from(await response.arrayBuffer());
    } else {
      const response = await requestUrl({ url, method: 'GET', throw: false });
      status = response.status;
      declaredSize = Number(response.headers['content-length'] ?? 0);
      encrypted = Buffer.from(response.arrayBuffer);
    }
    if (status < 200 || status >= 300) throw new Error(`微信附件下载失败（${status}）。`);
    if (declaredSize > maxBytes) throw new Error('微信附件超过允许的大小。');
    if (encrypted.length > maxBytes + 16) throw new Error('微信附件超过允许的大小。');
    const content = ref.aesKey ? decryptIlinkMedia(encrypted, ref.aesKey) : encrypted;
    if (content.length > maxBytes) throw new Error('微信附件超过允许的大小。');

    const folder = `${WECHAT_ATTACHMENT_DIR}/${now.getFullYear()}/${pad(now.getMonth() + 1)}`;
    await this.ensureFolder(folder);
    const baseName = item.type === MessageItemType.IMAGE
      ? `${now.getTime()}${imageExtension(content)}`
      : `${now.getTime()}-${ref.fileName}`;
    const path = await this.uniquePath(folder, baseName);
    const bytes = content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer;
    await this.app.vault.adapter.writeBinary(path, bytes);
    return path;
  }

  private async ensureFolder(path: string): Promise<void> {
    const adapter = this.app.vault.adapter;
    let current = '';
    for (const part of path.split('/')) {
      current = current ? `${current}/${part}` : part;
      if (!(await adapter.exists(current))) await adapter.mkdir(current);
    }
  }

  private async uniquePath(folder: string, fileName: string): Promise<string> {
    const adapter = this.app.vault.adapter;
    const dot = fileName.lastIndexOf('.');
    const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
    const ext = dot > 0 ? fileName.slice(dot) : '';
    let candidate = `${folder}/${fileName}`;
    for (let suffix = 2; await adapter.exists(candidate); suffix++) {
      candidate = `${folder}/${stem}-${suffix}${ext}`;
    }
    return candidate;
  }
}

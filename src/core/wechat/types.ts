export const ILINK_API_BASE_URL = 'https://ilinkai.weixin.qq.com';
export const ILINK_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
export const ILINK_CHANNEL_VERSION = '2.4.6';
export const ILINK_BOT_TYPE = '3';

export const MessageItemType = {
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
} as const;

export interface IlinkMediaReference {
  encrypt_query_param?: string;
  aes_key?: string;
  full_url?: string;
}

export interface IlinkMessageItem {
  [key: string]: unknown;
  type?: number;
  msg_id?: string;
  ref_msg?: {
    title?: string;
    message_item?: IlinkMessageItem;
  };
  text_item?: { text?: string };
  image_item?: {
    media?: IlinkMediaReference;
    aeskey?: string;
  };
  voice_item?: {
    media?: IlinkMediaReference;
    text?: string;
  };
  file_item?: {
    media?: IlinkMediaReference;
    file_name?: string;
    len?: string;
  };
  video_item?: {
    media?: IlinkMediaReference;
  };
}

export interface IlinkMessage {
  message_id?: number;
  client_id?: string;
  from_user_id?: string;
  create_time_ms?: number;
  item_list?: IlinkMessageItem[];
  context_token?: string;
}

export interface IlinkUpdatesResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: IlinkMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

export type IlinkQrStatus =
  | 'wait'
  | 'scaned'
  | 'confirmed'
  | 'expired'
  | 'scaned_but_redirect'
  | 'need_verifycode'
  | 'verify_code_blocked'
  | 'binded_redirect';

export interface IlinkQrStartResponse {
  qrcode: string;
  qrcode_img_content: string;
}

export interface IlinkQrStatusResponse {
  status: IlinkQrStatus;
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
}

export interface WeChatCredential {
  accountId: string;
  baseUrl: string;
  userId: string;
  token: string;
  connectedAt: string;
}

export type WeChatChannelState =
  | '未连接'
  | '已停止'
  | '连接中'
  | '运行中'
  | '需要重新连接'
  | '发生错误';

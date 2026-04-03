// ═══════════════════════════════════════════════════════════════════════
// Wire-level types — mirror the iLink Bot API JSON structures exactly.
// These are internal; the public API exposes friendlier abstractions.
// ═══════════════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'
export const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'

/** Read version from package.json for channel_version in base_info. */
function readVersionFromPackageJson(): string {
  try {
    const dir = dirname(fileURLToPath(import.meta.url))
    const pkgPath = resolve(dir, '..', '..', 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    return pkg.version ?? '2.0.0'
  } catch {
    return '2.0.0'
  }
}

export const CHANNEL_VERSION = readVersionFromPackageJson()

// ── Enums ──────────────────────────────────────────────────────────────

export enum MessageType {
  USER = 1,
  BOT = 2,
}

export enum MessageState {
  NEW = 0,
  GENERATING = 1,
  FINISH = 2,
}

export enum MessageItemType {
  TEXT = 1,
  IMAGE = 2,
  VOICE = 3,
  FILE = 4,
  VIDEO = 5,
}

export enum MediaType {
  IMAGE = 1,
  VIDEO = 2,
  FILE = 3,
  VOICE = 4,
}

// ── Structures ─────────────────────────────────────────────────────────

export interface BaseInfo {
  channel_version: string
}

export interface CDNMedia {
  encrypt_query_param: string
  aes_key: string
  encrypt_type?: 0 | 1
  /** Complete download URL returned by server; when set, use directly instead of building from encrypt_query_param. */
  full_url?: string
}

export interface TextItem {
  text: string
}

export interface ImageItem {
  media?: CDNMedia
  thumb_media?: CDNMedia
  aeskey?: string
  url?: string
  mid_size?: number | string
  thumb_size?: number | string
  thumb_height?: number
  thumb_width?: number
  hd_size?: number | string
}

export interface VoiceItem {
  media?: CDNMedia
  encode_type?: number
  bits_per_sample?: number
  sample_rate?: number
  text?: string
  playtime?: number
}

export interface FileItem {
  media?: CDNMedia
  file_name?: string
  md5?: string
  len?: string
}

export interface VideoItem {
  media?: CDNMedia
  video_size?: number | string
  play_length?: number
  video_md5?: string
  thumb_media?: CDNMedia
  thumb_size?: number | string
  thumb_height?: number
  thumb_width?: number
}

export interface RefMessage {
  title?: string
  message_item?: WireMessageItem
}

export interface WireMessageItem {
  type: MessageItemType
  text_item?: TextItem
  image_item?: ImageItem
  voice_item?: VoiceItem
  file_item?: FileItem
  video_item?: VideoItem
  ref_msg?: RefMessage
}

export interface WireMessage {
  seq?: number
  message_id?: number
  from_user_id: string
  to_user_id: string
  client_id: string
  create_time_ms: number
  update_time_ms?: number
  delete_time_ms?: number
  session_id?: string
  group_id?: string
  message_type: MessageType
  message_state: MessageState
  context_token: string
  item_list: WireMessageItem[]
}

// ── Request / Response ─────────────────────────────────────────────────

export interface GetUpdatesRequest {
  get_updates_buf: string
  base_info: BaseInfo
}

export interface GetUpdatesResponse {
  ret: number
  msgs: WireMessage[]
  get_updates_buf: string
  longpolling_timeout_ms?: number
  errcode?: number
  errmsg?: string
}

export interface SendMessageRequest {
  msg: {
    from_user_id: string
    to_user_id: string
    client_id: string
    message_type: MessageType
    message_state: MessageState
    context_token: string
    item_list: WireMessageItem[]
  }
  base_info: BaseInfo
}

export interface SendTypingRequest {
  ilink_user_id: string
  typing_ticket: string
  status: 1 | 2
  base_info: BaseInfo
}

export interface GetConfigResponse {
  typing_ticket?: string
  ret?: number
  errcode?: number
  errmsg?: string
}

export interface QrCodeResponse {
  qrcode: string
  qrcode_img_content: string
}

export interface QrStatusResponse {
  status: 'wait' | 'scaned' | 'confirmed' | 'expired' | 'scaned_but_redirect'
  bot_token?: string
  ilink_bot_id?: string
  ilink_user_id?: string
  baseurl?: string
  /** New host to redirect polling to when status is 'scaned_but_redirect'. */
  redirect_host?: string
}

export interface GetUploadUrlRequest {
  filekey: string
  media_type: MediaType
  to_user_id: string
  rawsize: number
  rawfilemd5: string
  filesize: number
  thumb_rawsize?: number
  thumb_rawfilemd5?: string
  thumb_filesize?: number
  no_need_thumb?: boolean
  aeskey?: string
  base_info: BaseInfo
}

export interface GetUploadUrlResponse {
  upload_param: string
  thumb_upload_param?: string
  /** Complete upload URL returned by server; when set, use directly instead of building from upload_param. */
  upload_full_url?: string
}

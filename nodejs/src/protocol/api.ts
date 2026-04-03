import { randomUUID } from 'node:crypto'
import type { HttpClient } from '../transport/http.js'
import { buildAuthHeaders, buildCommonHeaders } from './headers.js'
import {
  CHANNEL_VERSION,
  MessageItemType,
  MessageState,
  MessageType,
  type BaseInfo,
  type GetConfigResponse,
  type GetUpdatesResponse,
  type GetUploadUrlRequest,
  type GetUploadUrlResponse,
  type QrCodeResponse,
  type QrStatusResponse,
  type SendMessageRequest,
  type WireMessageItem,
} from './types.js'

function baseInfo(): BaseInfo {
  return { channel_version: CHANNEL_VERSION }
}

/**
 * Low-level iLink API calls.
 * Each method maps 1:1 to an API endpoint.
 * No business logic — just wire protocol.
 */
export class ILinkApi {
  constructor(private readonly http: HttpClient) {}

  // ── Auth ──────────────────────────────────────────────────────────────

  async getQrCode(baseUrl: string): Promise<QrCodeResponse> {
    return this.http.apiGet<QrCodeResponse>(
      baseUrl,
      '/ilink/bot/get_bot_qrcode?bot_type=3',
      buildCommonHeaders(),
    )
  }

  async pollQrStatus(baseUrl: string, qrcode: string): Promise<QrStatusResponse> {
    return this.http.apiGet<QrStatusResponse>(
      baseUrl,
      `/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
      buildCommonHeaders(),
    )
  }

  // ── Messages ──────────────────────────────────────────────────────────

  async getUpdates(
    baseUrl: string,
    token: string,
    cursor: string,
    signal?: AbortSignal,
  ): Promise<GetUpdatesResponse> {
    return this.http.apiPost<GetUpdatesResponse>(
      baseUrl,
      '/ilink/bot/getupdates',
      { get_updates_buf: cursor, base_info: baseInfo() },
      buildAuthHeaders(token),
      { timeoutMs: 40_000, signal },
    )
  }

  async sendMessage(
    baseUrl: string,
    token: string,
    msg: SendMessageRequest['msg'],
  ): Promise<Record<string, unknown>> {
    return this.http.apiPost<Record<string, unknown>>(
      baseUrl,
      '/ilink/bot/sendmessage',
      { msg, base_info: baseInfo() },
      buildAuthHeaders(token),
    )
  }

  // ── Typing ────────────────────────────────────────────────────────────

  async getConfig(
    baseUrl: string,
    token: string,
    userId: string,
    contextToken: string,
  ): Promise<GetConfigResponse> {
    return this.http.apiPost<GetConfigResponse>(
      baseUrl,
      '/ilink/bot/getconfig',
      { ilink_user_id: userId, context_token: contextToken, base_info: baseInfo() },
      buildAuthHeaders(token),
    )
  }

  async sendTyping(
    baseUrl: string,
    token: string,
    userId: string,
    ticket: string,
    status: 1 | 2,
  ): Promise<Record<string, unknown>> {
    return this.http.apiPost<Record<string, unknown>>(
      baseUrl,
      '/ilink/bot/sendtyping',
      { ilink_user_id: userId, typing_ticket: ticket, status, base_info: baseInfo() },
      buildAuthHeaders(token),
    )
  }

  // ── Media ─────────────────────────────────────────────────────────────

  async getUploadUrl(
    baseUrl: string,
    token: string,
    params: Omit<GetUploadUrlRequest, 'base_info'>,
  ): Promise<GetUploadUrlResponse> {
    return this.http.apiPost<GetUploadUrlResponse>(
      baseUrl,
      '/ilink/bot/getuploadurl',
      { ...params, base_info: baseInfo() },
      buildAuthHeaders(token),
    )
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  buildTextMessagePayload(
    userId: string,
    contextToken: string,
    text: string,
  ): SendMessageRequest['msg'] {
    return {
      from_user_id: '',
      to_user_id: userId,
      client_id: randomUUID(),
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      context_token: contextToken,
      item_list: [{ type: MessageItemType.TEXT, text_item: { text } }],
    }
  }

  buildMediaMessagePayload(
    userId: string,
    contextToken: string,
    items: WireMessageItem[],
  ): SendMessageRequest['msg'] {
    return {
      from_user_id: '',
      to_user_id: userId,
      client_id: randomUUID(),
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      context_token: contextToken,
      item_list: items,
    }
  }
}

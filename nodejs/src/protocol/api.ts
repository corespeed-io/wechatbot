import { randomUUID } from 'node:crypto'
import type { HttpClient } from '../transport/http.js'
import { sanitizeBotAgent } from './bot-agent.js'
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

/**
 * Low-level iLink API calls.
 * Each method maps 1:1 to an API endpoint.
 * No business logic — just wire protocol.
 */
export class ILinkApi {
  private readonly botAgent: string

  constructor(
    private readonly http: HttpClient,
    botAgent?: string,
  ) {
    this.botAgent = sanitizeBotAgent(botAgent)
  }

  private baseInfo(): BaseInfo {
    return { channel_version: CHANNEL_VERSION, bot_agent: this.botAgent }
  }

  // ── Auth ──────────────────────────────────────────────────────────────

  /**
   * Request a login QR code.
   * `localTokenList` carries up to 10 known local bot tokens (newest first) so
   * the server can answer `binded_redirect` for an already-bound bot instead
   * of issuing a duplicate session.
   */
  async getQrCode(baseUrl: string, localTokenList: string[] = []): Promise<QrCodeResponse> {
    return this.http.apiPost<QrCodeResponse>(
      baseUrl,
      '/ilink/bot/get_bot_qrcode?bot_type=3',
      { local_token_list: localTokenList },
      buildCommonHeaders(),
    )
  }

  /**
   * Poll the QR scan status.
   * `verifyCode` submits a pairing code after the server answered
   * `need_verifycode` (the digits shown in WeChat on the user's phone).
   */
  async pollQrStatus(
    baseUrl: string,
    qrcode: string,
    verifyCode?: string,
  ): Promise<QrStatusResponse> {
    let path = `/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`
    if (verifyCode) {
      path += `&verify_code=${encodeURIComponent(verifyCode)}`
    }
    return this.http.apiGet<QrStatusResponse>(baseUrl, path, buildCommonHeaders())
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
      { get_updates_buf: cursor, base_info: this.baseInfo() },
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
      { msg, base_info: this.baseInfo() },
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
      { ilink_user_id: userId, context_token: contextToken, base_info: this.baseInfo() },
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
      { ilink_user_id: userId, typing_ticket: ticket, status, base_info: this.baseInfo() },
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
      { ...params, base_info: this.baseInfo() },
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

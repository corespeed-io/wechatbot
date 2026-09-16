/**
 * Base error class for all SDK errors.
 * Provides structured error info for programmatic handling.
 */
export class WeChatBotError extends Error {
  readonly code: string

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'WeChatBotError'
    this.code = code
  }
}

/**
 * API-level error returned by iLink server.
 */
export class ApiError extends WeChatBotError {
  readonly httpStatus: number
  readonly errcode?: number
  readonly payload?: unknown

  constructor(
    message: string,
    options: { httpStatus: number; errcode?: number; payload?: unknown },
  ) {
    super('API_ERROR', message)
    this.name = 'ApiError'
    this.httpStatus = options.httpStatus
    this.errcode = options.errcode
    this.payload = options.payload
  }

  get isSessionExpired(): boolean {
    return this.errcode === -14
  }
}

/**
 * Authentication errors (QR expired, login failed, etc.)
 */
export class AuthError extends WeChatBotError {
  constructor(message: string, options?: ErrorOptions) {
    super('AUTH_ERROR', message, options)
    this.name = 'AuthError'
  }
}

/**
 * No context_token available for a user.
 */
export class NoContextError extends WeChatBotError {
  readonly userId: string

  constructor(userId: string) {
    super(
      'NO_CONTEXT',
      `No context_token cached for user ${userId}. A message from this user must be received first.`,
    )
    this.name = 'NoContextError'
    this.userId = userId
  }
}

/**
 * Media processing errors (encryption, upload, download).
 */
export class MediaError extends WeChatBotError {
  constructor(message: string, options?: ErrorOptions) {
    super('MEDIA_ERROR', message, options)
    this.name = 'MediaError'
  }
}

/**
 * Transport-level errors: network failures, timeouts, and malformed/
 * non-JSON responses.
 */
export class TransportError extends WeChatBotError {
  /**
   * Whether the failed request is safe to retry. Network failures and 5xx/429
   * (including non-JSON gateway responses) are retryable; definitive 4xx
   * responses are not.
   */
  readonly retryable: boolean

  constructor(message: string, options?: ErrorOptions & { retryable?: boolean }) {
    super('TRANSPORT_ERROR', message, options)
    this.name = 'TransportError'
    this.retryable = options?.retryable ?? true
  }
}

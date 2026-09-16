import { ApiError, TransportError } from '../core/errors.js'
import type { Logger } from '../logger/types.js'
import type { HttpRequestOptions, HttpResponse, RetryPolicy } from './types.js'

const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 2,
  baseDelayMs: 1_000,
  maxDelayMs: 10_000,
  isRetryable: (error: unknown) => {
    if (error instanceof ApiError) return false // API errors are definitive
    if (error instanceof TransportError) return error.retryable
    if (error instanceof Error) {
      return error.name === 'AbortError' || error.name === 'TimeoutError'
    }
    return false
  },
}

/**
 * HTTP client with timeout, retry, and structured error extraction.
 * Uses Node.js 22 built-in fetch — zero runtime dependencies.
 */
export class HttpClient {
  private readonly retryPolicy: RetryPolicy
  private readonly logger: Logger

  constructor(options: { logger: Logger; retryPolicy?: Partial<RetryPolicy> }) {
    this.logger = options.logger.child('http')
    this.retryPolicy = { ...DEFAULT_RETRY_POLICY, ...options.retryPolicy }
  }

  /**
   * Execute an HTTP request with retries.
   */
  async request<T>(options: HttpRequestOptions): Promise<HttpResponse<T>> {
    let lastError: unknown

    for (let attempt = 0; attempt <= this.retryPolicy.maxRetries; attempt++) {
      try {
        return await this.executeRequest<T>(options)
      } catch (error) {
        lastError = error

        if (attempt < this.retryPolicy.maxRetries && this.retryPolicy.isRetryable(error)) {
          const delay = Math.min(
            this.retryPolicy.baseDelayMs * 2 ** attempt,
            this.retryPolicy.maxDelayMs,
          )
          this.logger.debug(`Retry ${attempt + 1}/${this.retryPolicy.maxRetries} in ${delay}ms`, {
            url: options.url,
          })
          await sleep(delay)
          continue
        }

        throw error
      }
    }

    throw lastError
  }

  /**
   * Execute a JSON POST to the iLink API.
   * Handles the iLink-specific `ret` / `errcode` error format.
   */
  async apiPost<T>(
    baseUrl: string,
    endpoint: string,
    body: unknown,
    headers: Record<string, string>,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<T> {
    const url = new URL(endpoint, normalizeBaseUrl(baseUrl)).toString()
    const response = await this.request<T>({
      method: 'POST',
      url,
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
      timeoutMs: options?.timeoutMs ?? 15_000,
      signal: options?.signal,
    })
    return response.data
  }

  /**
   * Execute a GET request to the iLink API.
   */
  async apiGet<T>(
    baseUrl: string,
    path: string,
    headers?: Record<string, string>,
  ): Promise<T> {
    const url = new URL(path, normalizeBaseUrl(baseUrl)).toString()
    const response = await this.request<T>({
      method: 'GET',
      url,
      headers,
      timeoutMs: 15_000,
    })
    return response.data
  }

  private async executeRequest<T>(options: HttpRequestOptions): Promise<HttpResponse<T>> {
    const { method, url, headers, body, timeoutMs = 15_000, signal } = options

    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal

    let response: Response
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: requestSignal,
      })
    } catch (error) {
      if (isAbortError(error)) throw error
      throw new TransportError(
        `Network error: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }

    const text = await response.text()
    const data = parseJsonBody(text, { status: response.status, method, url })

    // Check HTTP status
    if (!response.ok) {
      const message =
        errmsgOf(data) ??
        `HTTP ${response.status} from ${method} ${url}`
      throw new ApiError(message, {
        httpStatus: response.status,
        errcode: errcodeOf(data),
        payload: data,
      })
    }

    // Check iLink business-level errors (ret !== 0 or errcode !== 0)
    const ret = typeof data.ret === 'number' ? data.ret : undefined
    const errcode = errcodeOf(data)
    if ((ret !== undefined && ret !== 0) || (errcode !== undefined && errcode !== 0)) {
      const code = errcode ?? ret ?? 0
      const errmsg = errmsgOf(data) ?? `API error ret=${ret} errcode=${errcode}`
      throw new ApiError(errmsg, {
        httpStatus: response.status,
        errcode: code,
        payload: data,
      })
    }

    // Extract response headers
    const responseHeaders: Record<string, string> = {}
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value
    })

    return {
      status: response.status,
      headers: responseHeaders,
      data: data as T,
      raw: response,
    }
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '') + '/'
}

/**
 * Parse a response body as JSON, tolerating the quirks of real gateways:
 * a leading UTF-8 BOM, and empty/whitespace-only bodies. Anything else that
 * isn't JSON becomes a `TransportError` (instead of a raw `SyntaxError`) that
 * carries whether the request is worth retrying.
 */
function parseJsonBody(
  text: string,
  ctx: { status: number; method: string; url: string },
): Record<string, unknown> {
  const clean = text.startsWith('\uFEFF') ? text.slice(1) : text
  if (clean.trim() === '') return {}

  try {
    const parsed = JSON.parse(clean)
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {}
  } catch (error) {
    const retryable =
      ctx.status === 408 ||
      ctx.status === 429 ||
      ctx.status >= 500 ||
      (ctx.status >= 200 && ctx.status < 300)
    const snippet = clean.slice(0, 120).replace(/\s+/g, ' ')
    throw new TransportError(
      `Non-JSON response (HTTP ${ctx.status}) from ${ctx.method} ${ctx.url}: ${snippet}`,
      { cause: error, retryable },
    )
  }
}

function errmsgOf(data: Record<string, unknown>): string | undefined {
  return typeof data.errmsg === 'string' ? data.errmsg : undefined
}

function errcodeOf(data: Record<string, unknown>): number | undefined {
  return typeof data.errcode === 'number' ? data.errcode : undefined
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

export { isAbortError }

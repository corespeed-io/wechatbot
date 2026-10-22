export interface HttpRequestOptions {
  method: 'GET' | 'POST'
  url: string
  headers?: Record<string, string>
  body?: unknown
  timeoutMs?: number
  signal?: AbortSignal
  /** Retry transient transport and timeout failures. Defaults to false. */
  retry?: boolean
}

export interface HttpResponse<T = unknown> {
  status: number
  headers: Record<string, string>
  data: T
  raw: Response
}

export interface RetryPolicy {
  maxRetries: number
  baseDelayMs: number
  maxDelayMs: number
  /** Return true if the error is retryable */
  isRetryable: (error: unknown) => boolean
}

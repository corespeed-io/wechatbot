import { describe, it, expect, vi, afterEach } from 'vitest'
import { HttpClient } from '../src/transport/http.js'
import { ApiError, TransportError } from '../src/core/errors.js'
import { createLogger } from '../src/logger/logger.js'

const logger = createLogger({ level: 'silent' })

/** Fast retries so retry-path tests don't sleep for seconds. */
const client = () =>
  new HttpClient({ logger, retryPolicy: { baseDelayMs: 1, maxDelayMs: 2 } })

function mockResponse(body: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    text: async () => body,
  } as unknown as Response
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('HttpClient response parsing', () => {
  it('parses a normal JSON body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockResponse('{"ret":0,"msgs":[]}')))
    await expect(client().apiGet('https://api.test', '/x')).resolves.toEqual({
      ret: 0,
      msgs: [],
    })
  })

  it('tolerates a leading UTF-8 BOM', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockResponse('\uFEFF{"ret":0}')))
    await expect(client().apiGet('https://api.test', '/x')).resolves.toEqual({ ret: 0 })
  })

  it('treats an empty body as an empty object', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockResponse('')))
    await expect(client().apiGet('https://api.test', '/x')).resolves.toEqual({})
  })

  it('treats a JSON null body as an empty object', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockResponse('null')))
    await expect(client().apiGet('https://api.test', '/x')).resolves.toEqual({})
  })

  it('maps iLink errcode to a non-retryable ApiError', async () => {
    const fetchMock = vi.fn(async () => mockResponse('{"ret":0,"errcode":-14,"errmsg":"expired"}'))
    vi.stubGlobal('fetch', fetchMock)
    await expect(client().apiGet('https://api.test', '/x')).rejects.toBeInstanceOf(ApiError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries a non-JSON 5xx response and then gives up', async () => {
    const fetchMock = vi.fn(async () => mockResponse('<html>502 Bad Gateway</html>', 502))
    vi.stubGlobal('fetch', fetchMock)
    const error = await client()
      .apiGet('https://api.test', '/x')
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(TransportError)
    expect((error as TransportError).retryable).toBe(true)
    // maxRetries = 2 → 3 attempts
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('does not retry a non-JSON 4xx response', async () => {
    const fetchMock = vi.fn(async () => mockResponse('nope', 400))
    vi.stubGlobal('fetch', fetchMock)
    const error = await client()
      .apiGet('https://api.test', '/x')
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(TransportError)
    expect((error as TransportError).retryable).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries a transient network failure', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
    vi.stubGlobal('fetch', fetchMock)
    await expect(client().apiGet('https://api.test', '/x')).rejects.toBeInstanceOf(TransportError)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})

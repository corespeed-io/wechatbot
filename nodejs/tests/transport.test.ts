import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLogger } from '../src/logger/logger.js'
import { ILinkApi } from '../src/protocol/api.js'
import { HttpClient } from '../src/transport/http.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('iLink request retries', () => {
  it('retries an opted-in read-only POST after a timeout', async () => {
    let attempts = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      attempts++
      if (attempts === 1) throw new DOMException('request timed out', 'TimeoutError')
      return Response.json({ typing_ticket: 'ticket' })
    }))

    const api = new ILinkApi(createHttpClient())
    const result = await api.getConfig('https://wechat.test', 'token', 'user', 'context')

    expect(result.typing_ticket).toBe('ticket')
    expect(attempts).toBe(2)
  })

  it('retries QR status queries after a timeout', async () => {
    let attempts = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      attempts++
      if (attempts === 1) throw new DOMException('request timed out', 'TimeoutError')
      return Response.json({ status: 'wait' })
    }))

    const api = new ILinkApi(createHttpClient())
    const result = await api.pollQrStatus('https://wechat.test', 'qr-token')

    expect(result.status).toBe('wait')
    expect(attempts).toBe(2)
  })

  it('does not retry sendMessage after an ambiguous timeout', async () => {
    let attempts = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      attempts++
      throw new DOMException('request timed out', 'TimeoutError')
    }))

    const api = new ILinkApi(createHttpClient())
    const message = api.buildTextMessagePayload('user', 'context', 'hello')

    await expect(api.sendMessage('https://wechat.test', 'token', message))
      .rejects.toMatchObject({ name: 'TimeoutError' })
    expect(attempts).toBe(1)
  })

  it('leaves getUpdates retries to the poller', async () => {
    let attempts = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      attempts++
      throw new DOMException('long poll timed out', 'TimeoutError')
    }))

    const api = new ILinkApi(createHttpClient())

    await expect(api.getUpdates('https://wechat.test', 'token', 'committed-cursor'))
      .rejects.toMatchObject({ name: 'TimeoutError' })
    expect(attempts).toBe(1)
  })

  it('retries opted-in transport errors', async () => {
    let attempts = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      attempts++
      if (attempts === 1) throw new TypeError('connection reset')
      return Response.json({ status: 'wait' })
    }))

    const api = new ILinkApi(createHttpClient())
    const result = await api.pollQrStatus('https://wechat.test', 'qr-token')

    expect(result.status).toBe('wait')
    expect(attempts).toBe(2)
  })
})

function createHttpClient(): HttpClient {
  return new HttpClient({
    logger: createLogger({ level: 'silent' }),
    retryPolicy: { baseDelayMs: 0, maxDelayMs: 0 },
  })
}

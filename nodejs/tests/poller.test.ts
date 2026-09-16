import { describe, it, expect, vi } from 'vitest'
import { MessagePoller } from '../src/messaging/poller.js'
import { MemoryStorage } from '../src/storage/memory.js'
import { STORAGE_KEYS } from '../src/storage/interface.js'
import { createLogger } from '../src/logger/logger.js'
import type { ILinkApi } from '../src/protocol/api.js'
import type { GetUpdatesResponse } from '../src/protocol/types.js'

const logger = createLogger({ level: 'silent' })

function fakeApi(
  handler: (cursor: string) => Promise<GetUpdatesResponse>,
): ILinkApi {
  return {
    getUpdates: (_baseUrl: string, _token: string, cursor: string) => handler(cursor),
  } as unknown as ILinkApi
}

/** Run the poll loop briefly, capturing the cursor values sent to the server. */
async function captureCursors(
  storage: MemoryStorage,
  runForMs = 40,
): Promise<string[]> {
  const seen: string[] = []
  const api = fakeApi(async (cursor) => {
    seen.push(cursor)
    await new Promise((r) => setTimeout(r, 5))
    return { ret: 0, msgs: [], get_updates_buf: cursor }
  })
  const poller = new MessagePoller(api, storage, logger)
  await poller.loadCursor()
  const run = poller.start('https://api.test', 'token')
  await new Promise((r) => setTimeout(r, runForMs))
  poller.stop()
  await run
  return seen
}

describe('MessagePoller cursor handling', () => {
  it('resumes from the persisted cursor', async () => {
    const storage = new MemoryStorage()
    await storage.set(STORAGE_KEYS.CURSOR, 'persisted-cursor')
    expect((await captureCursors(storage))[0]).toBe('persisted-cursor')
  })

  it('starts fresh when no cursor is stored', async () => {
    expect((await captureCursors(new MemoryStorage()))[0]).toBe('')
  })

  it('ignores a non-string persisted cursor', async () => {
    const storage = new MemoryStorage()
    await storage.set(STORAGE_KEYS.CURSOR, { corrupt: true })
    expect((await captureCursors(storage))[0]).toBe('')
  })

  it('does not throw when the storage backend fails on load', async () => {
    const storage = new MemoryStorage()
    vi.spyOn(storage, 'get').mockRejectedValue(new Error('boom'))
    const poller = new MessagePoller(fakeApi(async () => ({ ret: 0, msgs: [], get_updates_buf: '' })), storage, logger)
    await expect(poller.loadCursor()).resolves.toBeUndefined()
  })

  it('persists the cursor returned by the server', async () => {
    const storage = new MemoryStorage()
    let n = 0
    const api = fakeApi(async () => {
      n++
      await new Promise((r) => setTimeout(r, 5))
      return { ret: 0, msgs: [], get_updates_buf: `buf-${n}` }
    })
    const poller = new MessagePoller(api, storage, logger)
    const run = poller.start('https://api.test', 'token')
    await new Promise((r) => setTimeout(r, 40))
    poller.stop()
    await run
    expect(await storage.get(STORAGE_KEYS.CURSOR)).toMatch(/^buf-\d+$/)
  })

  it('keeps polling when cursor persistence fails', async () => {
    const storage = new MemoryStorage()
    vi.spyOn(storage, 'set').mockRejectedValue(new Error('disk full'))
    const seen = await captureCursors(storage)
    expect(seen.length).toBeGreaterThan(1)
  })
})

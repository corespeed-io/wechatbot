import { describe, expect, it, vi } from 'vitest'
import { createLogger } from '../src/logger/logger.js'
import type { ILinkApi } from '../src/protocol/api.js'
import { MemoryStorage } from '../src/storage/memory.js'
import { STORAGE_KEYS } from '../src/storage/interface.js'
import { MessagePoller } from '../src/messaging/poller.js'

describe('MessagePoller cursor retry behavior', () => {
  it('retries a timed-out getUpdates request with the last committed cursor', async () => {
    const storage = new MemoryStorage()
    await storage.set(STORAGE_KEYS.CURSOR, 'committed-cursor')
    const cursors: string[] = []
    let attempts = 0
    let poller: MessagePoller
    const api = {
      getUpdates: vi.fn(async (_baseUrl: string, _token: string, cursor: string) => {
        cursors.push(cursor)
        if (attempts++ === 0) {
          throw new DOMException('long poll timed out', 'TimeoutError')
        }
        poller.stop()
        return { ret: 0, msgs: [], get_updates_buf: 'next-cursor' }
      }),
    }
    poller = new MessagePoller(
      api as unknown as ILinkApi,
      storage,
      createLogger({ level: 'silent' }),
    )
    await poller.loadCursor()

    await poller.start('https://wechat.test', 'token')

    expect(cursors).toEqual(['committed-cursor', 'committed-cursor'])
    expect(await storage.get(STORAGE_KEYS.CURSOR)).toBe('next-cursor')
  })

  it('does not advance the in-memory cursor until persistence succeeds', async () => {
    class FailingCursorStorage extends MemoryStorage {
      private failCursorWrite = false

      failNextCursorWrite(): void {
        this.failCursorWrite = true
      }

      override async set<T>(key: string, value: T): Promise<void> {
        if (key === STORAGE_KEYS.CURSOR && this.failCursorWrite) {
          this.failCursorWrite = false
          throw new Error('simulated cursor persistence failure')
        }
        await super.set(key, value)
      }
    }

    const storage = new FailingCursorStorage()
    await storage.set(STORAGE_KEYS.CURSOR, 'committed-cursor')
    storage.failNextCursorWrite()
    const cursors: string[] = []
    let poller: MessagePoller
    const api = {
      getUpdates: vi.fn(async (_baseUrl: string, _token: string, cursor: string) => {
        cursors.push(cursor)
        if (cursors.length === 2) poller.stop()
        return { ret: 0, msgs: [], get_updates_buf: 'next-cursor' }
      }),
    }
    poller = new MessagePoller(
      api as unknown as ILinkApi,
      storage,
      createLogger({ level: 'silent' }),
    )
    await poller.loadCursor()

    await poller.start('https://wechat.test', 'token')

    expect(cursors).toEqual(['committed-cursor', 'committed-cursor'])
    expect(await storage.get(STORAGE_KEYS.CURSOR)).toBe('next-cursor')
  })
})

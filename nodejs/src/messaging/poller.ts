import { setTimeout as delay } from 'node:timers/promises'
import { ApiError } from '../core/errors.js'
import { TypedEmitter } from '../core/events.js'
import type { Logger } from '../logger/types.js'
import type { ILinkApi } from '../protocol/api.js'
import type { WireMessage } from '../protocol/types.js'
import type { Storage } from '../storage/interface.js'
import { STORAGE_KEYS } from '../storage/interface.js'
import { isAbortError } from '../transport/http.js'

type PollerEventMap = {
  messages: [messages: WireMessage[]]
  'session:expired': []
  error: [error: unknown]
}

/**
 * Isolated long-poll loop.
 * Emits `messages` events with batches of wire messages.
 * Handles cursor management, exponential backoff, and session expiry detection.
 */
export class MessagePoller extends TypedEmitter<PollerEventMap> {
  private cursor = ''
  private stopped = true
  private pollController: AbortController | null = null
  private readonly logger: Logger

  constructor(
    private readonly api: ILinkApi,
    private readonly storage: Storage,
    logger: Logger,
  ) {
    super()
    this.logger = logger.child('poller')
  }

  /** Load persisted cursor from storage. Never throws — a missing or corrupt
   * persisted cursor just means we start from scratch. */
  async loadCursor(): Promise<void> {
    try {
      const stored = await this.storage.get<string>(STORAGE_KEYS.CURSOR)
      if (typeof stored === 'string' && stored.length > 0) {
        this.cursor = stored
        this.logger.debug('Loaded cursor from storage')
      }
    } catch (error) {
      this.logger.warn(
        `Failed to load persisted cursor, starting fresh: ${error instanceof Error ? error.message : String(error)}`,
      )
      this.cursor = ''
      await this.storage.delete(STORAGE_KEYS.CURSOR).catch(() => {})
    }
  }

  /** Reset cursor (e.g. on re-login). */
  async resetCursor(): Promise<void> {
    this.cursor = ''
    await this.storage.delete(STORAGE_KEYS.CURSOR)
  }

  /** Start the long-poll loop. */
  async start(baseUrl: string, token: string): Promise<void> {
    if (!this.stopped) return
    this.stopped = false
    this.logger.info('Long-poll loop starting')

    let retryDelayMs = 1_000

    while (!this.stopped) {
      try {
        this.pollController = new AbortController()
        const updates = await this.api.getUpdates(
          baseUrl,
          token,
          this.cursor,
          this.pollController.signal,
        )
        this.pollController = null

        // Update cursor
        const nextCursor = updates.get_updates_buf
        if (typeof nextCursor === 'string' && nextCursor && nextCursor !== this.cursor) {
          this.cursor = nextCursor
          // Persist cursor asynchronously — don't block the poll loop
          this.storage.set(STORAGE_KEYS.CURSOR, this.cursor).catch((error) => {
            this.logger.warn(
              `Failed to persist cursor: ${error instanceof Error ? error.message : String(error)}`,
            )
          })
        }

        retryDelayMs = 1_000

        // Emit messages if any
        if (updates.msgs?.length > 0) {
          this.emit('messages', updates.msgs)
        }
      } catch (error) {
        this.pollController = null

        if (this.stopped && isAbortError(error)) {
          break
        }

        if (error instanceof ApiError && error.isSessionExpired) {
          this.logger.warn('Session expired — emitting session:expired')
          this.emit('session:expired')
          // Pause until the client handles re-login
          await delay(2_000)
          continue
        }

        if (!isAbortError(error)) {
          this.logger.error(`Poll error: ${error instanceof Error ? error.message : String(error)}`)
          this.emit('error', error)
        }

        await delay(retryDelayMs)
        retryDelayMs = Math.min(retryDelayMs * 2, 10_000)
      }
    }

    this.logger.info('Long-poll loop stopped')
  }

  /** Stop the poll loop. */
  stop(): void {
    this.stopped = true
    this.pollController?.abort()
    this.pollController = null
  }

  get isRunning(): boolean {
    return !this.stopped
  }
}

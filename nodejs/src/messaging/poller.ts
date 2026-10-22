import { setTimeout as delay } from 'node:timers/promises'
import { ApiError } from '../core/errors.js'
import { TypedEmitter } from '../core/events.js'
import type { Logger } from '../logger/types.js'
import type { ILinkApi } from '../protocol/api.js'
import type { WireMessage } from '../protocol/types.js'
import type { Storage } from '../storage/interface.js'
import { STORAGE_KEYS } from '../storage/interface.js'

type PollerEventMap = {
  success: []
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
  private readonly signal?: AbortSignal

  constructor(
    private readonly api: ILinkApi,
    private readonly storage: Storage,
    logger: Logger,
    signal?: AbortSignal,
  ) {
    super()
    this.logger = logger.child('poller')
    this.signal = signal
  }

  /** Load persisted cursor from storage. */
  async loadCursor(): Promise<void> {
    const stored = await this.storage.get<string>(STORAGE_KEYS.CURSOR)
    if (stored) {
      this.cursor = stored
      this.logger.debug('Loaded cursor from storage')
    }
  }

  /** Reset cursor (e.g. on re-login). */
  async resetCursor(): Promise<void> {
    this.cursor = ''
    await this.storage.delete(STORAGE_KEYS.CURSOR)
  }

  /** Start the long-poll loop. */
  async start(baseUrl: string, token: string): Promise<void> {
    this.signal?.throwIfAborted()
    if (!this.stopped) return
    this.stopped = false
    this.logger.info('Long-poll loop starting')

    let retryDelayMs = 1_000

    while (!this.stopped && !this.signal?.aborted) {
      try {
        this.pollController = new AbortController()
        const updates = await this.api.getUpdates(
          baseUrl,
          token,
          this.cursor,
          this.pollController.signal,
        )
        this.pollController = null

        // Process the batch before committing its cursor so failures replay it.
        if (updates.msgs?.length > 0) {
          await this.emitAsync('messages', updates.msgs)
        }

        if (updates.get_updates_buf) {
          await this.storage.set(STORAGE_KEYS.CURSOR, updates.get_updates_buf)
          this.cursor = updates.get_updates_buf
        }

        retryDelayMs = 1_000
        this.emit('success')
      } catch (error) {
        this.pollController = null

        if (this.stopped || this.signal?.aborted) {
          break
        }

        if (error instanceof ApiError && error.isSessionExpired) {
          this.logger.warn('Session expired — emitting session:expired')
          this.emit('session:expired')
          if (this.stopped) break
          // Pause until the client handles re-login
          try {
            await delay(2_000, undefined, { signal: this.signal })
          } catch (error) {
            if (!this.signal?.aborted) throw error
            break
          }
          continue
        }

        this.logger.error(`Poll error: ${error instanceof Error ? error.message : String(error)}`)
        this.emit('error', error)
        if (this.stopped) break

        try {
          await delay(retryDelayMs, undefined, { signal: this.signal })
        } catch (error) {
          if (!this.signal?.aborted) throw error
          break
        }
        retryDelayMs = Math.min(retryDelayMs * 2, 10_000)
      }
    }

    this.stopped = true
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

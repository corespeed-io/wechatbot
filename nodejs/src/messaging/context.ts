import type { Logger } from '../logger/types.js'
import { MessageType, type WireMessage } from '../protocol/types.js'
import type { Storage } from '../storage/interface.js'
import { STORAGE_KEYS } from '../storage/interface.js'

/**
 * Manages context_token lifecycle.
 * Tokens are cached in-memory for speed and persisted to storage for restart survival.
 */
export class ContextStore {
  private readonly tokens = new Map<string, string>()
  private readonly logger: Logger
  private dirty = false

  constructor(
    private readonly storage: Storage,
    logger: Logger,
  ) {
    this.logger = logger.child('context')
  }

  /** Load persisted context tokens from storage. Never throws — a missing or
   * corrupt file just means the cache starts empty. */
  async load(): Promise<void> {
    let stored: Record<string, string> | undefined
    try {
      stored = await this.storage.get<Record<string, string>>(STORAGE_KEYS.CONTEXT_TOKENS)
    } catch (error) {
      this.logger.warn(
        `Failed to load context tokens: ${error instanceof Error ? error.message : String(error)}`,
      )
      return
    }
    if (!stored || typeof stored !== 'object') return
    for (const [k, v] of Object.entries(stored)) {
      if (typeof v === 'string') this.tokens.set(k, v)
    }
    this.logger.debug(`Loaded ${this.tokens.size} context tokens from storage`)
  }

  /** Get the cached context_token for a user. */
  get(userId: string): string | undefined {
    return this.tokens.get(userId)
  }

  /** Cache a context_token for a user. */
  set(userId: string, token: string): void {
    this.tokens.set(userId, token)
    this.dirty = true
  }

  /** Extract and cache context_token from a wire message. */
  remember(message: WireMessage): void {
    const userId =
      message.message_type === MessageType.USER
        ? message.from_user_id
        : message.to_user_id
    if (userId && message.context_token) {
      this.set(userId, message.context_token)
    }
  }

  /** Persist dirty tokens to storage. */
  async flush(): Promise<void> {
    if (!this.dirty) return
    const obj = Object.fromEntries(this.tokens)
    await this.storage.set(STORAGE_KEYS.CONTEXT_TOKENS, obj)
    this.dirty = false
  }

  /** Clear all tokens from memory and storage. */
  async clear(): Promise<void> {
    this.tokens.clear()
    this.dirty = false
    await this.storage.delete(STORAGE_KEYS.CONTEXT_TOKENS)
  }
}

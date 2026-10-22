import type { IncomingMessage } from '../message/types.js'
import type { Credentials } from '../auth/types.js'

/**
 * Strongly-typed event map for WeChatBot.
 * Using mapped types ensures type safety for on/emit.
 */
export type BotEventMap = {
  /** Fired when a user message is received (after middleware). */
  message: [message: IncomingMessage]
  /** Fired when login completes. */
  login: [credentials: Credentials]
  /** Fired when the active session expires. */
  'session:expired': []
  /** Fired when re-login completes after session expiry. */
  'session:restored': [credentials: Credentials]
  /** Fired when the long-poll loop starts. */
  'poll:start': []
  /** Fired after a successful poll, message processing, and cursor persistence. */
  'poll:success': []
  /** Fired when the long-poll loop stops. */
  'poll:stop': []
  /** Fired on recoverable errors. */
  error: [error: unknown]
  /** Fired when the bot is fully stopped. */
  close: []
}

type Listener<Args extends unknown[]> = (...args: Args) => void | Promise<void>

/**
 * Minimal typed event emitter — no external dependencies.
 */
export class TypedEmitter<EventMap extends { [K: string]: unknown[] } = { [K: string]: unknown[] }> {
  private readonly listeners = new Map<keyof EventMap, Set<Listener<any>>>()

  on<K extends keyof EventMap>(event: K, listener: Listener<EventMap[K]>): this {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(listener)
    return this
  }

  off<K extends keyof EventMap>(event: K, listener: Listener<EventMap[K]>): this {
    this.listeners.get(event)?.delete(listener)
    return this
  }

  once<K extends keyof EventMap>(event: K, listener: Listener<EventMap[K]>): this {
    const wrapper: Listener<EventMap[K]> = (...args) => {
      this.off(event, wrapper)
      return listener(...args)
    }
    return this.on(event, wrapper)
  }

  emit<K extends keyof EventMap>(event: K, ...args: EventMap[K]): void {
    const set = this.listeners.get(event)
    if (!set) return
    for (const listener of set) {
      try {
        const result = listener(...args)
        // Swallow promise rejections on fire-and-forget events
        if (result && typeof (result as Promise<void>).catch === 'function') {
          ;(result as Promise<void>).catch(() => {})
        }
      } catch {
        // Listener threw synchronously — swallow to avoid breaking emit loop
      }
    }
  }

  /** Await listeners when the producer must not continue before they finish. */
  async emitAsync<K extends keyof EventMap>(event: K, ...args: EventMap[K]): Promise<void> {
    const set = this.listeners.get(event)
    if (!set) return
    for (const listener of set) {
      await listener(...args)
    }
  }

  removeAllListeners(event?: keyof EventMap): this {
    if (event) {
      this.listeners.delete(event)
    } else {
      this.listeners.clear()
    }
    return this
  }

  listenerCount(event: keyof EventMap): number {
    return this.listeners.get(event)?.size ?? 0
  }
}

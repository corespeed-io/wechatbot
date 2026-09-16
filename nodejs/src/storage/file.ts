import { mkdir, open, readFile, rename, rm, readdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import type { Storage } from './interface.js'

const DEFAULT_DIR = path.join(os.homedir(), '.wechatbot')

/** Leading UTF-8 byte-order mark, which some editors/tools prepend to JSON files. */
const BOM = '\uFEFF'

/**
 * File-based storage — each key is a JSON file.
 * Credentials and state survive restarts.
 *
 * Robustness guarantees:
 *  - Writes are atomic (temp file + fsync + rename), so a crash mid-write can
 *    never leave a truncated/zero-filled state file behind.
 *  - Writes to the same key are serialized, so overlapping `set()` calls can't
 *    interleave and corrupt the file.
 *  - Reads tolerate a UTF-8 BOM and corrupt/partial files: rather than throwing
 *    (and taking down the whole client on startup), the bad file is quarantined
 *    and treated as absent.
 */
export class FileStorage implements Storage {
  private readonly dir: string
  /** In-flight writes per key, used to serialize concurrent `set()` calls. */
  private readonly pending = new Map<string, Promise<void>>()

  constructor(dir?: string) {
    this.dir = dir ?? DEFAULT_DIR
  }

  async get<T>(key: string): Promise<T | undefined> {
    let raw: string
    try {
      raw = await readFile(this.filePath(key), 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined
      throw err
    }

    const clean = raw.startsWith(BOM) ? raw.slice(1) : raw
    if (clean.trim() === '') return undefined

    try {
      return JSON.parse(clean) as T
    } catch {
      // Corrupt or partially written state file. Preserve it for debugging and
      // treat the key as missing instead of crashing the caller.
      await this.quarantine(key).catch(() => {})
      return undefined
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    const previous = this.pending.get(key) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(() => this.writeAtomic(key, value))
    this.pending.set(key, next)
    try {
      await next
    } finally {
      if (this.pending.get(key) === next) this.pending.delete(key)
    }
  }

  async delete(key: string): Promise<void> {
    // Wait for an in-flight write so it can't resurrect the file we just deleted.
    await this.pending.get(key)?.catch(() => {})
    await rm(this.filePath(key), { force: true })
  }

  async has(key: string): Promise<boolean> {
    try {
      await readFile(this.filePath(key))
      return true
    } catch {
      return false
    }
  }

  async clear(): Promise<void> {
    // Let in-flight writes settle before wiping the directory.
    await Promise.allSettled(this.pending.values())
    this.pending.clear()
    try {
      const files = await readdir(this.dir)
      await Promise.all(
        files
          .filter((f) => f.endsWith('.json'))
          .map((f) => rm(path.join(this.dir, f), { force: true })),
      )
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }

  private filePath(key: string): string {
    // Sanitize key for filesystem safety
    const safe = key.replace(/[^a-zA-Z0-9_-]/g, '_')
    return path.join(this.dir, `${safe}.json`)
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
  }

  /**
   * Write `value` to `key` atomically: serialize to a unique temp file in the
   * same directory, flush it to disk, then rename over the target. Readers see
   * either the old or the new complete file, never a partial one.
   */
  private async writeAtomic(key: string, value: unknown): Promise<void> {
    await this.ensureDir()
    const target = this.filePath(key)
    const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`
    const payload = JSON.stringify(value, null, 2) + '\n'

    try {
      const handle = await open(tmp, 'w', 0o600)
      try {
        await handle.writeFile(payload, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(tmp, target)
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => {})
      throw error
    }
  }

  /** Move a corrupt state file aside so it isn't re-parsed on every read. */
  private async quarantine(key: string): Promise<void> {
    const target = this.filePath(key)
    const backup = `${target}.corrupt-${Date.now()}`
    await rename(target, backup)
  }
}

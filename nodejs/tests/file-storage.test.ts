import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { FileStorage } from '../src/storage/file.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'wechatbot-storage-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const cursorPath = () => path.join(dir, 'cursor.json')

describe('FileStorage', () => {
  it('stores and retrieves values', async () => {
    const store = new FileStorage(dir)
    await store.set('key', { hello: 'world' })
    expect(await store.get('key')).toEqual({ hello: 'world' })
  })

  it('returns undefined for missing keys', async () => {
    const store = new FileStorage(dir)
    expect(await store.get('missing')).toBeUndefined()
  })

  it('round-trips a plain cursor string', async () => {
    const store = new FileStorage(dir)
    await store.set('cursor', 'abc123')
    expect(await store.get('cursor')).toBe('abc123')
  })

  it('ignores a leading UTF-8 BOM when reading', async () => {
    await writeFile(path.join(dir, 'bom.json'), '\uFEFF{"a":1}', 'utf8')
    const store = new FileStorage(dir)
    expect(await store.get('bom')).toEqual({ a: 1 })
  })

  it('treats an empty file as a missing key', async () => {
    await writeFile(path.join(dir, 'empty.json'), '   \n', 'utf8')
    const store = new FileStorage(dir)
    expect(await store.get('empty')).toBeUndefined()
  })

  it('treats a NUL-corrupted file as missing instead of throwing', async () => {
    // Regression: a crashed/overlapping write used to zero-fill cursor.json,
    // which made start() reject with "Unexpected token ... is not valid JSON".
    await writeFile(cursorPath(), Buffer.alloc(107, 0))
    const store = new FileStorage(dir)
    await expect(store.get('cursor')).resolves.toBeUndefined()
  })

  it('quarantines a corrupt file so it is not re-parsed', async () => {
    await writeFile(cursorPath(), 'not json at all')
    const store = new FileStorage(dir)
    await store.get('cursor')
    const files = await readdir(dir)
    expect(files.some((f) => f.startsWith('cursor.json.corrupt-'))).toBe(true)
  })

  it('leaves no temp files behind after set', async () => {
    const store = new FileStorage(dir)
    await store.set('cursor', 'value')
    const files = await readdir(dir)
    expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('serializes concurrent writes to the same key without corruption', async () => {
    const store = new FileStorage(dir)
    await Promise.all(
      Array.from({ length: 50 }, (_, i) => store.set('cursor', `cursor-${i}`)),
    )
    const value = await store.get<string>('cursor')
    expect(typeof value).toBe('string')
    expect(value).toMatch(/^cursor-\d+$/)

    const raw = await readFile(cursorPath(), 'utf8')
    expect(() => JSON.parse(raw)).not.toThrow()
  })

  it('does not recreate a key deleted while a write is pending', async () => {
    const store = new FileStorage(dir)
    const write = store.set('cursor', 'value')
    const del = store.delete('cursor')
    await Promise.all([write, del])
    expect(await store.get('cursor')).toBeUndefined()
  })

  it('clears stored values', async () => {
    const store = new FileStorage(dir)
    await store.set('a', 1)
    await store.set('b', 2)
    await store.clear()
    expect(await store.has('a')).toBe(false)
    expect(await store.has('b')).toBe(false)
  })
})

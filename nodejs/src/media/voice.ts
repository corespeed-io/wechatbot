import type { Logger } from '../logger/types.js'

/** Default sample rate for WeChat voice messages (SILK codec). */
const SILK_SAMPLE_RATE = 24_000

/**
 * Wrap raw PCM s16le bytes into a WAV container.
 * Mono channel, 16-bit signed little-endian.
 */
function pcmToWav(pcm: Uint8Array, sampleRate: number): Buffer {
  const pcmBytes = pcm.byteLength
  const totalSize = 44 + pcmBytes
  const buf = Buffer.allocUnsafe(totalSize)
  let offset = 0

  // RIFF header
  buf.write('RIFF', offset); offset += 4
  buf.writeUInt32LE(totalSize - 8, offset); offset += 4
  buf.write('WAVE', offset); offset += 4

  // fmt subchunk
  buf.write('fmt ', offset); offset += 4
  buf.writeUInt32LE(16, offset); offset += 4     // subchunk1 size
  buf.writeUInt16LE(1, offset); offset += 2      // PCM format
  buf.writeUInt16LE(1, offset); offset += 2      // mono
  buf.writeUInt32LE(sampleRate, offset); offset += 4
  buf.writeUInt32LE(sampleRate * 2, offset); offset += 4  // byte rate
  buf.writeUInt16LE(2, offset); offset += 2      // block align
  buf.writeUInt16LE(16, offset); offset += 2     // bits per sample

  // data subchunk
  buf.write('data', offset); offset += 4
  buf.writeUInt32LE(pcmBytes, offset); offset += 4

  Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).copy(buf, offset)

  return buf
}

/**
 * Transcode SILK audio buffer to WAV.
 *
 * Uses `silk-wasm` for decoding. Returns WAV Buffer on success, or null
 * if silk-wasm is not installed or decoding fails. Callers should fall
 * back to the raw SILK buffer when null is returned.
 *
 * Install silk-wasm for voice support:
 *   npm install silk-wasm
 */
export async function silkToWav(silkBuf: Buffer, logger?: Logger): Promise<Buffer | null> {
  try {
    // silk-wasm is an optional peer dependency — dynamic import to avoid hard failure
    const silkWasm: { decode: (input: Buffer, sampleRate: number) => Promise<{ data: Uint8Array; duration: number }> } =
      await (Function('return import("silk-wasm")')() as Promise<any>)

    logger?.debug('Decoding SILK audio', { size: silkBuf.length })
    const result = await silkWasm.decode(silkBuf, SILK_SAMPLE_RATE)
    logger?.debug('SILK decoded', {
      durationMs: result.duration,
      pcmBytes: result.data.byteLength,
    })

    const wav = pcmToWav(result.data, SILK_SAMPLE_RATE)
    logger?.debug('WAV created', { size: wav.length })
    return wav
  } catch (err) {
    logger?.warn?.(`SILK transcode failed (silk-wasm not installed?): ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

export { SILK_SAMPLE_RATE }

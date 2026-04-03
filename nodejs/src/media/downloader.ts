import { MediaError } from '../core/errors.js'
import type { Logger } from '../logger/types.js'
import { CDN_BASE_URL, type CDNMedia } from '../protocol/types.js'
import { decodeAesKey, decryptAesEcb } from './crypto.js'

/**
 * Downloads and decrypts media files from the WeChat CDN.
 */
export class MediaDownloader {
  private readonly logger: Logger

  constructor(
    private readonly cdnBaseUrl: string = CDN_BASE_URL,
    logger: Logger,
  ) {
    this.logger = logger.child('download')
  }

  /**
   * Download and decrypt a file from CDN.
   * @param media - The CDNMedia reference from the message
   * @param aeskeyOverride - Optional direct hex aeskey (from image_item.aeskey)
   */
  async download(media: CDNMedia, aeskeyOverride?: string): Promise<Buffer> {
    // Prefer server-provided full_url; fall back to building from encrypt_query_param
    const downloadUrl = media.full_url?.trim()
      || `${this.cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`

    this.logger.debug('Downloading from CDN')

    const response = await fetch(downloadUrl, {
      signal: AbortSignal.timeout(60_000),
    })

    if (!response.ok) {
      throw new MediaError(`CDN download failed: HTTP ${response.status}`)
    }

    const ciphertext = Buffer.from(await response.arrayBuffer())

    // Determine AES key — override takes priority
    const keySource = aeskeyOverride ?? media.aes_key
    if (!keySource) {
      throw new MediaError('No AES key available for decryption')
    }

    const aesKey = decodeAesKey(keySource)
    const plaintext = decryptAesEcb(ciphertext, aesKey)

    this.logger.debug('Downloaded and decrypted', {
      ciphertextSize: ciphertext.length,
      plaintextSize: plaintext.length,
    })

    return plaintext
  }
}

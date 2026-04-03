import { createHash, randomBytes } from 'node:crypto'
import { MediaError } from '../core/errors.js'
import type { Logger } from '../logger/types.js'
import type { ILinkApi } from '../protocol/api.js'
import { CDN_BASE_URL, type CDNMedia, type MediaType } from '../protocol/types.js'
import {
  encodeAesKeyBase64,
  encodeAesKeyHex,
  encryptAesEcb,
  encryptedSize,
  generateAesKey,
} from './crypto.js'

/** Maximum retry attempts for CDN upload. */
const UPLOAD_MAX_RETRIES = 3

export interface UploadResult {
  /** CDNMedia reference to include in sendmessage */
  media: CDNMedia
  /** The AES key used (raw 16 bytes) */
  aesKey: Buffer
  /** Encrypted file size */
  encryptedFileSize: number
}

export interface UploadOptions {
  /** File content as Buffer */
  data: Buffer
  /** Target user ID */
  userId: string
  /** Media type for the upload */
  mediaType: MediaType
}

/**
 * Handles file encryption and CDN upload.
 * Implements the full upload pipeline: getuploadurl → encrypt → CDN POST.
 * Retries CDN upload up to 3 times on server errors; client errors (4xx) abort immediately.
 */
export class MediaUploader {
  private readonly logger: Logger

  constructor(
    private readonly api: ILinkApi,
    private readonly cdnBaseUrl: string = CDN_BASE_URL,
    logger: Logger,
  ) {
    this.logger = logger.child('upload')
  }

  async upload(
    baseUrl: string,
    token: string,
    options: UploadOptions,
  ): Promise<UploadResult> {
    const { data, userId, mediaType } = options

    // 1. Generate AES key and encrypt
    const aesKey = generateAesKey()
    const ciphertext = encryptAesEcb(data, aesKey)
    const filekey = randomBytes(16).toString('hex')
    const rawMd5 = createHash('md5').update(data).digest('hex')

    this.logger.debug('Encrypted file', {
      rawSize: data.length,
      encryptedSize: ciphertext.length,
      filekey,
    })

    // 2. Get upload URL
    const uploadParams = await this.api.getUploadUrl(baseUrl, token, {
      filekey,
      media_type: mediaType,
      to_user_id: userId,
      rawsize: data.length,
      rawfilemd5: rawMd5,
      filesize: ciphertext.length,
      no_need_thumb: true,
      aeskey: encodeAesKeyHex(aesKey),
    })

    // Prefer upload_full_url; fall back to building URL from upload_param
    const uploadFullUrl = uploadParams.upload_full_url?.trim()
    if (!uploadFullUrl && !uploadParams.upload_param) {
      throw new MediaError('getuploadurl returned no upload URL (need upload_full_url or upload_param)')
    }

    this.logger.debug('Got upload params', { filekey })

    // 3. Upload to CDN with retry
    const uploadUrl = uploadFullUrl
      || `${this.cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(uploadParams.upload_param)}&filekey=${encodeURIComponent(filekey)}`

    let encryptQueryParam: string | undefined
    let lastError: unknown

    for (let attempt = 1; attempt <= UPLOAD_MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(uploadUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: new Uint8Array(ciphertext),
          signal: AbortSignal.timeout(60_000),
        })

        if (response.status >= 400 && response.status < 500) {
          const errMsg = response.headers.get('x-error-message') ?? `HTTP ${response.status}`
          throw new MediaError(`CDN upload client error ${response.status}: ${errMsg}`)
        }

        if (!response.ok) {
          const errMsg = response.headers.get('x-error-message') ?? `HTTP ${response.status}`
          throw new Error(`CDN upload server error: ${errMsg}`)
        }

        encryptQueryParam = response.headers.get('x-encrypted-param') ?? undefined
        if (!encryptQueryParam) {
          throw new Error('CDN upload response missing x-encrypted-param header')
        }

        this.logger.debug(`CDN upload success attempt=${attempt}`)
        break
      } catch (err) {
        lastError = err
        // Client errors (4xx) are definitive — don't retry
        if (err instanceof MediaError) throw err
        if (attempt < UPLOAD_MAX_RETRIES) {
          this.logger.warn(`CDN upload attempt ${attempt} failed, retrying...`, {
            error: err instanceof Error ? err.message : String(err),
          })
        } else {
          this.logger.error(`CDN upload all ${UPLOAD_MAX_RETRIES} attempts failed`, {
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
    }

    if (!encryptQueryParam) {
      throw lastError instanceof Error
        ? lastError
        : new MediaError(`CDN upload failed after ${UPLOAD_MAX_RETRIES} attempts`)
    }

    this.logger.info('Upload complete', { filekey, mediaType })

    return {
      media: {
        encrypt_query_param: encryptQueryParam,
        aes_key: encodeAesKeyBase64(aesKey),
        encrypt_type: 1,
      },
      aesKey,
      encryptedFileSize: ciphertext.length,
    }
  }
}

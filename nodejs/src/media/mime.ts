import { basename, extname } from 'node:path'

/**
 * MIME type ↔ file extension mapping.
 * Covers all common media types exchanged via WeChat.
 */

const EXTENSION_TO_MIME: Record<string, string> = {
  // Images
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  // Video
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  // Audio
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.silk': 'audio/silk',
  // Documents
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.md': 'text/markdown',
  // Archives
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.rar': 'application/vnd.rar',
  '.7z': 'application/x-7z-compressed',
}

const MIME_TO_EXTENSION: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'video/x-matroska': '.mkv',
  'video/x-msvideo': '.avi',
  'audio/mpeg': '.mp3',
  'audio/ogg': '.ogg',
  'audio/wav': '.wav',
  'audio/silk': '.silk',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'application/x-tar': '.tar',
  'application/gzip': '.gz',
  'text/plain': '.txt',
  'text/csv': '.csv',
  'application/json': '.json',
}

/**
 * Get MIME type from a filename or path.
 * Returns `application/octet-stream` for unknown extensions.
 */
export function getMimeFromFilename(filename: string): string {
  const ext = extname(filename).toLowerCase()
  return EXTENSION_TO_MIME[ext] ?? 'application/octet-stream'
}

/**
 * Get file extension from a MIME type.
 * Returns `.bin` for unknown types.
 */
export function getExtensionFromMime(mimeType: string): string {
  const ct = mimeType.split(';')[0].trim().toLowerCase()
  return MIME_TO_EXTENSION[ct] ?? '.bin'
}

/**
 * Get file extension from a Content-Type header or URL path.
 * Tries Content-Type first, then falls back to URL extension.
 * Returns `.bin` for unknown.
 */
export function getExtensionFromContentTypeOrUrl(
  contentType: string | null | undefined,
  url: string,
): string {
  if (contentType) {
    const ext = getExtensionFromMime(contentType)
    if (ext !== '.bin') return ext
  }

  try {
    const ext = extname(new URL(url).pathname).toLowerCase()
    if (ext && ext in EXTENSION_TO_MIME) return ext
  } catch {
    // Invalid URL, fall through
  }

  return '.bin'
}

/**
 * Determine the MediaType enum value from a MIME type.
 * Used for auto-routing uploads.
 */
export type MediaCategory = 'image' | 'video' | 'file'

export function categorizeByMime(mime: string): MediaCategory {
  const ct = mime.split(';')[0].trim().toLowerCase()
  if (ct.startsWith('image/')) return 'image'
  if (ct.startsWith('video/')) return 'video'
  return 'file'
}

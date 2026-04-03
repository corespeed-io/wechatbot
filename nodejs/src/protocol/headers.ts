import { randomBytes } from 'node:crypto'
import { CHANNEL_VERSION } from './types.js'

/**
 * Generate the X-WECHAT-UIN header value.
 * Algorithm: random uint32 → decimal string → base64
 */
export function randomWechatUin(): string {
  const value = randomBytes(4).readUInt32BE(0)
  return Buffer.from(String(value), 'utf8').toString('base64')
}

// ---------------------------------------------------------------------------
// iLink-App-Id & iLink-App-ClientVersion
// ---------------------------------------------------------------------------

/** iLink-App-Id header value. */
const ILINK_APP_ID = 'bot'

/**
 * iLink-App-ClientVersion: uint32 encoded as 0x00MMNNPP.
 * e.g. "2.0.1" → 0x00020001 = 131073
 */
function buildClientVersion(version: string): number {
  const parts = version.split('.').map((p) => parseInt(p, 10))
  const major = parts[0] ?? 0
  const minor = parts[1] ?? 0
  const patch = parts[2] ?? 0
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff)
}

const ILINK_APP_CLIENT_VERSION: string = String(buildClientVersion(CHANNEL_VERSION))

/**
 * Build common headers included in both GET and POST requests.
 */
export function buildCommonHeaders(): Record<string, string> {
  return {
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': ILINK_APP_CLIENT_VERSION,
  }
}

/**
 * Build the standard iLink Bot API headers for POST requests.
 */
export function buildAuthHeaders(token: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    Authorization: `Bearer ${token}`,
    'X-WECHAT-UIN': randomWechatUin(),
    ...buildCommonHeaders(),
  }
}

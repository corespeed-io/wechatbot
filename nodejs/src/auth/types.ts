export interface Credentials {
  token: string
  baseUrl: string
  accountId: string
  userId: string
  savedAt: string
}

export interface QrLoginCallbacks {
  /** Called when a QR URL is available for the user to scan. */
  onQrUrl?: (url: string) => void
  /** Called when the QR code has been scanned (awaiting confirmation). */
  onScanned?: () => void
  /** Called when the QR code has expired and a new one will be requested. */
  onExpired?: () => void
  /**
   * Called when the server requires a pairing code (the digits shown in
   * WeChat on the user's phone). `isRetry` is true when a previously
   * submitted code was rejected. Defaults to a stdin prompt.
   */
  onVerifyCode?: (isRetry: boolean) => string | Promise<string>
}

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
   * Called when the server requires a verification code (`need_verifycode`):
   * WeChat shows a short numeric code in the scanning user's app that must be
   * entered to continue. Return the code the user provided (login re-polls with
   * it immediately). If this callback is not supplied, login throws on
   * `need_verifycode`.
   */
  onNeedVerifyCode?: () => string | Promise<string>
  /** Called when the verification code was rejected too many times (`verify_code_blocked`). */
  onVerifyCodeBlocked?: () => void
}

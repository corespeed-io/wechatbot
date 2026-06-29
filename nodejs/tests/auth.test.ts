import { describe, it, expect, vi } from 'vitest'
import { Authenticator } from '../src/auth/authenticator.js'
import { MemoryStorage } from '../src/storage/memory.js'
import { createLogger } from '../src/logger/logger.js'
import type { ILinkApi } from '../src/protocol/api.js'
import type { QrCodeResponse, QrStatusResponse } from '../src/protocol/types.js'

const logger = createLogger({ level: 'silent' })

/** Build a fake ILinkApi that replays a scripted sequence of QR statuses. */
function makeApi(statuses: QrStatusResponse[]) {
  const verifyCodes: Array<string | undefined> = []
  let i = 0
  const api = {
    getQrCode: vi.fn(
      async (): Promise<QrCodeResponse> => ({
        qrcode: 'qr-1',
        qrcode_img_content: 'https://example.test/qr.png',
      }),
    ),
    pollQrStatus: vi.fn(
      async (_baseUrl: string, _qrcode: string, verifyCode?: string): Promise<QrStatusResponse> => {
        verifyCodes.push(verifyCode)
        return statuses[Math.min(i++, statuses.length - 1)]
      },
    ),
  }
  return { api: api as unknown as ILinkApi, verifyCodes }
}

describe('Authenticator need_verifycode flow', () => {
  it('submits the verification code and completes login', async () => {
    const { api, verifyCodes } = makeApi([
      { status: 'need_verifycode' },
      {
        status: 'confirmed',
        bot_token: 'tok',
        ilink_bot_id: 'bot-1',
        ilink_user_id: 'user-1',
        baseurl: 'https://backend.test',
      },
    ])
    const auth = new Authenticator(api, new MemoryStorage(), logger)
    const onNeedVerifyCode = vi.fn(() => '123456')

    const creds = await auth.login({ force: true, callbacks: { onNeedVerifyCode } })

    expect(onNeedVerifyCode).toHaveBeenCalledTimes(1)
    expect(creds.token).toBe('tok')
    expect(creds.accountId).toBe('bot-1')
    expect(creds.userId).toBe('user-1')
    // First poll carries no code; the poll after need_verifycode carries it.
    expect(verifyCodes).toEqual([undefined, '123456'])
  })

  it('throws when need_verifycode arrives without an onNeedVerifyCode callback', async () => {
    const { api } = makeApi([{ status: 'need_verifycode' }])
    const auth = new Authenticator(api, new MemoryStorage(), logger)

    await expect(auth.login({ force: true })).rejects.toThrow(/need_verifycode/)
  })

  it('throws and notifies on verify_code_blocked', async () => {
    const { api } = makeApi([{ status: 'verify_code_blocked' }])
    const auth = new Authenticator(api, new MemoryStorage(), logger)
    const onVerifyCodeBlocked = vi.fn()

    await expect(
      auth.login({
        force: true,
        callbacks: { onNeedVerifyCode: () => '0', onVerifyCodeBlocked },
      }),
    ).rejects.toThrow(/verify_code_blocked/)
    expect(onVerifyCodeBlocked).toHaveBeenCalledTimes(1)
  })
})

/**
 * Pi Extension: WeChat Bridge
 *
 * Type /wechat or /weixin in pi → QR code appears → scan with WeChat →
 * WeChat messages become pi prompts → pi responses sent back to WeChat.
 *
 * Uses @wechatbot/wechatbot SDK for iLink protocol.
 * Uses qrcode-terminal for QR display.
 */

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'
import { WeChatBot, type IncomingMessage } from '@wechatbot/wechatbot'
import qrTerminal from 'qrcode-terminal'

export default function wechatBridge(pi: ExtensionAPI) {
  let bot: WeChatBot | null = null
  let connected = false
  let activeUserId: string | null = null
  let pendingReply: IncomingMessage | null = null
  let assistantText = ''
  let isStreaming = false

  // ── Capture pi response → send back to WeChat ────────────────────

  pi.on('agent_end', async (event, ctx) => {
    if (!bot || !connected || !pendingReply) return

    const reply = pendingReply
    pendingReply = null
    isStreaming = false

    const messages = event.messages ?? []
    let finalText = ''
    for (const msg of messages) {
      if (msg.role === 'assistant') {
        for (const block of msg.content) {
          if (block.type === 'text') finalText += block.text
        }
      }
    }
    if (!finalText.trim()) finalText = assistantText || '[No response]'

    try {
      await bot.stopTyping(reply.userId)
      await bot.reply(reply, finalText)
      ctx.ui.setStatus('wechat', `✓ Replied to WeChat`)
    } catch (e) {
      ctx.ui.setStatus('wechat', `✗ Reply failed: ${e instanceof Error ? e.message : e}`)
    }
    assistantText = ''
  })

  pi.on('message_update', async (event) => {
    if (!isStreaming) return
    if (event.message.role === 'assistant') {
      let text = ''
      for (const block of event.message.content) {
        if (block.type === 'text') text += block.text
      }
      assistantText = text
    }
  })

  // ── /wechat and /weixin commands ──────────────────────────────────

  const startWechat = async (args: string | undefined, ctx: any) => {
    if (connected && bot) {
      const action = await ctx.ui.select('WeChat is connected', [
        'Disconnect', 'Status', 'Cancel',
      ])
      if (action === 'Disconnect') {
        bot.stop(); connected = false
        ctx.ui.setStatus('wechat', undefined)
        ctx.ui.notify('WeChat disconnected', 'info')
      } else if (action === 'Status') {
        const creds = bot.getCredentials()
        ctx.ui.notify(`Account: ${creds?.accountId}\nUser: ${creds?.userId}`, 'info')
      }
      return
    }

    bot = new WeChatBot({ storage: 'file', logLevel: 'warn' })
    const forceLogin = args?.trim() === '--force'

    ctx.ui.setStatus('wechat', '⏳ Waiting for QR scan…')

    try {
      const creds = await bot.login({
        force: forceLogin,
        callbacks: {
          onQrUrl: (url) => {
            // Render QR to stderr directly (bypasses widget truncation)
            qrTerminal.generate(url, { small: true }, (qr: string) => {
              process.stderr.write('\n')
              process.stderr.write('  📱 Scan this QR code in WeChat:\n\n')
              for (const line of qr.split('\n')) {
                process.stderr.write(`  ${line}\n`)
              }
              process.stderr.write('\n')
            })
            // Short status in footer
            ctx.ui.setStatus('wechat', `⏳ Scan QR in WeChat… (${url})`)
          },
          onScanned: () => {
            ctx.ui.setStatus('wechat', '📱 Scanned — confirm in WeChat…')
          },
          onExpired: () => {
            ctx.ui.setStatus('wechat', '⏳ QR expired — new one coming…')
          },
        },
      })

      ctx.ui.setStatus('wechat', `✓ WeChat: ${creds.accountId}`)
      ctx.ui.notify(`WeChat connected!\nAccount: ${creds.accountId}`, 'info')
      connected = true

      bot.onMessage(async (msg: IncomingMessage) => {
        if (msg.type !== 'text' || !msg.text.trim()) {
          await bot!.reply(msg, `[${msg.type} received — text only for now]`)
          return
        }

        activeUserId = msg.userId
        pendingReply = msg
        isStreaming = true
        assistantText = ''

        try { await bot!.sendTyping(msg.userId) } catch {}
        ctx.ui.setStatus('wechat', `📱 ${msg.text.slice(0, 60)}`)
        pi.sendUserMessage(msg.text)
      })

      bot.on('error', (err) => {
        ctx.ui.setStatus('wechat', `⚠ ${err instanceof Error ? err.message : String(err)}`)
      })
      bot.on('session:expired', () => {
        ctx.ui.setStatus('wechat', '⚠ Session expired — re-login…')
      })
      bot.on('session:restored', (c) => {
        ctx.ui.setStatus('wechat', `✓ Reconnected: ${c.accountId}`)
      })

      bot.start().catch((e) => {
        ctx.ui.setStatus('wechat', `✗ Poll error: ${e instanceof Error ? e.message : e}`)
        connected = false
      })

    } catch (e) {
      ctx.ui.setStatus('wechat', undefined)
      ctx.ui.notify(`Login failed: ${e instanceof Error ? e.message : e}`, 'error')
      bot = null
    }
  }

  pi.registerCommand('wechat', {
    description: 'Connect WeChat — scan QR to chat with Pi from your phone',
    handler: startWechat,
  })

  pi.registerCommand('weixin', {
    description: 'Connect WeChat (alias for /wechat)',
    handler: startWechat,
  })

  pi.on('session_shutdown', async () => {
    if (bot) { bot.stop(); bot = null }
    connected = false
  })

  pi.on('session_start', async (_event, ctx) => {
    if (connected && bot) {
      ctx.ui.setStatus('wechat', `✓ WeChat: ${bot.getCredentials()?.accountId ?? 'connected'}`)
    }
  })
}

/**
 * Pi Extension: WeChat Bridge
 *
 * Type /wechat or /weixin in pi → QR code appears → scan with WeChat →
 * WeChat messages become pi prompts → pi responses sent back to WeChat.
 *
 * Supports:
 *   - Text messages (bidirectional)
 *   - Image messages (receive → send to pi as vision, reply back)
 *   - File messages (text files → include content, others → describe)
 *   - Video messages (download → save to temp → tell pi the path)
 *   - Voice messages (transcribed text or SILK→WAV download)
 *   - Markdown stripping (pi responses → plain text for WeChat)
 *   - Media auto-routing (image/video/file by MIME type)
 *
 * Uses @wechatbot/wechatbot SDK for iLink protocol.
 * Uses qrcode-terminal for QR display.
 */

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'
import {
  WeChatBot,
  stripMarkdown,
  type IncomingMessage,
} from '@wechatbot/wechatbot'
import qrTerminal from 'qrcode-terminal'
import { readFile, writeFile, mkdtemp } from 'node:fs/promises'
import { basename, join, extname } from 'node:path'
import { tmpdir } from 'node:os'

export default function wechatBridge(pi: ExtensionAPI) {
  let bot: WeChatBot | null = null
  let connected = false
  let activeUserId: string | null = null
  let pendingReply: IncomingMessage | null = null
  let assistantText = ''
  let isStreaming = false

  // ── Inject system prompt so agent knows about WeChat bridge ────────

  pi.on('before_agent_start', async (event) => {
    if (!connected || !bot || !pendingReply) return

    return {
      systemPrompt: event.systemPrompt + `\n
## WeChat Bridge (Active)

You are currently bridged to WeChat via the wechatbot extension.
A real WeChat user is chatting with you — your response will be sent back to them.

Key behaviors:
- **No markdown**: WeChat doesn't render markdown. Write plain text. Use line breaks for structure.
- **Send files**: To send a file (image, video, document) back to WeChat, mention its absolute path in your response (e.g. /tmp/photo.png). The bridge auto-detects paths ending in media extensions and sends them as attachments.
- **Concise replies**: WeChat is a mobile chat app. Keep responses short and conversational.
- **Media received**: Images arrive as vision input. Videos/voice/files are described with metadata.
`,
    }
  })

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

    // Strip markdown for WeChat (WeChat doesn't render markdown)
    const cleanText = stripMarkdown(finalText)

    try {
      await bot.stopTyping(reply.userId)

      // Check if pi generated any media files we should send
      const mediaFiles = extractMediaPaths(finalText)
      if (mediaFiles.length > 0) {
        // Send text first (without file paths), then media
        const textWithoutPaths = removeMediaPaths(cleanText, mediaFiles)
        if (textWithoutPaths.trim()) {
          await bot.reply(reply, textWithoutPaths)
        }
        for (const filePath of mediaFiles) {
          try {
            const data = await readFile(filePath)
            const fileName = basename(filePath)
            await bot.reply(reply, { file: data, fileName })
          } catch {
            await bot.reply(reply, `[Failed to send file: ${basename(filePath)}]`)
          }
        }
      } else {
        await bot.reply(reply, cleanText)
      }

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
        'Reconnect', 'Disconnect', 'Status', 'Cancel',
      ])
      if (action === 'Reconnect') {
        ctx.ui.setStatus('wechat', '🔄 Reconnecting…')
        bot.stop()
        connected = false
        activeUserId = null
        pendingReply = null
        bot = null
        // Fall through to login flow below
      } else if (action === 'Disconnect') {
        bot.stop(); connected = false
        activeUserId = null
        pendingReply = null
        ctx.ui.setStatus('wechat', undefined)
        ctx.ui.notify('WeChat disconnected', 'info')
        bot = null
        return
      } else if (action === 'Status') {
        const creds = bot.getCredentials()
        ctx.ui.notify(`Account: ${creds?.accountId}\nUser: ${creds?.userId}`, 'info')
        return
      } else {
        return
      }
    }

    // Try stored credentials first; only force QR scan if none exist.
    // This avoids requiring a new QR scan on every service restart (issue #40).
    bot = new WeChatBot({ storage: 'file', logLevel: 'warn' })

    ctx.ui.setStatus('wechat', '⏳ Connecting…')

    try {
      const creds = await bot.login({
        force: false,
        callbacks: {
          onQrUrl: (url) => {
            qrTerminal.generate(url, { small: true }, (qr: string) => {
              process.stderr.write('\n')
              process.stderr.write('  📱 Scan this QR code in WeChat:\n\n')
              for (const line of qr.split('\n')) {
                process.stderr.write(`  ${line}\n`)
              }
              process.stderr.write('\n')
            })
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
        activeUserId = msg.userId
        pendingReply = msg
        isStreaming = true
        assistantText = ''

        try { await bot!.sendTyping(msg.userId) } catch {}

        // Build pi message content based on message type
        const piContent = await buildPiContent(msg, bot!)

        if (typeof piContent === 'string') {
          ctx.ui.setStatus('wechat', `📱 ${piContent.slice(0, 60)}`)
          pi.sendUserMessage(piContent)
        } else {
          const preview = piContent.find(b => b.type === 'text')
          ctx.ui.setStatus('wechat', `📱 ${(preview as any)?.text?.slice(0, 60) ?? '[media]'}`)
          pi.sendUserMessage(piContent)
        }
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

// ── Helper: Build pi message content from WeChat message ──────────────

type PiContent = string | Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>

async function buildPiContent(msg: IncomingMessage, bot: WeChatBot): Promise<PiContent> {
  switch (msg.type) {
    case 'text':
      return msg.text || '[empty message]'

    case 'image': {
      const media = await bot.download(msg)
      if (!media) return '[Image received but could not be downloaded]'

      const content: PiContent = []
      content.push({ type: 'text', text: msg.text !== '[image]' ? msg.text : 'User sent an image from WeChat:' })
      content.push({ type: 'image', data: media.data.toString('base64'), mimeType: 'image/jpeg' })
      return content
    }

    case 'voice': {
      const voice = msg.voices[0]
      if (voice?.text) return `[Voice message, transcribed]: ${voice.text}`

      const media = await bot.download(msg)
      if (media) {
        return `[Voice message received (${media.format}, ${media.data.length} bytes). No transcription available — please ask the user to type their message.]`
      }
      return '[Voice message received but could not be downloaded]'
    }

    case 'file': {
      const file = msg.files[0]
      const fileName = file?.fileName ?? 'unknown file'
      const fileSize = file?.size ? ` (${formatFileSize(file.size)})` : ''

      const textExts = new Set(['.txt', '.md', '.csv', '.json', '.xml', '.html', '.yaml', '.yml', '.toml', '.log', '.py', '.js', '.ts', '.go', '.rs', '.java', '.c', '.cpp', '.h'])
      if (textExts.has(extname(fileName).toLowerCase())) {
        try {
          const media = await bot.download(msg)
          if (media) {
            const text = media.data.toString('utf-8')
            const truncated = text.length > 10000 ? text.slice(0, 10000) + '\n... [truncated]' : text
            return `[File: ${fileName}${fileSize}]\n\n\`\`\`\n${truncated}\n\`\`\``
          }
        } catch { /* fall through */ }
      }
      return `[File received: ${fileName}${fileSize}. To process this file, ask the user to share its content as text.]`
    }

    case 'video': {
      const video = msg.videos[0]
      const duration = video?.durationMs ? ` (${Math.round(video.durationMs / 1000)}s)` : ''
      try {
        const media = await bot.download(msg)
        if (media) {
          const tmpDir = await mkdtemp(join(tmpdir(), 'wechat-video-'))
          const videoPath = join(tmpDir, 'video.mp4')
          await writeFile(videoPath, media.data)
          return `[Video received${duration}, saved to: ${videoPath}. You can access this file for processing.]`
        }
      } catch { /* fall through */ }
      return `[Video received${duration} but could not be downloaded.]`
    }

    default:
      return `[${msg.type} message received — not supported yet]`
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function extractMediaPaths(text: string): string[] {
  const paths: string[] = []
  const mediaExts = /\.(png|jpg|jpeg|gif|webp|bmp|svg|mp4|mov|webm|avi|pdf|doc|docx|xls|xlsx|ppt|pptx|zip|tar|gz)$/i
  const pathRegex = /(?:^|\s)((?:\/[\w./-]+|\.\/[\w./-]+))/gm
  let match
  while ((match = pathRegex.exec(text)) !== null) {
    const p = match[1].trim()
    if (mediaExts.test(p)) paths.push(p)
  }
  return [...new Set(paths)]
}

function removeMediaPaths(text: string, paths: string[]): string {
  let result = text
  for (const p of paths) {
    result = result.replace(new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '')
  }
  return result.replace(/\n{3,}/g, '\n\n').trim()
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

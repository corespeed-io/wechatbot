#!/usr/bin/env npx tsx
/**
 * Media Bot — demonstrates the unified download/reply API
 *
 * Shows how to:
 *   - Download any media with bot.download(msg)
 *   - Reply with text, images, files via bot.reply(msg, content)
 *   - Handle different media types
 */

import { writeFile } from 'node:fs/promises'
import { WeChatBot } from '../src/index.js'

const bot = new WeChatBot({ storage: 'file', logLevel: 'info' })
await bot.login({
  callbacks: {
    onQrUrl: (url) => console.log(`\nScan to login: ${url}\n`),
  },
})

bot.onMessage(async (msg) => {
  console.log(`[${msg.type}] from ${msg.userId}: ${msg.text}`)

  switch (msg.type) {
    case 'image':
    case 'file':
    case 'video': {
      // Unified download — handles any media type
      await bot.sendTyping(msg.userId)
      try {
        const media = await bot.download(msg)
        if (!media) {
          await bot.reply(msg, 'Received media but no downloadable reference found.')
          break
        }

        const ext = media.type === 'image' ? '.jpg'
          : media.type === 'video' ? '.mp4'
          : media.fileName ? '' : '.bin'
        const filename = `/tmp/wechat-${media.type}-${Date.now()}${media.fileName ?? ext}`
        await writeFile(filename, media.data)

        await bot.reply(msg, `✓ Downloaded ${media.type} (${media.data.length} bytes) → ${filename}`)
      } catch (err) {
        await bot.reply(msg, `✗ Failed to download: ${err instanceof Error ? err.message : String(err)}`)
      }
      break
    }

    case 'voice': {
      const voice = msg.voices[0]
      if (voice?.text) {
        await bot.reply(msg, `🎤 You said: "${voice.text}" (${voice.durationMs ?? 0}ms)`)
      } else {
        // Download and transcode SILK → WAV
        const media = await bot.download(msg)
        if (media) {
          await bot.reply(msg, `🎤 Voice downloaded (${media.format}, ${media.data.length} bytes, no transcription)`)
        } else {
          await bot.reply(msg, `🎤 Received voice message (no transcription)`)
        }
      }
      break
    }

    case 'text': {
      if (msg.text === '/upload') {
        await bot.reply(msg, 'Upload feature: use bot.reply(msg, { file: data, fileName: "doc.pdf" })')
      } else if (msg.quotedMessage) {
        await bot.reply(msg, `You quoted: "${msg.quotedMessage.title ?? msg.quotedMessage.text ?? '(unknown)'}"`)
      } else {
        await bot.reply(msg, `Echo: ${msg.text}`)
      }
      break
    }
  }
})

process.on('SIGINT', () => bot.stop())
console.log('Media bot listening...')
await bot.start()

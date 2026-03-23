#!/usr/bin/env npx tsx
/**
 * Send Image Test — downloads a random image and sends it to the first user who messages
 *
 * Usage:
 *   cd nodejs && npx tsx examples/send-image-test.ts
 *
 * Flow:
 *   1. Login via QR code
 *   2. Wait for any message from a user
 *   3. Reply with image from URL (auto-download + send)
 */

import { WeChatBot, type IncomingMessage } from '../src/index.js'

const bot = new WeChatBot({ storage: 'file', logLevel: 'info' })

const forceLogin = process.argv.includes('--force')
console.log(`🔐 Logging in...${forceLogin ? ' (force QR scan)' : ''}`)
await bot.login({
  force: forceLogin,
  callbacks: {
    onQrUrl: (url) => {
      console.log(`\n📱 Scan this QR code in WeChat:`)
      console.log(`   ${url}\n`)
    },
    onScanned: () => console.log('📱 Scanned — confirm in WeChat...'),
  },
})

const creds = bot.getCredentials()
console.log(`✅ Logged in as ${creds?.accountId}\n`)

bot.onMessage(async (msg: IncomingMessage) => {
  console.log(`📨 [${msg.type}] from ${msg.userId}: ${msg.text}`)

  try {
    await bot.sendTyping(msg.userId)

    // Reply with image from URL — one line does download + upload + send
    console.log('📤 Sending random image...')
    await bot.reply(msg, {
      url: 'https://picsum.photos/400/300',
      caption: '🎉 Here is a random image for you!',
    })
    console.log('✅ Image sent successfully!')

  } catch (err) {
    console.error('❌ Error:', err)
    try {
      await bot.reply(msg, `❌ Failed: ${err instanceof Error ? err.message : String(err)}`)
    } catch {}
  }
})

bot.on('error', (err) => {
  console.error('Bot error:', err instanceof Error ? err.message : String(err))
})

process.on('SIGINT', () => {
  console.log('\n👋 Shutting down...')
  bot.stop()
  process.exit(0)
})

console.log('🤖 Waiting for messages... (send anything in WeChat to get a random image)')
console.log('   Press Ctrl+C to stop\n')
await bot.start()

# @wechatbot/wechatbot — Node.js SDK

WeChat iLink Bot SDK for Node.js — modular, extensible, production-grade.

## Install

```bash
npm install @wechatbot/wechatbot
```

Requires Node.js >= 22 (for native fetch). Zero runtime dependencies.

## Quick Start

```typescript
import { WeChatBot } from '@wechatbot/wechatbot'

const bot = new WeChatBot()
await bot.login()

bot.onMessage(async (msg) => {
  await bot.sendTyping(msg.userId)
  await bot.reply(msg, `Echo: ${msg.text}`)
})

await bot.start()
```

## Architecture

```
src/
├── core/           ← WeChatBot client, typed events, error hierarchy
├── transport/      ← HTTP client with retry & timeout
├── protocol/       ← Raw iLink API calls + wire types
├── auth/           ← QR login + credential persistence
├── messaging/      ← Poller, Sender, Typing, ContextStore
├── media/          ← AES-128-ECB crypto, CDN upload/download
├── middleware/      ← Express-style middleware engine + builtins
├── message/        ← Parser, Builder, friendly types
├── storage/        ← Pluggable storage (file, memory, custom)
├── logger/         ← Structured leveled logging
└── index.ts        ← Public exports
```

## Configuration

```typescript
const bot = new WeChatBot({
  storage: 'file',            // 'file' | 'memory' | custom Storage
  storageDir: '~/.wechatbot',
  logLevel: 'info',           // 'debug' | 'info' | 'warn' | 'error' | 'silent'
  loginCallbacks: {
    onQrUrl: (url) => renderQrCode(url),
    onScanned: () => console.log('Scanned!'),
  },
})
```

## API Reference

### Lifecycle

| Method | Description |
|---|---|
| `new WeChatBot(options?)` | Create a bot instance |
| `bot.login(options?)` | QR login (auto-skips if credentials exist) |
| `bot.start()` | Start long-poll loop |
| `bot.run(options?)` | login() + start() in one call |
| `bot.stop()` | Stop gracefully |
| `bot.isRunning` | Whether the poll loop is active |

### Receiving

| Method | Description |
|---|---|
| `bot.onMessage(handler)` | Register message handler |
| `bot.download(msg)` | Download any media from a message (image/file/video/voice) |

### Sending — `reply(msg, content)` / `send(userId, content)`

Both methods accept the same content types:

```typescript
// Text (string shorthand)
await bot.reply(msg, 'Hello!')

// Text (object)
await bot.reply(msg, { text: 'Hello!' })

// Image with optional caption
await bot.reply(msg, { image: pngBuffer, caption: 'Screenshot' })

// Video with optional caption
await bot.reply(msg, { video: mp4Buffer, caption: 'Check this out' })

// File — auto-routes by extension (.png → image, .mp4 → video, else → file)
await bot.reply(msg, { file: data, fileName: 'report.pdf' })
await bot.reply(msg, { file: data, fileName: 'photo.png' })   // → sent as image

// From URL — auto-download + auto-detect type
await bot.reply(msg, { url: 'https://example.com/photo.jpg' })

// Send to a user by ID (same content options)
await bot.send(userId, { image: buffer, caption: 'Hi!' })
```

### Typing

| Method | Description |
|---|---|
| `bot.sendTyping(userId)` | Show "typing..." indicator |
| `bot.stopTyping(userId)` | Cancel typing indicator |

### Advanced

| Method | Description |
|---|---|
| `bot.sendRaw(payload)` | Send pre-built MessageBuilder payload |
| `bot.upload(options)` | Upload to CDN without sending |
| `bot.downloadRaw(media, aeskey?)` | Download from raw CDN reference |
| `bot.createMessage(userId)` | Fluent MessageBuilder |

### Middleware

```typescript
bot.use(loggingMiddleware(bot.logger))
bot.use(rateLimitMiddleware({ maxMessages: 10, windowMs: 60_000 }))
bot.use(typeFilterMiddleware('text', 'image'))
bot.use(filterMiddleware(/^\/\w+/))

// Custom middleware
bot.use(async (ctx, next) => {
  console.log(`From: ${ctx.message.userId}`)
  await next()
})
```

### Events

```typescript
bot.on('login', (creds) => { })
bot.on('message', (msg) => { })
bot.on('session:expired', () => { })
bot.on('session:restored', (creds) => { })
bot.on('error', (err) => { })
bot.on('poll:start', () => { })
bot.on('poll:stop', () => { })
bot.on('close', () => { })
```

### Message Types

```typescript
interface IncomingMessage {
  userId: string
  text: string
  type: 'text' | 'image' | 'voice' | 'file' | 'video'
  timestamp: Date
  images: ImageContent[]
  voices: VoiceContent[]
  files: FileContent[]
  videos: VideoContent[]
  quotedMessage?: QuotedMessage
  raw: WireMessage
}
```

### Storage Interface

```typescript
interface Storage {
  get<T>(key: string): Promise<T | undefined>
  set<T>(key: string, value: T): Promise<void>
  delete(key: string): Promise<void>
  has(key: string): Promise<boolean>
  clear(): Promise<void>
}
```

## Development

```bash
npm install
npm run build    # TypeScript → dist/
npm test         # 69 unit tests
npm run lint     # Type check
```

## License

MIT

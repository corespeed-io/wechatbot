# WeChatBot

<p align="center">
  <strong>WeChat iLink Bot SDK for OpenClaw / AI Agent</strong><br/>
  <sub>Modular, production-grade, multi-language WeChat iLink Bot SDK</sub>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@wechatbot/wechatbot"><img src="https://img.shields.io/npm/v/@wechatbot/wechatbot?style=flat-square&label=npm" alt="npm"></a>
  <a href="https://github.com/corespeed-io/wechatbot/blob/main/LICENSE"><img src="https://img.shields.io/github/license/corespeed-io/wechatbot?style=flat-square" alt="License"></a>
  <a href="https://github.com/corespeed-io/wechatbot"><img src="https://img.shields.io/github/stars/corespeed-io/wechatbot?style=flat-square" alt="Stars"></a>
</p>

---

[中文文档](README.md)

Connect any agent to WeChat in 5 minutes. Inspired by [openclaw-weixin-cli](https://github.com/nicepkg/openclaw-weixin).

## 📦 SDKs

| SDK | Install | Status |
|-----|---------|--------|
| [Node.js](nodejs/) | `npm install @wechatbot/wechatbot` | ✅ Production Ready |
| [Python](python/) | `pip install wechatbot-sdk` | ✅ Production Ready |
| [Go](golang/) | `go get github.com/corespeed-io/wechatbot-go` | ✅ Production Ready |
| [Rust](rust/) | `wechatbot = "0.1"` | ✅ Production Ready |

## ⚡ Quick Start

### Node.js

```typescript
import { WeChatBot } from '@wechatbot/wechatbot'

const bot = new WeChatBot()
await bot.login()                             // QR code login
bot.onMessage(async (msg) => {
  await bot.reply(msg, `Echo: ${msg.text}`)   // Auto reply
})
await bot.start()
```

### Go

```go
bot := wechatbot.New()
bot.Login(ctx, false)
bot.OnMessage(func(msg *wechatbot.IncomingMessage) {
    bot.Reply(ctx, msg, fmt.Sprintf("Echo: %s", msg.Text))
})
bot.Run(ctx)
```

### Rust

```rust
let bot = WeChatBot::new(BotOptions::default());
bot.login(false).await?;
bot.on_message(Box::new(|msg| {
    println!("{}: {}", msg.user_id, msg.text);
})).await;
bot.run().await?;
```

## 🤖 Pi Agent Extension

Chat with [Pi coding agent](https://github.com/badlogic/pi-mono) directly from WeChat — scan QR code to connect.

```bash
# Load the extension
pi -e /path/to/wechatbot/pi-agent/src/index.ts

# Then in Pi:
/wechat          # Show QR code → Scan with WeChat → Connected!
```

See [pi-agent/README.md](pi-agent/README.md) for details.

## ✨ Features

All SDKs share the following capabilities:

| Feature | Description |
|---------|-------------|
| 🔐 QR Code Login | Credential persistence, stored in `~/.wechatbot/` |
| 📨 Long Polling | Reliable message receiving with automatic cursor management |
| 💬 Rich Media | Images, files, voice, video (upload + download) |
| 🔗 context_token | Automatic lifecycle management, persists across restarts |
| ⌨️ Typing Status | "Typing..." indicator with ticket caching |
| 🔒 CDN Encryption | AES-128-ECB with dual-key format support |
| ♻️ Session Recovery | Auto re-login on session expiry (`-14`) |
| 📝 Smart Chunking | Split text by natural boundaries (paragraphs → lines → spaces) |

### Node.js Exclusive Features

| Feature | Description |
|---------|-------------|
| 🧩 Middleware Pipeline | Express/Koa-style composable middleware |
| 📦 Pluggable Storage | File, memory, or custom (Redis, SQLite…) |
| 🎯 Typed Events | Full IntelliSense lifecycle monitoring |
| 📝 Structured Logging | Leveled, context-aware, pluggable transports |
| 🏗️ Message Builder | `.text().image().file().build()` chaining API |

## 🏗 Architecture

```mermaid
graph TD
    A["🤖 Your Bot"] --> B["Bot Client (Orchestrator)"]
    B --> C["Poller"]
    B --> D["Sender"]
    B --> E["Typing"]
    B --> F["Media"]
    C --> G["Context Store (Token Cache)"]
    D --> G
    E --> G
    F --> G
    G --> H["Protocol / API (HTTP Calls)"]
    H --> I["Storage (Credentials & State Persistence)"]
```

## 📖 Documentation

| Document | Description |
|----------|-------------|
| [docs/protocol.md](docs/protocol.md) | iLink Bot API Protocol Reference |
| [docs/architecture.md](docs/architecture.md) | Architecture Design & SDK Comparison |
| [nodejs/README.md](nodejs/README.md) | Node.js SDK Documentation |
| [python/README.md](python/README.md) | Python SDK Documentation |
| [golang/README.md](golang/README.md) | Go SDK Documentation |
| [rust/README.md](rust/README.md) | Rust SDK Documentation |
| [pi-agent/README.md](pi-agent/README.md) | Pi Extension (WeChat ↔ Pi Bridge) |

## 🌐 Website

The bilingual documentation website has been moved to a separate repository: [jiweiyuan/wechatbot-landing](https://github.com/jiweiyuan/wechatbot-landing)

## 📁 Project Structure

```
wechatbot/
├── nodejs/                # Node.js SDK (TypeScript)
│   ├── src/               #   11 modules
│   ├── tests/             #   8 test files
│   └── examples/          #   4 example bots
├── python/                # Python SDK (async/aiohttp)
│   ├── wechatbot/         #   6 modules
│   └── tests/             #   2 test files
├── golang/                # Go SDK (pure stdlib)
│   ├── bot.go             #   Bot client
│   ├── types.go           #   Type definitions
│   └── internal/          #   protocol, auth, crypto
├── rust/                  # Rust SDK
│   └── src/               #   6 modules
├── pi-agent/              # Pi Extension (WeChat ↔ Pi Bridge)
│   └── src/               #   Extension entry & WeChat client
└── docs/                  # Shared documentation
    ├── protocol.md        #   iLink API Protocol Spec
    └── architecture.md    #   Architecture & SDK Comparison
```

## 📄 License

[MIT](LICENSE)

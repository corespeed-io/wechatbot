# wechatbot-go — Go SDK

WeChat iLink Bot SDK for Go — simple, concurrent, production-ready.

## Install

```bash
go get github.com/corespeed-io/wechatbot-go
```

Requires Go 1.22+. Zero CGO dependencies.

## Quick Start

```go
package main

import (
    "context"
    "fmt"
    wechatbot "github.com/corespeed-io/wechatbot-go"
)

func main() {
    ctx := context.Background()
    bot := wechatbot.New()

    creds, _ := bot.Login(ctx, false)
    fmt.Printf("Logged in: %s\n", creds.AccountID)

    bot.OnMessage(func(msg *wechatbot.IncomingMessage) {
        bot.SendTyping(ctx, msg.UserID)
        bot.Reply(ctx, msg, fmt.Sprintf("Echo: %s", msg.Text))
    })

    bot.Run(ctx)
}
```

## Architecture

```
wechatbot-go/
├── types.go                 ← All public types
├── bot.go                   ← Bot client (login, run, reply, send)
├── internal/
│   ├── protocol/
│   │   └── api.go           ← Raw iLink HTTP calls
│   ├── auth/
│   │   └── login.go         ← QR login + credential persistence
│   └── crypto/
│       ├── aes.go           ← AES-128-ECB encrypt/decrypt
│       └── aes_test.go      ← Crypto tests
└── examples/
    └── echo-bot/main.go     ← Echo bot example
```

## API Reference

### Creating a Bot

```go
bot := wechatbot.New(wechatbot.Options{
    BaseURL:   "",                          // default: ilinkai.weixin.qq.com
    CredPath:  "",                          // default: ~/.wechatbot/credentials.json
    LogLevel:  "info",                      // debug, info, warn, error, silent
    OnQRURL:   func(url string) { ... },    // custom QR rendering
    OnScanned: func() { ... },              // scan detected
    OnExpired: func() { ... },              // QR expired
    OnError:   func(err error) { ... },     // error callback
})
```

### Authentication

```go
// Login (skips QR if credentials exist)
creds, err := bot.Login(ctx, false)

// Force re-login
creds, err := bot.Login(ctx, true)
```

### Message Handling

```go
bot.OnMessage(func(msg *wechatbot.IncomingMessage) {
    fmt.Printf("User: %s\n", msg.UserID)
    fmt.Printf("Text: %s\n", msg.Text)
    fmt.Printf("Type: %s\n", msg.Type)  // text, image, voice, file, video

    // Rich content
    for _, img := range msg.Images {
        fmt.Printf("Image: %v\n", img.URL)
    }
    for _, voice := range msg.Voices {
        fmt.Printf("Voice text: %s (%dms)\n", voice.Text, voice.DurationMs)
    }
    for _, file := range msg.Files {
        fmt.Printf("File: %s (%d bytes)\n", file.FileName, file.Size)
    }
    if msg.QuotedMessage != nil {
        fmt.Printf("Quoted: %s\n", msg.QuotedMessage.Title)
    }
})
```

### Sending Messages

```go
// Reply to incoming message (auto context_token)
err := bot.Reply(ctx, msg, "Hello back!")

// Send to user (needs prior context)
err := bot.Send(ctx, userID, "Proactive message")

// Typing indicator
err := bot.SendTyping(ctx, userID)
err := bot.StopTyping(ctx, userID)
```

### Lifecycle

```go
// Start polling (blocks)
err := bot.Run(ctx)

// Stop gracefully
bot.Stop()
```

### IncomingMessage

```go
type IncomingMessage struct {
    UserID        string
    Text          string
    Type          ContentType     // "text", "image", "voice", "file", "video"
    Timestamp     time.Time
    Images        []ImageContent
    Voices        []VoiceContent
    Files         []FileContent
    Videos        []VideoContent
    QuotedMessage *QuotedMessage
    Raw           *WireMessage
    ContextToken  string          // internal
}
```

## Concurrency

The bot is safe for concurrent use:
- `contextTokens` uses `sync.Map`
- Credentials are protected by `sync.Mutex`
- Multiple handlers run sequentially per message

## Session Recovery

When a `-14` (session expired) error is received, the bot automatically:
1. Clears all cached state
2. Deletes stored credentials
3. Initiates a new QR login
4. Resumes polling

## Testing

```bash
cd golang
go test ./...
```

## License

MIT

# wechatbot — Rust SDK

WeChat iLink Bot SDK for Rust — async, type-safe, zero-copy where possible.

## Install

```toml
[dependencies]
wechatbot = "0.1"
tokio = { version = "1", features = ["full"] }
```

Requires Rust 2021 edition. Built on `tokio` + `reqwest`.

## Quick Start

```rust
use wechatbot::{WeChatBot, BotOptions};

#[tokio::main]
async fn main() {
    let bot = WeChatBot::new(BotOptions::default());
    let creds = bot.login(false).await.unwrap();
    println!("Logged in: {}", creds.account_id);

    bot.on_message(Box::new(|msg| {
        println!("{}: {}", msg.user_id, msg.text);
    })).await;

    bot.run().await.unwrap();
}
```

## Architecture

```
src/
├── lib.rs           ← Public re-exports
├── types.rs         ← All protocol & public types (serde)
├── error.rs         ← Error hierarchy (thiserror)
├── protocol.rs      ← Raw iLink API calls (reqwest)
├── crypto.rs        ← AES-128-ECB encrypt/decrypt + key encoding
└── bot.rs           ← WeChatBot client (login, run, reply, send)
```

## API Reference

### Creating a Bot

```rust
use wechatbot::{WeChatBot, BotOptions};

let bot = WeChatBot::new(BotOptions {
    base_url: None,     // default: ilinkai.weixin.qq.com
    cred_path: None,    // default: ~/.wechatbot/credentials.json
    on_qr_url: Some(Box::new(|url| {
        println!("Scan: {}", url);
    })),
    on_error: Some(Box::new(|err| {
        eprintln!("Error: {}", err);
    })),
});
```

### Authentication

```rust
// Login (skips QR if credentials exist)
let creds = bot.login(false).await?;

// Force re-login
let creds = bot.login(true).await?;

// Credentials struct
println!("Token: {}", creds.token);
println!("Base URL: {}", creds.base_url);
println!("Account: {}", creds.account_id);
println!("User: {}", creds.user_id);
```

### Message Handling

```rust
bot.on_message(Box::new(|msg| {
    match msg.content_type {
        ContentType::Text => println!("Text: {}", msg.text),
        ContentType::Image => {
            for img in &msg.images {
                println!("Image URL: {:?}", img.url);
            }
        }
        ContentType::Voice => {
            for voice in &msg.voices {
                println!("Voice: {:?} ({}ms)", voice.text, voice.duration_ms.unwrap_or(0));
            }
        }
        ContentType::File => {
            for file in &msg.files {
                println!("File: {:?}", file.file_name);
            }
        }
        ContentType::Video => println!("Video received"),
    }

    if let Some(ref quoted) = msg.quoted {
        println!("Quoted: {:?}", quoted.title);
    }
})).await;
```

### Sending Messages

```rust
// Reply to incoming message
bot.reply(&msg, "Echo: hello").await?;

// Send to user (needs prior context_token)
bot.send(user_id, "Hello").await?;

// Typing indicator
bot.send_typing(user_id).await?;
```

### Media Operations

```rust
// Reply with media content
bot.reply_media(&msg, SendContent::Image(png_bytes)).await?;
bot.reply_media(&msg, SendContent::File { data, file_name: "report.pdf".into() }).await?;
bot.reply_media(&msg, SendContent::Video(mp4_bytes)).await?;
```

```rust
// Download media from incoming message (priority: image > file > video > voice)
if let Some(media) = bot.download(&msg).await? {
    println!("Type: {}, Size: {} bytes", media.media_type, media.data.len());
    if let Some(name) = &media.file_name {
        println!("Filename: {}", name);
    }
}

// Download a raw CDN reference directly
let raw = bot.download_raw(&msg.images[0].media.as_ref().unwrap(), None).await?;
```

```rust
// Upload to CDN without sending a message
let result = bot.upload(&file_bytes, user_id, 3).await?;
```

### Lifecycle

```rust
// Start polling (blocks)
bot.run().await?;

// Stop
bot.stop().await;
```

## Error Handling

```rust
use wechatbot::WeChatBotError;

match result {
    Err(WeChatBotError::Api { message, errcode, .. }) => {
        if errcode == -14 {
            // session expired — handled automatically
        }
    }
    Err(WeChatBotError::NoContext(user_id)) => {
        // no context_token for this user yet
    }
    Err(WeChatBotError::Transport(e)) => {
        // network error
    }
    _ => {}
}
```

## AES-128-ECB Crypto

```rust
use wechatbot::{generate_aes_key, encrypt_aes_ecb, decrypt_aes_ecb, decode_aes_key};

// Generate key
let key = generate_aes_key();

// Encrypt/decrypt
let ciphertext = encrypt_aes_ecb(b"Hello", &key);
let plaintext = decrypt_aes_ecb(&ciphertext, &key)?;

// Decode protocol key (handles all 3 formats)
let key = decode_aes_key("ABEiM0RVZneImaq7zN3u/w==")?;
let key = decode_aes_key("00112233445566778899aabbccddeeff")?;
```

## Types

All protocol types derive `Serialize` + `Deserialize` + `Clone` + `Debug`:

```rust
// Wire-level (protocol)
WireMessage, WireMessageItem, CDNMedia, TextItem, ImageItem, ...

// Parsed (user-friendly)
IncomingMessage, ImageContent, VoiceContent, FileContent, VideoContent

// Auth
Credentials

// Enums
MessageType, MessageState, MessageItemType, ContentType, MediaType
```

## Testing

```bash
cd rust
cargo test
```

## License

MIT

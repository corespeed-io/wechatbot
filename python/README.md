# wechatbot-sdk — Python SDK

WeChat iLink Bot SDK for Python — async, typed, production-grade.

## Install

```bash
pip install wechatbot-sdk
```

Requires Python ≥ 3.9. Dependencies: `aiohttp`, `cryptography`.

## Quick Start

```python
from wechatbot import WeChatBot

bot = WeChatBot()

@bot.on_message
async def handle(msg):
    await bot.send_typing(msg.user_id)
    await bot.reply(msg, f"Echo: {msg.text}")

bot.run()  # login + start in one call
```

Or with async control:

```python
import asyncio
from wechatbot import WeChatBot

async def main():
    bot = WeChatBot()
    await bot.login()

    @bot.on_message
    async def handle(msg):
        await bot.reply(msg, f"Echo: {msg.text}")

    await bot.start()

asyncio.run(main())
```

## Configuration

```python
bot = WeChatBot(
    base_url="https://ilinkai.weixin.qq.com",   # default
    cred_path="~/.wechatbot/credentials.json",   # default
    on_qr_url=lambda url: print(f"Scan: {url}"),
    on_scanned=lambda: print("Scanned!"),
    on_expired=lambda: print("Expired..."),
    on_error=lambda err: print(f"Error: {err}"),
)
```

## API Reference

| Method | Description |
|---|---|
| `await bot.login(force=False)` | QR login (auto-skips if creds exist) |
| `await bot.start()` | Start long-poll loop |
| `bot.run()` | Sync: login + start |
| `bot.stop()` | Stop gracefully |
| `bot.on_message(handler)` | Register handler (also works as decorator) |
| `await bot.reply(msg, text)` | Reply (auto context_token + stop typing) |
| `await bot.send(user_id, text)` | Send to user (needs prior context) |
| `await bot.send_typing(user_id)` | Show "typing..." indicator |
| `await bot.stop_typing(user_id)` | Cancel typing indicator |

## Message Types

```python
@dataclass
class IncomingMessage:
    user_id: str
    text: str
    type: Literal["text", "image", "voice", "file", "video"]
    timestamp: datetime
    images: list[ImageContent]
    voices: list[VoiceContent]
    files: list[FileContent]
    videos: list[VideoContent]
    quoted_message: QuotedMessage | None
    raw: dict
```

## AES-128-ECB Crypto

```python
from wechatbot import (
    generate_aes_key, encrypt_aes_ecb, decrypt_aes_ecb, decode_aes_key
)

key = generate_aes_key()
ct = encrypt_aes_ecb(b"Hello", key)
pt = decrypt_aes_ecb(ct, key)

# Decode protocol key (all 3 formats)
k = decode_aes_key("ABEiM0RVZneImaq7zN3u/w==")       # base64(raw)
k = decode_aes_key("00112233445566778899aabbccddeeff") # hex
```

## Project Structure

```
python/
├── wechatbot/
│   ├── __init__.py      ← Public exports
│   ├── client.py        ← WeChatBot (login, start, reply, send)
│   ├── protocol.py      ← Raw iLink API calls
│   ├── auth.py          ← QR login + credential persistence
│   ├── types.py         ← All types (dataclasses)
│   ├── errors.py        ← Error hierarchy
│   └── crypto.py        ← AES-128-ECB encrypt/decrypt
├── examples/
│   └── echo_bot.py
├── tests/
│   ├── test_crypto.py   ← 10 tests
│   └── test_client.py   ← 8 tests
└── pyproject.toml
```

## Testing

```bash
pip install -e ".[dev]"
pytest
```

## License

MIT

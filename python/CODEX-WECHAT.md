# WeChat ↔ Codex: Python text and image chat

This optional example uses a locally authenticated Codex CLI to answer WeChat
messages. It adds a Windows-friendly Python entry point, single-image
understanding, follow-up questions about the latest image, and `/reset` for both
text and image context. Replies and built-in help default to Chinese.

This is complementary to [PR #110](https://github.com/corespeed-io/wechatbot/pull/110),
which proposes a Node.js/macOS/Linux skill for executing text tasks in a persistent
Codex session. This example is **chat-only**: it uses ephemeral Codex calls and
bounded in-memory history, not session resume or remote workspace changes. It does
not depend on or modify that PR.

## Requirements

- A source checkout, Python 3.9+ (Windows validation used Python 3.12), and internet
  access to WeChat and Codex. No Rust build is needed.
- A native Codex CLI executable authenticated on the same machine with `codex login`.
  ChatGPT login does not require adding an API key to this example; account access
  and usage limits still apply.
- A CLI build that supports `exec --image`, `--ephemeral`, `--ignore-user-config`,
  `--ignore-rules`, `--no-daemon` and the tool-disable flags used by the script.
  Live validation used the Windows desktop-bundled CLI
  `0.162.0-alpha.17.2`. Other CLI versions may need updating; run the self-tests
  before starting the bot. A model selected with `--model` must accept image input.
- The optional `codex` Python extra installs Pillow. Install the SDK from this
  checkout too: the example uses the new `download_raw(..., max_bytes=...)` option.

## Windows PowerShell quick start

Start in the checkout's `python` directory. Stop any existing Echo Bot or Codex
Bot for this WeChat account before starting another poller.

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e ".[codex]"
codex login
.\.venv\Scripts\python.exe examples\codex_bot.py
```

Skip virtual-environment creation if it already exists. If the `py` launcher is
unavailable, use your Python executable instead. You can also double-click
`start-codex.cmd` after installing into `.venv`.

The script looks for Codex on `PATH` and in the Windows desktop app's bundled
`%LOCALAPPDATA%\OpenAI\Codex\bin` directories. To select an executable explicitly:

```powershell
.\.venv\Scripts\python.exe examples\codex_bot.py --codex "C:\path\to\codex.exe"
```

Use an actual executable, not an npm `.cmd`/`.bat` wrapper. The bridge does not
invoke a command shell. If `codex login` is not on `PATH`, run
`& "C:\path\to\codex.exe" login` first. `WECHAT_CODEX_BIN` is an alternative to
`--codex`; `--model` / `WECHAT_CODEX_MODEL` optionally select a model.

On macOS/Linux, the equivalent entry point is
`python examples/codex_bot.py` after creating a virtual environment, installing
`.[codex]`, and authenticating a compatible CLI. Live model validation for this
change was performed on Windows; CI runs the offline Python suite on all three OSes.

Existing WeChat credentials are reused through the SDK's normal login flow. If
they have expired, follow the printed QR-login link. Keep the terminal running;
`Ctrl+C` stops the bot. Changes to source require a manual restart.

## Chat and images

- Only messages from the QR-login account are handled. Other senders' images are
  not downloaded or submitted to Codex.
- Send text for ordinary chat. At most eight successful turns and 24,000 history
  characters are retained, with a 6,000-character per-message input limit.
- Send one image to get a description, or include a text caption in the same
  message. Subsequent text questions reattach the most recent image.
- Image and description may arrive as separate messages. Each message receives its
  own answer; there is no batching delay. Sending the image first is simplest.
  If text arrives first, it is retained in the normal history for the image turn.
- A new image replaces the previous one. Comparing multiple images or reopening
  an older image requires resending it. Multi-image messages are rejected.
- `/reset` or `重置对话` clears both text history and the image; `/help` shows help.
  Restarting also clears this bridge's conversation.

### Image limits and cleanup

- JPEG, PNG, WebP and **static** GIF, at most **10 MiB and 25 million pixels**.
  Animated images, arbitrary file attachments, video and voice are not supported.
- Downloads are limited while streaming encrypted bytes, including AES padding,
  and checked again after decryption. The default SDK behavior remains unchanged
  when `max_bytes` is omitted. The bridge's download timeout is 65 seconds.
- Images are oriented, stripped of metadata, composited over white where
  transparent, resized to a maximum 2048-pixel edge, and converted to JPEG. Crop
  small text before sending if it becomes hard to read after resizing.
- The latest normalized image stays in memory for at most **30 minutes from
  receipt**. Follow-ups do not extend that lifetime. Replacement, reset, expiry,
  or normal exit drops it. An already running model call can finish using its
  attachment; subsequent calls cannot reuse an expired image.
- Original decrypted bytes are not saved. Each model invocation creates an owned
  temporary JPEG under `.codex-wechat/images/call-*`, then removes it on success,
  failure, timeout or cancellation. Separate processes do not delete each other's
  directories. Power loss or forced process termination may leave files there;
  stop all bridge instances before manually cleaning leftovers.
- A failed new image download, decryption, or validation clears the old image,
  preventing silent fallback to the wrong picture. A model failure retains the
  valid current image until its normal expiry, so a text retry can reuse it.

## Boundaries and privacy

User text is passed over stdin, never concatenated into a shell command. Images
use Codex's `--image` attachment argument, not a tool that reads arbitrary paths.
The bridge requests a read-only sandbox, disables shell, app/plugin, browser,
computer-use and other tools, and ignores personal configuration/rules. This is
not a general-purpose remote coding agent and does not resume desktop chats.

Chat text, retained history and the current image are sent to Codex/OpenAI. This
is not offline recognition. `/reset` removes local bridge context; it does not
delete data previously submitted to the service. WeChat credentials continue to
use the SDK's normal storage and are not included in model prompts. Do not commit
credentials or `.codex-wechat` data.

The model timeout defaults to 180 seconds (`--timeout` overrides it). Failed or
incomplete model turns do not become successful history. The SDK processes
messages sequentially, so reset/help sent during a model call is handled after
that call finishes or times out.

## Self-tests and regression tests

Optional live checks use the local Codex login but **do not connect to WeChat or
send WeChat messages**:

```powershell
.\.venv\Scripts\python.exe examples\codex_bot.py --self-test
.\.venv\Scripts\python.exe examples\codex_bot.py --self-test-image
```

The first expects `CODEX_OK`. The second generates a synthetic image of six random
digits and asks Codex to read them; the expected value is not included in the
prompt. It does not use private photos, and its temporary image is removed.

Offline regression tests require no Codex CLI, credentials or network:

```powershell
.\.venv\Scripts\python.exe -m pip install -e ".[dev,codex]"
.\.venv\Scripts\python.exe -B -m pytest -q -p no:cacheprovider
```

They cover text/history behavior, sender and duplicate filtering, mixed and
separate image captions, follow-ups, reset/expiry/replacement, download byte limits,
format/metadata/pixel checks, and temporary-file cleanup on errors/cancellation.

If a live self-test fails, inspect the terminal error and check CLI compatibility,
model support, login, quota and connectivity before restarting the WeChat bot.
A Codex error is not necessarily a WeChat login error.

## 中文使用速查

在源码的 `python` 目录创建 `.venv`，安装 `.[codex]`，完成本机 Codex 登录，
再运行 `examples/codex_bot.py` 或双击 `start-codex.cmd`。只回应扫码账号，
不会通过微信执行电脑命令。不要同时运行旧机器人和新机器人。

先发一张图片，再发“图里有什么？”或“解释这个报错”即可追问；说明文字也可先发，
但分开发送会分别回复。新图替换旧图，最多保留 30 分钟；发送 `/reset` 同时清空
文字与图片上下文。支持不超过 10 MiB、2500 万像素的 JPG/PNG/WebP/静态 GIF。
图片会移除元数据并缩至最长边 2048 像素；小字不清楚时请裁剪后重发。

`--self-test` 和 `--self-test-image` 分别检查文字、图片调用，不连接微信。
本桥接会把文字和图片提交给 Codex/OpenAI，不是离线识别。断电或强制结束可能留下
`.codex-wechat/images` 临时文件，停止所有机器人后再手动清理。

Official references: [non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode),
[CLI arguments and image attachments](https://learn.chatgpt.com/docs/cli/reference).

"""Main WeChatBot client — orchestrates all SDK components."""

from __future__ import annotations

import asyncio
import hashlib
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable, Union
from urllib.parse import quote

import aiohttp

from .auth import clear_credentials, load_credentials, login
from .crypto import (
    decode_aes_key,
    decrypt_aes_ecb,
    encode_aes_key_base64,
    encode_aes_key_hex,
    encrypt_aes_ecb,
    generate_aes_key,
)
from .errors import ApiError, MediaError, NoContextError
from .protocol import CDN_BASE_URL, DEFAULT_BASE_URL, ILinkApi
from .types import (
    CDNMedia,
    Credentials,
    DownloadedMedia,
    FileContent,
    ImageContent,
    IncomingMessage,
    MediaType,
    MessageItemType,
    MessageType,
    QuotedMessage,
    UploadResult,
    VideoContent,
    VoiceContent,
)

MessageHandler = Callable[[IncomingMessage], Any]

# SendContent: str for text, or dict for media
# Examples:
#   "Hello!"                          → text
#   {"text": "Hello!"}                → text
#   {"image": bytes_data}             → image
#   {"video": bytes_data}             → video
#   {"file": bytes_data, "file_name": "report.pdf"} → file
SendContent = Union[str, dict[str, Any]]


class WeChatBot:
    """WeChat iLink Bot client.

    Usage::

        bot = WeChatBot()
        await bot.login()

        @bot.on_message
        async def handle(msg):
            await bot.send_typing(msg.user_id)
            await bot.reply(msg, f"Echo: {msg.text}")

        await bot.start()
    """

    def __init__(
        self,
        *,
        base_url: str | None = None,
        cred_path: str | None = None,
        on_qr_url: Callable[[str], None] | None = None,
        on_scanned: Callable[[], None] | None = None,
        on_expired: Callable[[], None] | None = None,
        on_error: Callable[[Exception], None] | None = None,
    ) -> None:
        self._base_url = base_url or DEFAULT_BASE_URL
        self._cred_path = Path(cred_path) if cred_path else None
        self._on_qr_url = on_qr_url
        self._on_scanned = on_scanned
        self._on_expired = on_expired
        self._on_error = on_error

        self._api = ILinkApi()
        self._credentials: Credentials | None = None
        self._context_tokens: dict[str, str] = {}
        self._handlers: list[MessageHandler] = []
        self._cursor = ""
        self._stopped = False

    # ── Auth ──────────────────────────────────────────────────────────

    async def login(self, *, force: bool = False) -> Credentials:
        """QR code login. Skips QR if stored credentials exist."""
        creds = await login(
            self._api,
            base_url=self._base_url,
            cred_path=self._cred_path,
            force=force,
            on_qr_url=self._on_qr_url,
            on_scanned=self._on_scanned,
            on_expired=self._on_expired,
        )
        self._credentials = creds
        self._base_url = creds.base_url
        self._log(f"Logged in as {creds.user_id}")
        return creds

    def get_credentials(self) -> Credentials | None:
        return self._credentials

    # ── Message Handlers ──────────────────────────────────────────────

    def on_message(self, handler: MessageHandler) -> MessageHandler:
        """Register a message handler. Can be used as a decorator."""
        self._handlers.append(handler)
        return handler

    # ── Sending ───────────────────────────────────────────────────────

    async def reply(self, msg: IncomingMessage, content: SendContent) -> None:
        """Reply to an incoming message.

        Accepts text string or media dict::

            await bot.reply(msg, "Hello!")
            await bot.reply(msg, {"image": png_bytes})
            await bot.reply(msg, {"file": data, "file_name": "report.pdf"})
            await bot.reply(msg, {"video": mp4_bytes, "caption": "Check this"})
        """
        self._context_tokens[msg.user_id] = msg._context_token
        await self._send_content(msg.user_id, msg._context_token, content)
        try:
            await self.stop_typing(msg.user_id)
        except Exception:
            pass

    async def send(self, user_id: str, content: SendContent) -> None:
        """Send content to a user (requires prior context_token)."""
        ct = self._context_tokens.get(user_id)
        if not ct:
            raise NoContextError(user_id)
        await self._send_content(user_id, ct, content)

    # ── Download ───────────────────────────────────────────────────

    async def download(self, msg: IncomingMessage) -> DownloadedMedia | None:
        """Download media from an incoming message.

        Returns None if the message has no media.
        Priority: image > file > video > voice.
        """
        # Image
        if msg.images:
            img = msg.images[0]
            if img.media:
                data = await self._cdn_download(img.media, img.aes_key)
                return DownloadedMedia(data=data, type="image")

        # File
        if msg.files:
            f = msg.files[0]
            if f.media:
                data = await self._cdn_download(f.media)
                return DownloadedMedia(
                    data=data, type="file",
                    file_name=f.file_name or "file.bin",
                )

        # Video
        if msg.videos:
            v = msg.videos[0]
            if v.media:
                data = await self._cdn_download(v.media)
                return DownloadedMedia(data=data, type="video")

        # Voice
        if msg.voices:
            v = msg.voices[0]
            if v.media:
                data = await self._cdn_download(v.media)
                return DownloadedMedia(data=data, type="voice", format="silk")

        return None

    async def download_raw(self, media: CDNMedia, aeskey_override: str | None = None) -> bytes:
        """Download and decrypt a raw CDN media reference."""
        return await self._cdn_download(media, aeskey_override)

    # ── Upload ─────────────────────────────────────────────────────

    async def upload(
        self,
        data: bytes,
        user_id: str,
        media_type: int,
    ) -> UploadResult:
        """Upload a file to WeChat CDN. Does NOT send a message."""
        creds = self._require_creds()
        return await self._cdn_upload(creds, data, user_id, media_type)

    async def send_typing(self, user_id: str) -> None:
        """Show 'typing...' indicator."""
        ct = self._context_tokens.get(user_id)
        if not ct:
            return
        creds = self._require_creds()
        config = await self._api.get_config(creds.base_url, creds.token, user_id, ct)
        ticket = config.get("typing_ticket")
        if ticket:
            await self._api.send_typing(creds.base_url, creds.token, user_id, ticket, 1)

    async def stop_typing(self, user_id: str) -> None:
        """Cancel 'typing...' indicator."""
        ct = self._context_tokens.get(user_id)
        if not ct:
            return
        creds = self._require_creds()
        config = await self._api.get_config(creds.base_url, creds.token, user_id, ct)
        ticket = config.get("typing_ticket")
        if ticket:
            await self._api.send_typing(creds.base_url, creds.token, user_id, ticket, 2)

    # ── Lifecycle ─────────────────────────────────────────────────────

    async def start(self) -> None:
        """Start the long-poll loop. Blocks until stop() is called."""
        creds = self._require_creds()
        self._stopped = False
        self._log("Long-poll started")
        retry_delay = 1.0

        while not self._stopped:
            try:
                creds = self._require_creds()
                updates = await self._api.get_updates(
                    creds.base_url, creds.token, self._cursor
                )

                buf = updates.get("get_updates_buf")
                if buf:
                    self._cursor = buf
                retry_delay = 1.0

                for raw in updates.get("msgs", []):
                    self._remember_context(raw)
                    msg = self._parse_message(raw)
                    if msg:
                        await self._dispatch(msg)

            except ApiError as e:
                if e.is_session_expired:
                    self._log("Session expired — re-login")
                    await clear_credentials(self._cred_path)
                    self._context_tokens.clear()
                    self._cursor = ""
                    try:
                        await self.login(force=True)
                        retry_delay = 1.0
                        continue
                    except Exception as login_err:
                        self._report_error(login_err)
                else:
                    self._report_error(e)

                await asyncio.sleep(retry_delay)
                retry_delay = min(retry_delay * 2, 10.0)

            except asyncio.CancelledError:
                break

            except Exception as e:
                if self._stopped:
                    break
                self._report_error(e)
                await asyncio.sleep(retry_delay)
                retry_delay = min(retry_delay * 2, 10.0)

        self._log("Long-poll stopped")

    def stop(self) -> None:
        """Stop the long-poll loop."""
        self._stopped = True

    def run(self) -> None:
        """Synchronous entry: login + start. Convenience for scripts."""
        asyncio.run(self._run_sync())

    async def _run_sync(self) -> None:
        await self.login()
        await self.start()

    # ── Internal: send pipeline ──────────────────────────────────────

    async def _send_content(
        self, user_id: str, context_token: str, content: SendContent,
    ) -> None:
        # String shorthand → text
        if isinstance(content, str):
            await self._send_text(user_id, content, context_token)
            return

        # {"text": ...}
        if "text" in content:
            await self._send_text(user_id, content["text"], context_token)
            return

        # {"image": bytes}
        if "image" in content:
            await self._send_media_buffer(
                user_id, context_token, content["image"],
                MediaType.IMAGE,
                lambda result: {"type": int(MessageItemType.IMAGE), "image_item": {
                    "media": _cdn_media_dict(result.media),
                    "mid_size": result.encrypted_file_size,
                }},
                content.get("caption"),
            )
            return

        # {"video": bytes}
        if "video" in content:
            await self._send_media_buffer(
                user_id, context_token, content["video"],
                MediaType.VIDEO,
                lambda result: {"type": int(MessageItemType.VIDEO), "video_item": {
                    "media": _cdn_media_dict(result.media),
                    "video_size": result.encrypted_file_size,
                }},
                content.get("caption"),
            )
            return

        # {"file": bytes, "file_name": str}
        if "file" in content:
            file_name = content.get("file_name", "file.bin")
            category = _categorize_by_extension(file_name)

            if category == "image":
                await self._send_content(user_id, context_token, {
                    "image": content["file"], "caption": content.get("caption"),
                })
                return

            if category == "video":
                await self._send_content(user_id, context_token, {
                    "video": content["file"], "caption": content.get("caption"),
                })
                return

            # Generic file
            caption = content.get("caption")
            if caption:
                await self._send_text(user_id, caption, context_token)
            raw_data = content["file"]
            await self._send_media_buffer(
                user_id, context_token, raw_data,
                MediaType.FILE,
                lambda result: {"type": int(MessageItemType.FILE), "file_item": {
                    "media": _cdn_media_dict(result.media),
                    "file_name": file_name,
                    "len": str(len(raw_data)),
                }},
            )
            return

        raise ValueError(f"Unsupported content type: {content!r}")

    async def _send_media_buffer(
        self,
        user_id: str,
        context_token: str,
        data: bytes,
        media_type: int,
        build_item: Callable[[UploadResult], dict[str, Any]],
        caption: str | None = None,
    ) -> None:
        creds = self._require_creds()
        result = await self._cdn_upload(creds, data, user_id, media_type)
        items: list[dict[str, Any]] = []
        if caption:
            items.append({"type": int(MessageItemType.TEXT), "text_item": {"text": caption}})
        items.append(build_item(result))
        msg = self._api.build_media_message(user_id, context_token, items)
        await self._api.send_message(creds.base_url, creds.token, msg)
        self._log(f"Sent media type={media_type} to {user_id} ({len(data)} bytes)")

    # ── Internal: CDN download ─────────────────────────────────────

    async def _cdn_download(
        self, media: CDNMedia, aeskey_override: str | None = None,
    ) -> bytes:
        url = f"{CDN_BASE_URL}/download?encrypted_query_param={quote(media.encrypt_query_param)}"
        timeout = aiohttp.ClientTimeout(total=60)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(url) as resp:
                if resp.status >= 400:
                    raise MediaError(f"CDN download failed: HTTP {resp.status}")
                ciphertext = await resp.read()

        key_source = aeskey_override or media.aes_key
        if not key_source:
            raise MediaError("No AES key available for decryption")

        aes_key = decode_aes_key(key_source)
        return decrypt_aes_ecb(ciphertext, aes_key)

    # ── Internal: CDN upload ───────────────────────────────────────

    async def _cdn_upload(
        self,
        creds: Credentials,
        data: bytes,
        user_id: str,
        media_type: int,
    ) -> UploadResult:
        aes_key = generate_aes_key()
        ciphertext = encrypt_aes_ecb(data, aes_key)
        filekey = os.urandom(16).hex()
        raw_md5 = hashlib.md5(data).hexdigest()

        upload_info = await self._api.get_upload_url(
            creds.base_url, creds.token,
            {
                "filekey": filekey,
                "media_type": media_type,
                "to_user_id": user_id,
                "rawsize": len(data),
                "rawfilemd5": raw_md5,
                "filesize": len(ciphertext),
                "no_need_thumb": True,
                "aeskey": encode_aes_key_hex(aes_key),
            },
        )

        upload_param = upload_info.get("upload_param")
        if not upload_param:
            raise MediaError("getuploadurl did not return upload_param")

        upload_url = (
            f"{CDN_BASE_URL}/upload"
            f"?encrypted_query_param={quote(upload_param)}"
            f"&filekey={quote(filekey)}"
        )

        timeout = aiohttp.ClientTimeout(total=60)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(
                upload_url,
                data=ciphertext,
                headers={"Content-Type": "application/octet-stream"},
            ) as resp:
                if resp.status >= 400:
                    err_msg = resp.headers.get("x-error-message", f"HTTP {resp.status}")
                    raise MediaError(f"CDN upload failed: {err_msg}")

                encrypt_query_param = resp.headers.get("x-encrypted-param")
                if not encrypt_query_param:
                    raise MediaError("CDN upload succeeded but x-encrypted-param header missing")

        return UploadResult(
            media=CDNMedia(
                encrypt_query_param=encrypt_query_param,
                aes_key=encode_aes_key_base64(aes_key),
                encrypt_type=1,
            ),
            aes_key=aes_key,
            encrypted_file_size=len(ciphertext),
        )

    # ── Internal: text ─────────────────────────────────────────────

    async def _send_text(self, user_id: str, text: str, context_token: str) -> None:
        if not text:
            raise ValueError("Message text cannot be empty")
        creds = self._require_creds()
        for chunk in _chunk_text(text, 2000):
            msg = self._api.build_text_message(user_id, context_token, chunk)
            await self._api.send_message(creds.base_url, creds.token, msg)

    def _remember_context(self, raw: dict[str, Any]) -> None:
        mt = raw.get("message_type")
        uid = raw.get("from_user_id") if mt == MessageType.USER else raw.get("to_user_id")
        ct = raw.get("context_token")
        if uid and ct:
            self._context_tokens[uid] = ct

    def _parse_message(self, raw: dict[str, Any]) -> IncomingMessage | None:
        if raw.get("message_type") != MessageType.USER:
            return None

        items = raw.get("item_list", [])
        images, voices, files, videos = [], [], [], []
        quoted = None

        for item in items:
            t = item.get("type")
            if t == MessageItemType.IMAGE and item.get("image_item"):
                ii = item["image_item"]
                media = _parse_cdn_media(ii.get("media"))
                images.append(ImageContent(
                    media=media, thumb_media=_parse_cdn_media(ii.get("thumb_media")),
                    aes_key=ii.get("aeskey"), url=ii.get("url"),
                    width=ii.get("thumb_width"), height=ii.get("thumb_height"),
                ))
            elif t == MessageItemType.VOICE and item.get("voice_item"):
                vi = item["voice_item"]
                voices.append(VoiceContent(
                    media=_parse_cdn_media(vi.get("media")),
                    text=vi.get("text"), duration_ms=vi.get("playtime"),
                    encode_type=vi.get("encode_type"),
                ))
            elif t == MessageItemType.FILE and item.get("file_item"):
                fi = item["file_item"]
                size = None
                if fi.get("len"):
                    try:
                        size = int(fi["len"])
                    except (ValueError, TypeError):
                        pass
                files.append(FileContent(
                    media=_parse_cdn_media(fi.get("media")),
                    file_name=fi.get("file_name"), md5=fi.get("md5"), size=size,
                ))
            elif t == MessageItemType.VIDEO and item.get("video_item"):
                vi = item["video_item"]
                videos.append(VideoContent(
                    media=_parse_cdn_media(vi.get("media")),
                    thumb_media=_parse_cdn_media(vi.get("thumb_media")),
                    duration_ms=vi.get("play_length"),
                ))
            if item.get("ref_msg"):
                ref = item["ref_msg"]
                qt = ref.get("message_item", {}).get("text_item", {}).get("text")
                quoted = QuotedMessage(title=ref.get("title"), text=qt)

        return IncomingMessage(
            user_id=raw["from_user_id"],
            text=_extract_text(items),
            type=_detect_type(items),
            timestamp=datetime.fromtimestamp(
                raw.get("create_time_ms", 0) / 1000, tz=timezone.utc
            ),
            images=images, voices=voices, files=files, videos=videos,
            quoted_message=quoted, raw=raw,
            _context_token=raw.get("context_token", ""),
        )

    async def _dispatch(self, msg: IncomingMessage) -> None:
        for handler in self._handlers:
            try:
                result = handler(msg)
                if asyncio.iscoroutine(result) or asyncio.isfuture(result):
                    await result
            except Exception as e:
                self._report_error(e)

    def _require_creds(self) -> Credentials:
        if not self._credentials:
            raise RuntimeError("Not logged in. Call login() first.")
        return self._credentials

    def _report_error(self, err: Any) -> None:
        self._log(str(err))
        if self._on_error and isinstance(err, Exception):
            self._on_error(err)

    def _log(self, msg: str) -> None:
        print(f"[wechatbot] {msg}", file=sys.stderr)


def _detect_type(items: list[dict[str, Any]]) -> str:
    if not items:
        return "text"
    t = items[0].get("type")
    return {
        MessageItemType.IMAGE: "image",
        MessageItemType.VOICE: "voice",
        MessageItemType.FILE: "file",
        MessageItemType.VIDEO: "video",
    }.get(t, "text")


def _extract_text(items: list[dict[str, Any]]) -> str:
    parts = []
    for item in items:
        t = item.get("type")
        if t == MessageItemType.TEXT:
            parts.append(item.get("text_item", {}).get("text", ""))
        elif t == MessageItemType.IMAGE:
            parts.append(item.get("image_item", {}).get("url", "[image]"))
        elif t == MessageItemType.VOICE:
            parts.append(item.get("voice_item", {}).get("text", "[voice]"))
        elif t == MessageItemType.FILE:
            parts.append(item.get("file_item", {}).get("file_name", "[file]"))
        elif t == MessageItemType.VIDEO:
            parts.append("[video]")
    return "\n".join(p for p in parts if p)


def _chunk_text(text: str, limit: int) -> list[str]:
    if len(text) <= limit:
        return [text]
    chunks = []
    while text:
        if len(text) <= limit:
            chunks.append(text)
            break
        window = text[:limit]
        cut = -1
        idx = window.rfind("\n\n")
        if idx > limit * 3 // 10:
            cut = idx + 2
        if cut == -1:
            idx = window.rfind("\n")
            if idx > limit * 3 // 10:
                cut = idx + 1
        if cut == -1:
            idx = window.rfind(" ")
            if idx > limit * 3 // 10:
                cut = idx + 1
        if cut == -1:
            cut = limit
        chunks.append(text[:cut])
        text = text[cut:]
    return chunks or [""]


_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"}
_VIDEO_EXTS = {".mp4", ".mov", ".webm", ".mkv", ".avi"}


def _categorize_by_extension(filename: str) -> str:
    """Determine media category from file extension."""
    ext = Path(filename).suffix.lower()
    if ext in _IMAGE_EXTS:
        return "image"
    if ext in _VIDEO_EXTS:
        return "video"
    return "file"


def _cdn_media_dict(media: CDNMedia) -> dict[str, Any]:
    """Convert CDNMedia dataclass to dict for JSON serialization."""
    d: dict[str, Any] = {
        "encrypt_query_param": media.encrypt_query_param,
        "aes_key": media.aes_key,
    }
    if media.encrypt_type is not None:
        d["encrypt_type"] = media.encrypt_type
    return d


def _parse_cdn_media(data: dict[str, Any] | None) -> CDNMedia | None:
    if not data:
        return None
    return CDNMedia(
        encrypt_query_param=data.get("encrypt_query_param", ""),
        aes_key=data.get("aes_key", ""),
        encrypt_type=data.get("encrypt_type"),
    )

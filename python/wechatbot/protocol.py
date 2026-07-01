"""Raw iLink Bot API HTTP calls."""

from __future__ import annotations

import base64
import json
import os
import re
import struct
from importlib.metadata import version as pkg_version
from typing import Any
from urllib.parse import quote
from uuid import uuid4

import aiohttp

from .errors import ApiError
from .types import MediaType, MessageItemType, MessageState, MessageType

DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com"
CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c"

# Read version from package metadata; fall back to pyproject.toml parsing
try:
    CHANNEL_VERSION = pkg_version("wechatbot-sdk")
except Exception:
    CHANNEL_VERSION = "0.1.0"

# iLink-App-Id header value
ILINK_APP_ID = "bot"


def _build_client_version() -> str:
    """Encode version as 0x00MMNNPP uint32 string."""
    parts = CHANNEL_VERSION.split(".")
    try:
        major = int(parts[0]) & 0xFF if len(parts) > 0 else 0
        minor = int(parts[1]) & 0xFF if len(parts) > 1 else 0
        patch = int(parts[2]) & 0xFF if len(parts) > 2 else 0
    except (ValueError, IndexError):
        major = minor = patch = 0
    return str((major << 16) | (minor << 8) | patch)


ILINK_APP_CLIENT_VERSION = _build_client_version()


def random_wechat_uin() -> str:
    val = struct.unpack(">I", os.urandom(4))[0]
    return base64.b64encode(str(val).encode("utf-8")).decode("ascii")


def _common_headers() -> dict[str, str]:
    """Headers included in both GET and POST requests."""
    return {
        "iLink-App-Id": ILINK_APP_ID,
        "iLink-App-ClientVersion": ILINK_APP_CLIENT_VERSION,
    }


def auth_headers(token: str) -> dict[str, str]:
    return {
        "Content-Type": "application/json",
        "AuthorizationType": "ilink_bot_token",
        "Authorization": f"Bearer {token}",
        "X-WECHAT-UIN": random_wechat_uin(),
        **_common_headers(),
    }


# Default bot_agent when none is configured or the configured value is invalid.
DEFAULT_BOT_AGENT = f"WeChatBot/{CHANNEL_VERSION}"

# Maximum length (bytes) of the sanitized bot_agent string.
_BOT_AGENT_MAX_LEN = 256

# UA-style grammar (matches openclaw-weixin):
#   bot_agent = product *( SP product )
#   product   = name "/" version [ SP "(" comment ")" ]
_PRODUCT = r"[A-Za-z0-9_.\-]{1,32}/[A-Za-z0-9_.+\-]{1,32}(?: \([\x20-\x27\x2A-\x7E]{1,64}\))?"
_BOT_AGENT_RE = re.compile(rf"^{_PRODUCT}(?: {_PRODUCT})*$")


def sanitize_bot_agent(raw: str | None) -> str:
    """Validate a user-supplied bot_agent into a wire-safe string.

    Unlike upstream openclaw-weixin (which salvages the valid tokens out of a
    partially invalid string), any invalid input falls back to
    DEFAULT_BOT_AGENT wholesale — simpler and just as safe on the wire.
    """
    if not raw:
        return DEFAULT_BOT_AGENT
    normalized = " ".join(raw.split())
    if not normalized or len(normalized.encode("utf-8")) > _BOT_AGENT_MAX_LEN:
        return DEFAULT_BOT_AGENT
    return normalized if _BOT_AGENT_RE.match(normalized) else DEFAULT_BOT_AGENT


async def _parse_response(resp: aiohttp.ClientResponse, label: str) -> dict[str, Any]:
    text = await resp.text()
    payload: dict[str, Any] = json.loads(text) if text else {}

    if resp.status >= 400:
        msg = payload.get("errmsg") or f"{label} failed with HTTP {resp.status}"
        raise ApiError(
            msg,
            http_status=resp.status,
            errcode=payload.get("errcode", 0),
            payload=payload,
        )

    ret = payload.get("ret")
    errcode = payload.get("errcode")
    if (isinstance(ret, int) and ret != 0) or (isinstance(errcode, int) and errcode != 0):
        code = errcode if isinstance(errcode, int) and errcode != 0 else (ret or 0)
        msg = payload.get("errmsg") or f"{label} failed (ret={ret} errcode={errcode})"
        raise ApiError(msg, http_status=resp.status, errcode=code, payload=payload)

    return payload


class ILinkApi:
    """Low-level iLink API client. Each method maps 1:1 to an endpoint."""

    def __init__(self, *, bot_agent: str | None = None) -> None:
        self._timeout = aiohttp.ClientTimeout(total=45)
        self._bot_agent = sanitize_bot_agent(bot_agent)

    def _base_info(self) -> dict[str, str]:
        return {"channel_version": CHANNEL_VERSION, "bot_agent": self._bot_agent}

    async def get_qr_code(
        self, base_url: str, local_token_list: list[str] | None = None
    ) -> dict[str, Any]:
        """Request a login QR code.

        local_token_list carries up to 10 known local bot tokens (newest
        first) so the server can answer binded_redirect for an already-bound
        bot instead of issuing a duplicate session.
        """
        url = f"{base_url}/ilink/bot/get_bot_qrcode?bot_type=3"
        body = {"local_token_list": local_token_list or []}
        async with aiohttp.ClientSession() as session:
            async with session.post(
                url, headers=_common_headers(), json=body
            ) as resp:
                return await _parse_response(resp, "get_bot_qrcode")

    async def poll_qr_status(
        self, base_url: str, qrcode: str, verify_code: str | None = None
    ) -> dict[str, Any]:
        """Poll the QR scan status.

        verify_code submits a pairing code after the server answered
        need_verifycode (the digits shown in WeChat on the user's phone).
        """
        url = f"{base_url}/ilink/bot/get_qrcode_status?qrcode={quote(qrcode, safe='')}"
        if verify_code:
            url += f"&verify_code={quote(verify_code, safe='')}"
        async with aiohttp.ClientSession() as session:
            async with session.get(
                url, headers=_common_headers()
            ) as resp:
                return await _parse_response(resp, "get_qrcode_status")

    async def get_updates(
        self, base_url: str, token: str, cursor: str
    ) -> dict[str, Any]:
        body = {"get_updates_buf": cursor, "base_info": self._base_info()}
        return await self._post(base_url, "/ilink/bot/getupdates", token, body, 45)

    async def send_message(
        self, base_url: str, token: str, msg: dict[str, Any]
    ) -> dict[str, Any]:
        body = {"msg": msg, "base_info": self._base_info()}
        return await self._post(base_url, "/ilink/bot/sendmessage", token, body)

    async def get_config(
        self, base_url: str, token: str, user_id: str, context_token: str
    ) -> dict[str, Any]:
        body = {
            "ilink_user_id": user_id,
            "context_token": context_token,
            "base_info": self._base_info(),
        }
        return await self._post(base_url, "/ilink/bot/getconfig", token, body)

    async def send_typing(
        self,
        base_url: str,
        token: str,
        user_id: str,
        ticket: str,
        status: int,
    ) -> dict[str, Any]:
        body = {
            "ilink_user_id": user_id,
            "typing_ticket": ticket,
            "status": status,
            "base_info": self._base_info(),
        }
        return await self._post(base_url, "/ilink/bot/sendtyping", token, body)

    @staticmethod
    def build_media_message(
        user_id: str,
        context_token: str,
        item_list: list[dict[str, Any]],
    ) -> dict[str, Any]:
        return {
            "from_user_id": "",
            "to_user_id": user_id,
            "client_id": str(uuid4()),
            "message_type": MessageType.BOT,
            "message_state": MessageState.FINISH,
            "context_token": context_token,
            "item_list": item_list,
        }

    async def _post(
        self,
        base_url: str,
        endpoint: str,
        token: str,
        body: dict[str, Any],
        timeout_secs: int = 15,
    ) -> dict[str, Any]:
        url = f"{base_url.rstrip('/')}{endpoint}"
        timeout = aiohttp.ClientTimeout(total=timeout_secs)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(
                url, headers=auth_headers(token), json=body
            ) as resp:
                return await _parse_response(resp, endpoint)

    async def get_upload_url(
        self,
        base_url: str,
        token: str,
        *,
        filekey: str,
        media_type: int,
        to_user_id: str,
        rawsize: int,
        rawfilemd5: str,
        filesize: int,
        no_need_thumb: bool = True,
        aeskey: str = "",
    ) -> dict[str, Any]:
        body = {
            "filekey": filekey,
            "media_type": media_type,
            "to_user_id": to_user_id,
            "rawsize": rawsize,
            "rawfilemd5": rawfilemd5,
            "filesize": filesize,
            "no_need_thumb": no_need_thumb,
            "aeskey": aeskey,
            "base_info": self._base_info(),
        }
        return await self._post(base_url, "/ilink/bot/getuploadurl", token, body)

    async def upload_to_cdn(
        self,
        cdn_url: str,
        ciphertext: bytes,
    ) -> str:
        """Upload encrypted bytes to CDN with retry (up to 3 attempts).

        Returns the download encrypted_query_param from x-encrypted-param header.
        Raises on client errors (4xx) immediately; retries on server errors.
        """
        max_retries = 3
        last_err: Exception | None = None

        for attempt in range(1, max_retries + 1):
            try:
                async with aiohttp.ClientSession() as session:
                    async with session.post(
                        cdn_url,
                        data=ciphertext,
                        headers={"Content-Type": "application/octet-stream"},
                    ) as resp:
                        if 400 <= resp.status < 500:
                            err_msg = resp.headers.get("x-error-message", f"HTTP {resp.status}")
                            raise ApiError(
                                f"CDN upload client error {resp.status}: {err_msg}",
                                http_status=resp.status,
                                errcode=0,
                            )
                        if resp.status != 200:
                            err_msg = resp.headers.get("x-error-message", f"HTTP {resp.status}")
                            raise Exception(f"CDN upload server error {resp.status}: {err_msg}")

                        param = resp.headers.get("x-encrypted-param")
                        if not param:
                            raise Exception("CDN upload response missing x-encrypted-param header")
                        return param
            except ApiError:
                raise  # Client errors are definitive
            except Exception as e:
                last_err = e
                if attempt < max_retries:
                    continue

        raise last_err or Exception(f"CDN upload failed after {max_retries} attempts")

    @staticmethod
    def build_cdn_upload_url(cdn_base_url: str, upload_param: str, filekey: str) -> str:
        """Build CDN upload URL from params."""
        return (
            f"{cdn_base_url}/upload"
            f"?encrypted_query_param={quote(upload_param, safe='')}"
            f"&filekey={quote(filekey, safe='')}"
        )

    @staticmethod
    def build_text_message(
        user_id: str, context_token: str, text: str
    ) -> dict[str, Any]:
        return {
            "from_user_id": "",
            "to_user_id": user_id,
            "client_id": str(uuid4()),
            "message_type": MessageType.BOT,
            "message_state": MessageState.FINISH,
            "context_token": context_token,
            "item_list": [
                {"type": MessageItemType.TEXT, "text_item": {"text": text}}
            ],
        }

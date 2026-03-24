"""Raw iLink Bot API HTTP calls."""

from __future__ import annotations

import base64
import json
import os
import struct
from typing import Any
from urllib.parse import quote
from uuid import uuid4

import aiohttp

from .errors import ApiError
from .types import MediaType, MessageItemType, MessageState, MessageType

DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com"
CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c"
CHANNEL_VERSION = "2.0.0"


def random_wechat_uin() -> str:
    val = struct.unpack(">I", os.urandom(4))[0]
    return base64.b64encode(str(val).encode("utf-8")).decode("ascii")


def auth_headers(token: str) -> dict[str, str]:
    return {
        "Content-Type": "application/json",
        "AuthorizationType": "ilink_bot_token",
        "Authorization": f"Bearer {token}",
        "X-WECHAT-UIN": random_wechat_uin(),
    }


def _base_info() -> dict[str, str]:
    return {"channel_version": CHANNEL_VERSION}


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
    if isinstance(ret, int) and ret != 0:
        code = payload.get("errcode", ret)
        msg = payload.get("errmsg") or f"{label} failed (ret={ret})"
        raise ApiError(msg, http_status=resp.status, errcode=code, payload=payload)

    return payload


class ILinkApi:
    """Low-level iLink API client. Each method maps 1:1 to an endpoint."""

    def __init__(self) -> None:
        self._timeout = aiohttp.ClientTimeout(total=45)

    async def get_qr_code(self, base_url: str) -> dict[str, Any]:
        url = f"{base_url}/ilink/bot/get_bot_qrcode?bot_type=3"
        async with aiohttp.ClientSession() as session:
            async with session.get(url) as resp:
                return await _parse_response(resp, "get_bot_qrcode")

    async def poll_qr_status(self, base_url: str, qrcode: str) -> dict[str, Any]:
        url = f"{base_url}/ilink/bot/get_qrcode_status?qrcode={quote(qrcode, safe='')}"
        async with aiohttp.ClientSession() as session:
            async with session.get(
                url, headers={"iLink-App-ClientVersion": "1"}
            ) as resp:
                return await _parse_response(resp, "get_qrcode_status")

    async def get_updates(
        self, base_url: str, token: str, cursor: str
    ) -> dict[str, Any]:
        body = {"get_updates_buf": cursor, "base_info": _base_info()}
        return await self._post(base_url, "/ilink/bot/getupdates", token, body, 45)

    async def send_message(
        self, base_url: str, token: str, msg: dict[str, Any]
    ) -> dict[str, Any]:
        body = {"msg": msg, "base_info": _base_info()}
        return await self._post(base_url, "/ilink/bot/sendmessage", token, body)

    async def get_config(
        self, base_url: str, token: str, user_id: str, context_token: str
    ) -> dict[str, Any]:
        body = {
            "ilink_user_id": user_id,
            "context_token": context_token,
            "base_info": _base_info(),
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
            "base_info": _base_info(),
        }
        return await self._post(base_url, "/ilink/bot/sendtyping", token, body)

    async def get_upload_url(
        self,
        base_url: str,
        token: str,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        body = {**params, "base_info": _base_info()}
        return await self._post(base_url, "/ilink/bot/getuploadurl", token, body)

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

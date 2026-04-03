"""QR code login and credential persistence."""

from __future__ import annotations

import asyncio
import json
import os
import sys
from dataclasses import asdict
from pathlib import Path
from typing import Any, Callable

from .errors import AuthError
from .protocol import DEFAULT_BASE_URL, ILinkApi
from .types import Credentials

DEFAULT_CRED_DIR = Path.home() / ".wechatbot"
DEFAULT_CRED_PATH = DEFAULT_CRED_DIR / "credentials.json"
QR_POLL_INTERVAL = 2.0
MAX_QR_REFRESH_COUNT = 3
FIXED_QR_BASE_URL = "https://ilinkai.weixin.qq.com"


async def load_credentials(path: Path | None = None) -> Credentials | None:
    target = path or DEFAULT_CRED_PATH
    try:
        data = json.loads(target.read_text("utf-8"))
        return Credentials(
            token=data["token"],
            base_url=data.get("base_url") or data.get("baseUrl", ""),
            account_id=data.get("account_id") or data.get("accountId", ""),
            user_id=data.get("user_id") or data.get("userId", ""),
            saved_at=data.get("saved_at") or data.get("savedAt"),
        )
    except FileNotFoundError:
        return None
    except (json.JSONDecodeError, KeyError) as e:
        raise AuthError(f"Invalid credentials file: {e}") from e


async def save_credentials(creds: Credentials, path: Path | None = None) -> None:
    target = path or DEFAULT_CRED_PATH
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    payload = {
        "token": creds.token,
        "baseUrl": creds.base_url,
        "accountId": creds.account_id,
        "userId": creds.user_id,
        "savedAt": creds.saved_at,
    }
    target.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    target.chmod(0o600)


async def clear_credentials(path: Path | None = None) -> None:
    target = path or DEFAULT_CRED_PATH
    target.unlink(missing_ok=True)


async def login(
    api: ILinkApi,
    *,
    base_url: str = DEFAULT_BASE_URL,
    cred_path: Path | None = None,
    force: bool = False,
    on_qr_url: Callable[[str], None] | None = None,
    on_scanned: Callable[[], None] | None = None,
    on_expired: Callable[[], None] | None = None,
) -> Credentials:
    """QR code login. Returns stored credentials if available and force=False."""
    if not force:
        stored = await load_credentials(cred_path)
        if stored:
            return stored

    qr_refresh_count = 0
    while True:
        qr_refresh_count += 1
        if qr_refresh_count > MAX_QR_REFRESH_COUNT:
            raise AuthError(
                f"QR code expired {MAX_QR_REFRESH_COUNT} times — login aborted"
            )

        qr = await api.get_qr_code(FIXED_QR_BASE_URL)
        qr_url = qr["qrcode_img_content"]

        if on_qr_url:
            on_qr_url(qr_url)
        else:
            print(f"[wechatbot] Scan this URL in WeChat: {qr_url}", file=sys.stderr)

        last_status = ""
        current_poll_base_url = FIXED_QR_BASE_URL
        while True:
            status = await api.poll_qr_status(current_poll_base_url, qr["qrcode"])
            current = status["status"]

            if current != last_status:
                last_status = current
                if current == "scaned":
                    if on_scanned:
                        on_scanned()
                    else:
                        print("[wechatbot] QR scanned — confirm in WeChat", file=sys.stderr)
                elif current == "expired":
                    if on_expired:
                        on_expired()
                    else:
                        print("[wechatbot] QR expired — requesting new one", file=sys.stderr)
                elif current == "confirmed":
                    print("[wechatbot] Login confirmed", file=sys.stderr)

            if current == "confirmed":
                token = status.get("bot_token")
                bot_id = status.get("ilink_bot_id")
                user_id = status.get("ilink_user_id")
                if not token or not bot_id or not user_id:
                    raise AuthError("Login confirmed but missing credentials")

                from datetime import datetime, timezone

                creds = Credentials(
                    token=token,
                    base_url=status.get("baseurl") or base_url,
                    account_id=bot_id,
                    user_id=user_id,
                    saved_at=datetime.now(timezone.utc).isoformat(),
                )
                await save_credentials(creds, cred_path)
                return creds

            # Handle IDC redirect
            if current == "scaned_but_redirect":
                redirect_host = status.get("redirect_host")
                if redirect_host:
                    current_poll_base_url = f"https://{redirect_host}"
                    print(
                        f"[wechatbot] IDC redirect → {redirect_host}",
                        file=sys.stderr,
                    )
                await asyncio.sleep(QR_POLL_INTERVAL)
                continue

            if current == "expired":
                break

            await asyncio.sleep(QR_POLL_INTERVAL)

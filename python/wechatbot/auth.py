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


async def _read_verify_code(is_retry: bool) -> str:
    """Default pairing-code prompt: read a line from stdin."""
    prompt = (
        "Code mismatch — enter the pairing code shown in WeChat again: "
        if is_retry
        else "Enter the pairing code shown in WeChat on your phone: "
    )
    code = await asyncio.to_thread(input, prompt)
    return code.strip()


async def login(
    api: ILinkApi,
    *,
    base_url: str = DEFAULT_BASE_URL,
    cred_path: Path | None = None,
    force: bool = False,
    on_qr_url: Callable[[str], None] | None = None,
    on_scanned: Callable[[], None] | None = None,
    on_expired: Callable[[], None] | None = None,
    on_verify_code: Callable[[bool], str] | None = None,
) -> Credentials:
    """QR code login. Returns stored credentials if available and force=False."""
    stored = await load_credentials(cred_path)
    if not force and stored:
        return stored

    # Send known local tokens so the server can answer binded_redirect
    # instead of issuing a duplicate session for an already-bound bot.
    local_token_list = [stored.token] if stored and stored.token else []

    qr_refresh_count = 0
    while True:
        qr_refresh_count += 1
        if qr_refresh_count > MAX_QR_REFRESH_COUNT:
            raise AuthError(
                f"QR code expired {MAX_QR_REFRESH_COUNT} times — login aborted"
            )

        qr = await api.get_qr_code(FIXED_QR_BASE_URL, local_token_list)
        qr_url = qr["qrcode_img_content"]

        if on_qr_url:
            on_qr_url(qr_url)
        else:
            print(f"[wechatbot] Scan this URL in WeChat: {qr_url}", file=sys.stderr)

        last_status = ""
        current_poll_base_url = FIXED_QR_BASE_URL
        # Pairing code awaiting server verification (pair-code login flow)
        pending_verify_code: str | None = None
        while True:
            status = await api.poll_qr_status(
                current_poll_base_url, qr["qrcode"], pending_verify_code
            )
            current = status["status"]

            if current != last_status:
                last_status = current
                if current == "scaned":
                    # A pending pairing code that leads back to scaned was accepted
                    pending_verify_code = None
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

            # Pair-code challenge: ask the user for the digits shown in WeChat
            if current == "need_verifycode":
                is_retry = pending_verify_code is not None
                if on_verify_code:
                    pending_verify_code = on_verify_code(is_retry)
                else:
                    pending_verify_code = await _read_verify_code(is_retry)
                continue  # Re-poll immediately with the code attached

            # Too many wrong pairing codes: server blocked this QR — get a new one
            if current == "verify_code_blocked":
                print(
                    "[wechatbot] Pairing code blocked after repeated mismatches "
                    "— requesting new QR",
                    file=sys.stderr,
                )
                pending_verify_code = None
                break  # Outer loop requests a new QR (counts toward refresh limit)

            # Already bound to this client: reuse existing local credentials
            if current == "binded_redirect":
                if stored:
                    print(
                        "[wechatbot] Bot already bound — reusing stored credentials",
                        file=sys.stderr,
                    )
                    return stored
                raise AuthError(
                    "Server reports this bot is already bound to this client "
                    "(binded_redirect), but no local credentials were found"
                )

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

"""Type definitions for the WeChat Bot SDK."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import IntEnum
from typing import Any, Literal


class MessageType(IntEnum):
    USER = 1
    BOT = 2


class MessageState(IntEnum):
    NEW = 0
    GENERATING = 1
    FINISH = 2


class MessageItemType(IntEnum):
    TEXT = 1
    IMAGE = 2
    VOICE = 3
    FILE = 4
    VIDEO = 5


class MediaType(IntEnum):
    IMAGE = 1
    VIDEO = 2
    FILE = 3
    VOICE = 4


ContentType = Literal["text", "image", "voice", "file", "video"]


@dataclass
class CDNMedia:
    encrypt_query_param: str
    aes_key: str
    encrypt_type: int | None = None


@dataclass
class ImageContent:
    media: CDNMedia | None = None
    thumb_media: CDNMedia | None = None
    aes_key: str | None = None
    url: str | None = None
    width: int | None = None
    height: int | None = None


@dataclass
class VoiceContent:
    media: CDNMedia | None = None
    text: str | None = None
    duration_ms: int | None = None
    encode_type: int | None = None


@dataclass
class FileContent:
    media: CDNMedia | None = None
    file_name: str | None = None
    md5: str | None = None
    size: int | None = None


@dataclass
class VideoContent:
    media: CDNMedia | None = None
    thumb_media: CDNMedia | None = None
    duration_ms: int | None = None
    width: int | None = None
    height: int | None = None


@dataclass
class QuotedMessage:
    title: str | None = None
    text: str | None = None
    type: ContentType | None = None


@dataclass
class Credentials:
    token: str
    base_url: str
    account_id: str
    user_id: str
    saved_at: str | None = None


@dataclass
class DownloadedMedia:
    """Result of downloading media from a message."""
    data: bytes
    type: Literal["image", "file", "video", "voice"]
    file_name: str | None = None
    format: str | None = None


@dataclass
class UploadResult:
    """Result of uploading media to CDN."""
    media: CDNMedia
    aes_key: bytes
    encrypted_file_size: int


@dataclass
class IncomingMessage:
    user_id: str
    text: str
    type: ContentType
    timestamp: datetime
    images: list[ImageContent] = field(default_factory=list)
    voices: list[VoiceContent] = field(default_factory=list)
    files: list[FileContent] = field(default_factory=list)
    videos: list[VideoContent] = field(default_factory=list)
    quoted_message: QuotedMessage | None = None
    raw: dict[str, Any] = field(default_factory=dict)
    _context_token: str = ""

"""WeChat iLink Bot SDK for Python."""

from .types import (
    Credentials,
    IncomingMessage,
    ImageContent,
    VoiceContent,
    FileContent,
    VideoContent,
    QuotedMessage,
    ContentType,
    DownloadedMedia,
    UploadResult,
    MediaType,
)
from .client import SendContent, WeChatBot
from .errors import (
    WeChatBotError,
    ApiError,
    AuthError,
    NoContextError,
    MediaError,
)
from .crypto import (
    encrypt_aes_ecb,
    decrypt_aes_ecb,
    generate_aes_key,
    decode_aes_key,
    encrypted_size,
)

__all__ = [
    "WeChatBot",
    "SendContent",
    "Credentials",
    "IncomingMessage",
    "ImageContent",
    "VoiceContent",
    "FileContent",
    "VideoContent",
    "QuotedMessage",
    "ContentType",
    "DownloadedMedia",
    "UploadResult",
    "MediaType",
    "WeChatBotError",
    "ApiError",
    "AuthError",
    "NoContextError",
    "MediaError",
    "encrypt_aes_ecb",
    "decrypt_aes_ecb",
    "generate_aes_key",
    "decode_aes_key",
    "encrypted_size",
]

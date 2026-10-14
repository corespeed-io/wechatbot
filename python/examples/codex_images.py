"""Bounded image validation and in-memory attachment for the Codex example."""

from dataclasses import dataclass
from io import BytesIO
import warnings

try:
    from PIL import Image, ImageOps, UnidentifiedImageError
except ImportError as exc:
    raise RuntimeError(
        '图片支持需要 Pillow。请在 python 目录运行：'
        '.\\.venv\\Scripts\\python.exe -m pip install ".[codex]"'
    ) from exc

MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_IMAGE_PIXELS = 25_000_000
MAX_IMAGE_SIDE = 2048
IMAGE_TTL = 30 * 60


class ImageError(ValueError):
    """An image was rejected before being sent to the model."""


@dataclass(frozen=True)
class ChatImage:
    data: bytes
    number: int
    expires_at: float


def normalize_image(data: bytes) -> bytes:
    """Decode actual content, orient/resize, strip metadata and return a JPEG.

    No filename/URL from the incoming message is used as a local path.
    The original decrypted image is never written to disk.
    """
    if not data or len(data) > MAX_IMAGE_BYTES:
        raise ImageError("图片为空或超过 10 MiB，请压缩后重发。")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(data), formats=("JPEG", "PNG", "WEBP", "GIF")) as source:
                if source.width * source.height > MAX_IMAGE_PIXELS:
                    raise ImageError("图片超过 2500 万像素，请缩小后重发。")
                if getattr(source, "is_animated", False):
                    raise ImageError("暂不支持动图，请发送其中一帧的静态图片。")
                source.load()  # Force decoding: reject truncated/corrupted files.
                oriented = ImageOps.exif_transpose(source)
                oriented.thumbnail((MAX_IMAGE_SIDE, MAX_IMAGE_SIDE), Image.Resampling.LANCZOS)
                rgba = oriented.convert("RGBA")
                clean = Image.new("RGB", rgba.size, "white")
                clean.paste(rgba, mask=rgba.getchannel("A"))
                output = BytesIO()
                clean.save(output, format="JPEG", quality=92, subsampling=0)
                result = output.getvalue()
                if len(result) > MAX_IMAGE_BYTES:
                    raise ImageError("转换后的图片过大，请缩小后重发。")
                return result
    except ImageError:
        raise
    except (Image.DecompressionBombWarning, Image.DecompressionBombError) as exc:
        raise ImageError("图片像素过多，请缩小后重发。") from exc
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError) as exc:
        raise ImageError("图片损坏或格式不支持，请重新发送 JPG、PNG、WebP 或静态 GIF。") from exc

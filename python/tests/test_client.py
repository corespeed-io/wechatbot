"""Tests for client utilities."""

from wechatbot.client import (
    _categorize_by_extension,
    _cdn_media_dict,
    _chunk_text,
    _detect_type,
    _extract_text,
)
from wechatbot.types import CDNMedia


def test_chunk_short():
    assert _chunk_text("hello", 2000) == ["hello"]


def test_chunk_empty():
    assert _chunk_text("", 2000) == [""]


def test_chunk_at_paragraph():
    text = "A" * 1500 + "\n\n" + "B" * 1000
    chunks = _chunk_text(text, 2000)
    assert len(chunks) == 2
    assert chunks[0] == "A" * 1500 + "\n\n"


def test_chunk_hard_cut():
    text = "A" * 5000
    chunks = _chunk_text(text, 2000)
    assert len(chunks) == 3
    assert "".join(chunks) == text


def test_detect_type_text():
    assert _detect_type([{"type": 1}]) == "text"


def test_detect_type_image():
    assert _detect_type([{"type": 2}]) == "image"


def test_detect_type_empty():
    assert _detect_type([]) == "text"


def test_extract_text():
    items = [
        {"type": 1, "text_item": {"text": "Hello"}},
        {"type": 2, "image_item": {"url": "https://img.com/1.jpg"}},
    ]
    result = _extract_text(items)
    assert result == "Hello\nhttps://img.com/1.jpg"


# ── Media helpers ──────────────────────────────────────────────────


def test_categorize_image():
    assert _categorize_by_extension("photo.png") == "image"
    assert _categorize_by_extension("photo.JPG") == "image"
    assert _categorize_by_extension("anim.gif") == "image"


def test_categorize_video():
    assert _categorize_by_extension("clip.mp4") == "video"
    assert _categorize_by_extension("clip.MOV") == "video"


def test_categorize_file():
    assert _categorize_by_extension("report.pdf") == "file"
    assert _categorize_by_extension("data.csv") == "file"
    assert _categorize_by_extension("noext") == "file"


def test_cdn_media_dict():
    media = CDNMedia(encrypt_query_param="param=1", aes_key="key123", encrypt_type=1)
    d = _cdn_media_dict(media)
    assert d["encrypt_query_param"] == "param=1"
    assert d["aes_key"] == "key123"
    assert d["encrypt_type"] == 1


def test_cdn_media_dict_no_encrypt_type():
    media = CDNMedia(encrypt_query_param="p", aes_key="k")
    d = _cdn_media_dict(media)
    assert "encrypt_type" not in d

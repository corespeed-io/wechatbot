"""Bounded encrypted download checks using a fake CDN session."""

import unittest
from unittest.mock import AsyncMock, Mock, patch

from wechatbot import WeChatBot
from wechatbot.crypto import encrypt_aes_ecb
from wechatbot.errors import MediaError
from wechatbot.types import CDNMedia


class DownloadLimitTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.key = b"0123456789abcdef"
        self.media = CDNMedia("query", self.key.hex())
        self.response = AsyncMock()
        self.response.status = 200
        self.response.content_length = None
        session = Mock()
        session.get.return_value = AsyncMock()
        session.get.return_value.__aenter__.return_value = self.response
        context = AsyncMock()
        context.__aenter__.return_value = session
        factory = patch("wechatbot.client.aiohttp.ClientSession", return_value=context)
        factory.start()
        self.addCleanup(factory.stop)
        self.bot = WeChatBot()

    def response_data(self, data):
        ciphertext = encrypt_aes_ecb(data, self.key)

        async def chunks():
            for start in range(0, len(ciphertext), 8):
                yield ciphertext[start:start + 8]

        self.response.content.iter_chunked = Mock(return_value=chunks())
        self.response.read.return_value = ciphertext

    async def test_bounded_stream_download_and_key_override(self):
        self.response_data(b"image data")
        self.media.aes_key = "wrong-key"
        data = await self.bot.download_raw(self.media, self.key.hex(), max_bytes=10)
        self.assertEqual(data, b"image data")
        self.response.read.assert_not_awaited()

    async def test_oversized_content_length_rejected_before_reading(self):
        self.response_data(b"data")
        self.response.content_length = 1000000
        with self.assertRaises(MediaError):
            await self.bot.download_raw(self.media, max_bytes=10)
        self.response.content.iter_chunked.assert_not_called()

    async def test_oversized_stream_rejected_without_content_length(self):
        self.response_data(b"x" * 40)
        with self.assertRaises(MediaError):
            await self.bot.download_raw(self.media, max_bytes=10)

    async def test_decrypted_limit_even_when_ciphertext_fits_padding_budget(self):
        self.response_data(b"x" * 11)
        with self.assertRaises(MediaError):
            await self.bot.download_raw(self.media, max_bytes=10)

    async def test_exact_block_size_allows_full_padding_block(self):
        self.response_data(b"x" * 16)
        self.assertEqual(await self.bot.download_raw(self.media, max_bytes=16), b"x" * 16)

    async def test_unbounded_call_remains_compatible(self):
        self.response_data(b"data")
        self.assertEqual(await self.bot.download_raw(self.media), b"data")
        self.response.read.assert_awaited_once()

    async def test_http_error(self):
        self.response.status = 403
        with self.assertRaises(MediaError):
            await self.bot.download_raw(self.media, max_bytes=10)

    async def test_invalid_limit(self):
        for limit in (0, -1):
            with self.assertRaises(ValueError):
                await self.bot.download_raw(self.media, max_bytes=limit)


if __name__ == "__main__":
    unittest.main()

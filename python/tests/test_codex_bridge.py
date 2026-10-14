"""Bridge regression checks; no model calls or WeChat messages are sent."""

import asyncio
from datetime import datetime, timezone
import json
from io import BytesIO
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "examples"))
from codex_bot import CodexChat, CodexError, WeChatBridge, parse_reply
from codex_images import ChatImage, IMAGE_TTL, MAX_IMAGE_BYTES, normalize_image
from PIL import Image
from wechatbot.types import CDNMedia, ImageContent, IncomingMessage


def events(*items):
    return "\n".join(json.dumps(item) for item in items).encode()


def success(text="你好"):
    return events(
        {"type": "item.completed", "item": {"type": "agent_message", "text": text}},
        {"type": "turn.completed"},
    )


def message(text="你好", user="owner", **kwargs):
    return IncomingMessage(
        user_id=user, text=text, type="text", timestamp=datetime.now(timezone.utc), **kwargs
    )


def image_bytes(color="red"):
    buffer = BytesIO()
    Image.new("RGB", (30, 20), color).save(buffer, format="PNG")
    return buffer.getvalue()


def image_message(text="[image]", **kwargs):
    msg = message(text, images=[ImageContent(media=CDNMedia("encrypted-query", "key"), aes_key="override")], **kwargs)
    msg.type = "image"
    return msg


class ReplyTests(unittest.TestCase):
    def test_only_final_agent_text_is_returned(self):
        output = events(
            {"type": "item.completed", "item": {"type": "reasoning", "text": "private"}},
            {"type": "item.completed", "item": {"type": "agent_message", "text": "working"}},
        ) + b"\n" + success("final")
        self.assertEqual(parse_reply(output, b"", 0), "final")

    def test_partial_answer_on_failed_turn_is_not_returned(self):
        output = success() + b"\n" + events({"type": "turn.failed", "error": "quota"})
        with self.assertRaises(CodexError):
            parse_reply(output, b"", 1)

    def test_empty_or_incomplete_output_is_an_error(self):
        for output in (b"", events({"type": "turn.completed"}), b"not json"):
            with self.subTest(output=output), self.assertRaises(CodexError):
                parse_reply(output, b"", 0)


class BridgeTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.bot = AsyncMock()
        self.codex = AsyncMock()
        self.codex.ask.return_value = "你好，我是 Codex。"
        self.bridge = WeChatBridge(self.bot, self.codex, "owner")
        self.addCleanup(self.bridge.close)
        self.bot.download_raw.return_value = image_bytes()

    async def test_other_contacts_are_ignored(self):
        await self.bridge.handle(message(user="someone_else"))
        await self.bridge.handle(image_message(user="someone_else"))
        self.codex.ask.assert_not_awaited()
        self.bot.reply.assert_not_awaited()
        self.bot.download_raw.assert_not_awaited()

    async def test_context_and_reset(self):
        await self.bridge.handle(message("我叫小明"))
        await self.bridge.handle(message("我叫什么？"))
        history = self.codex.ask.call_args.args[0]
        self.assertEqual([m["role"] for m in history], ["user", "assistant", "user"])
        self.assertEqual(history[0]["content"], "我叫小明")
        await self.bridge.handle(message("/reset"))
        self.assertEqual(self.bridge.history, [])
        self.assertEqual(self.codex.ask.await_count, 2)

    async def test_duplicate_message_id_only_calls_codex_once(self):
        msg = message(raw={"message_id": "123"})
        await self.bridge.handle(msg)
        await self.bridge.handle(msg)
        self.assertEqual(self.codex.ask.await_count, 1)

    async def test_typing_failure_does_not_prevent_answer(self):
        self.bot.send_typing.side_effect = RuntimeError("typing unavailable")
        await self.bridge.handle(message())
        self.codex.ask.assert_awaited_once()
        self.assertEqual(len(self.bridge.history), 2)

    async def test_failure_does_not_leak_details_or_save_failed_history(self):
        self.codex.ask.side_effect = CodexError("private diagnostic")
        with patch("builtins.print"):
            await self.bridge.handle(message())
        self.assertEqual(self.bridge.history, [])
        self.assertNotIn("private diagnostic", self.bot.reply.call_args.args[1])

    async def test_history_is_bounded(self):
        for number in range(12):
            await self.bridge.handle(message(str(number)))
        self.assertEqual(len(self.bridge.history), 16)
        self.assertEqual(self.bridge.history[0]["content"], "4")

    async def test_old_messages_and_media_do_not_reach_model(self):
        old = message()
        old.timestamp = datetime(2020, 1, 1, tzinfo=timezone.utc)
        await self.bridge.handle(old)
        image = message()
        image.type = "image"
        await self.bridge.handle(image)
        self.codex.ask.assert_not_awaited()

    async def test_single_image_and_separate_followup_use_same_attachment(self):
        await self.bridge.handle(image_message())
        first = self.codex.ask.call_args.kwargs["image"]
        self.assertEqual(first.number, 1)
        self.assertIn("[图片 #1]", self.codex.ask.call_args.args[0][-1]["content"])
        self.bot.download_raw.assert_awaited_once_with(
            CDNMedia("encrypted-query", "key"), "override", max_bytes=MAX_IMAGE_BYTES)
        await self.bridge.handle(message("图里有什么？"))
        self.assertIs(self.codex.ask.call_args.kwargs["image"], first)
        self.assertEqual(self.bot.download_raw.await_count, 1)

    async def test_text_before_image_is_kept_as_context(self):
        await self.bridge.handle(message("请翻译我接下来发的图片"))
        await self.bridge.handle(image_message())
        self.assertEqual(self.codex.ask.call_args.args[0][0]["content"], "请翻译我接下来发的图片")
        self.assertIn("image", self.codex.ask.call_args.kwargs)

    async def test_mixed_message_uses_caption_not_media_url(self):
        msg = image_message(raw={"item_list": [
            {"type": 1, "text_item": {"text": "解读这张图"}},
            {"type": 2, "image_item": {"url": "https://secret.example/image"}},
        ]})
        msg.type = "text"  # SDK detects type from first item.
        await self.bridge.handle(msg)
        prompt = self.codex.ask.call_args.args[0][-1]["content"]
        self.assertEqual(prompt, "[图片 #1] 解读这张图")
        self.assertNotIn("secret.example", prompt)

    async def test_image_url_is_not_a_caption(self):
        msg = image_message("https://secret.example/image")
        msg.images[0].url = msg.text
        await self.bridge.handle(msg)
        self.assertNotIn("secret.example", self.codex.ask.call_args.args[0][-1]["content"])

    async def test_new_image_replaces_old_attachment(self):
        await self.bridge.handle(image_message())
        old = self.bridge.latest_image
        timer = self.bridge.image_expiry
        self.bot.download_raw.return_value = image_bytes("blue")
        await self.bridge.handle(image_message())
        self.assertNotEqual(self.bridge.latest_image.data, old.data)
        self.assertEqual(self.bridge.latest_image.number, 2)
        self.assertTrue(timer.cancelled())
        await self.bridge.handle(message("这张呢？"))
        self.assertEqual(self.codex.ask.call_args.kwargs["image"].number, 2)

    async def test_reset_discards_text_image_and_timer(self):
        await self.bridge.handle(image_message())
        timer = self.bridge.image_expiry
        await self.bridge.handle(message("/reset"))
        self.assertEqual(self.bridge.history, [])
        self.assertIsNone(self.bridge.latest_image)
        self.assertTrue(timer.cancelled())
        await self.bridge.handle(message("还记得图片吗？"))
        self.assertNotIn("image", self.codex.ask.call_args.kwargs)
        self.assertEqual(len(self.codex.ask.call_args.args[0]), 1)

    async def test_download_failure_clears_old_image_without_leaking_url(self):
        await self.bridge.handle(image_message())
        self.bot.download_raw.side_effect = RuntimeError("https://secret.example/key")
        with patch("builtins.print") as log:
            await self.bridge.handle(image_message())
        self.assertNotIn("secret.example", str(log.call_args_list))
        self.assertNotIn("secret.example", self.bot.reply.call_args.args[1])
        self.assertIsNone(self.bridge.latest_image)
        self.assertEqual(self.codex.ask.await_count, 1)
        await self.bridge.handle(message("看看这张图"))
        self.assertNotIn("image", self.codex.ask.call_args.kwargs)

    async def test_invalid_or_multiple_images_do_not_call_model(self):
        self.bot.download_raw.return_value = b"not an image"
        await self.bridge.handle(image_message())
        msg = image_message()
        msg.images.append(msg.images[0])
        await self.bridge.handle(msg)
        self.codex.ask.assert_not_awaited()
        self.assertIsNone(self.bridge.latest_image)
        self.assertEqual(self.bot.download_raw.await_count, 1)

    async def test_expired_image_is_not_sent(self):
        await self.bridge.handle(image_message())
        with patch("codex_bot.time.monotonic", return_value=time.monotonic() + IMAGE_TTL + 1):
            await self.bridge.handle(message("图里是什么？"))
        self.assertIsNone(self.bridge.latest_image)
        self.assertNotIn("image", self.codex.ask.call_args.kwargs)

    async def test_idle_timer_clears_image(self):
        with patch("codex_bot.IMAGE_TTL", 0.01):
            await self.bridge.handle(image_message())
            await asyncio.sleep(0.03)
        self.assertIsNone(self.bridge.latest_image)
        self.assertIsNone(self.bridge.image_expiry)

    async def test_model_failure_retains_image_for_retry(self):
        self.codex.ask.side_effect = CodexError("failure")
        with patch("builtins.print"):
            await self.bridge.handle(image_message())
        attachment = self.bridge.latest_image
        self.assertIsNotNone(attachment)
        self.assertEqual(self.bridge.history, [])
        self.codex.ask.side_effect = None
        await self.bridge.handle(message("再试一次"))
        self.assertIs(self.codex.ask.call_args.kwargs["image"], attachment)

    async def test_repeated_image_is_not_downloaded_again(self):
        msg = image_message(raw={"message_id": "image-123"})
        await self.bridge.handle(msg)
        await self.bridge.handle(msg)
        self.bot.download_raw.assert_awaited_once()

    async def test_image_caption_reset_is_not_a_command(self):
        await self.bridge.handle(image_message("/reset"))
        self.codex.ask.assert_awaited_once()
        self.assertIsNotNone(self.bridge.latest_image)

    async def test_download_cancellation_is_not_swallowed(self):
        self.bot.download_raw.side_effect = asyncio.CancelledError()
        with self.assertRaises(asyncio.CancelledError):
            await self.bridge.handle(image_message())
        self.codex.ask.assert_not_awaited()


class ProcessTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        replacement = patch("codex_bot.WORK_DIR", self.root / "workspace")
        replacement.start()
        self.addCleanup(replacement.stop)

    async def test_user_text_goes_to_stdin_not_command_line(self):
        chat = CodexChat("codex.exe")
        chat.run_process = AsyncMock(return_value=(success(), b"", 0))
        text = 'hello; $(Remove-Item example) " --model something'
        self.assertEqual(await chat.ask([{"role": "user", "content": text}]), "你好")
        args, prompt = chat.run_process.call_args.args
        self.assertNotIn(text, args)
        self.assertEqual(json.loads(prompt)["messages"][0]["content"], text)
        self.assertIn("--ignore-user-config", args)
        self.assertIn("read-only", args)
        self.assertIn("shell_tool", args)
        self.assertNotIn("--image", args)
        self.assertIsNone(json.loads(prompt)["attached_image"])

    async def test_image_attachment_exists_during_call_and_is_deleted_after(self):
        attachment = ChatImage(normalize_image(image_bytes()), 7, 100)
        seen = []

        async def run(args, prompt):
            path = Path(args[args.index("--image") + 1])
            seen.append(path)
            self.assertTrue(path.is_absolute())
            self.assertEqual(path.read_bytes(), attachment.data)
            self.assertEqual(json.loads(prompt)["attached_image"], 7)
            self.assertIn("view_image", args)  # Tool remains disabled; attachment is enough.
            self.assertEqual(args[-1], "-")
            return success(), b"", 0

        chat = CodexChat("codex.exe")
        chat.run_process = run
        await chat.ask([{"role": "user", "content": "看图"}], image=attachment)
        self.assertFalse(seen[0].exists())
        self.assertEqual(list((self.root / "images").iterdir()), [])

    async def test_image_temp_cleanup_on_error_timeout_or_cancellation(self):
        for error in (OSError("failure"), asyncio.TimeoutError(), asyncio.CancelledError()):
            with self.subTest(error=type(error).__name__):
                chat = CodexChat("codex.exe")
                chat.run_process = AsyncMock(side_effect=error)
                with self.assertRaises(type(error)):
                    await chat.ask([], image=ChatImage(normalize_image(image_bytes()), 1, 100))
                self.assertEqual(list((self.root / "images").iterdir()), [])

    async def test_timeout_kills_child_process(self):
        chat = CodexChat("codex.exe", timeout=0.01)
        process = AsyncMock()
        process.returncode = None
        from unittest.mock import Mock
        process.kill = Mock()
        process.communicate.side_effect = [asyncio.TimeoutError(), (b"", b"")]
        with patch("asyncio.create_subprocess_exec", AsyncMock(return_value=process)):
            with self.assertRaises(asyncio.TimeoutError):
                await chat.run_process(["exec"], "prompt")
        process.kill.assert_called_once()


if __name__ == "__main__":
    unittest.main()

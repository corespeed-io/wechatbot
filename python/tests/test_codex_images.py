"""Image format/resource validation, without network or model calls."""

from io import BytesIO
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "examples"))
from codex_images import ImageError, MAX_IMAGE_BYTES, normalize_image
from PIL import Image, PngImagePlugin


def encoded(image, format="PNG", **kwargs):
    buffer = BytesIO()
    image.save(buffer, format=format, **kwargs)
    return buffer.getvalue()


class ImageTests(unittest.TestCase):
    def test_supported_formats_are_normalized_to_rgb_jpeg(self):
        for format in ("PNG", "JPEG", "WEBP", "GIF"):
            with self.subTest(format=format):
                data = encoded(Image.new("RGB", (30, 20), "red"), format)
                with Image.open(BytesIO(normalize_image(data))) as result:
                    self.assertEqual(result.format, "JPEG")
                    self.assertEqual(result.mode, "RGB")
                    self.assertEqual(result.size, (30, 20))

    def test_exif_orientation_is_applied_and_metadata_removed(self):
        source = Image.new("RGB", (30, 20), "red")
        exif = Image.Exif()
        exif[274] = 6  # 90 degree rotation
        exif[270] = "private metadata"
        with Image.open(BytesIO(normalize_image(encoded(source, "JPEG", exif=exif)))) as result:
            self.assertEqual(result.size, (20, 30))
            self.assertEqual(len(result.getexif()), 0)

    def test_png_metadata_removed_and_transparency_on_white(self):
        metadata = PngImagePlugin.PngInfo()
        metadata.add_text("secret", "private")
        data = encoded(Image.new("RGBA", (30, 20), (0, 0, 0, 0)), pnginfo=metadata)
        with Image.open(BytesIO(normalize_image(data))) as result:
            self.assertNotIn("secret", result.info)
            self.assertEqual(result.getpixel((0, 0)), (255, 255, 255))

    def test_long_edge_is_resized(self):
        data = encoded(Image.new("RGB", (3000, 1500), "red"))
        with Image.open(BytesIO(normalize_image(data))) as result:
            self.assertEqual(result.size, (2048, 1024))

    def test_byte_size_empty_unsupported_and_corruption(self):
        inputs = (b"", b"x" * (MAX_IMAGE_BYTES + 1), b"not an image",
                  encoded(Image.new("RGB", (30, 20)), "BMP"),
                  encoded(Image.new("RGB", (30, 20)), "PNG")[:35])
        for data in inputs:
            with self.subTest(size=len(data)), self.assertRaises(ImageError):
                normalize_image(data)

    def test_pixel_limit_and_decompression_bomb_rejected(self):
        data = encoded(Image.new("RGB", (30, 20)))
        with patch("codex_images.MAX_IMAGE_PIXELS", 500), self.assertRaises(ImageError):
            normalize_image(data)
        with patch("PIL.Image.MAX_IMAGE_PIXELS", 500), self.assertRaises(ImageError):
            normalize_image(data)

    def test_animation_rejected(self):
        data = encoded(Image.new("RGB", (30, 20), "red"), "GIF", save_all=True,
                       append_images=[Image.new("RGB", (30, 20), "blue")], duration=100)
        with self.assertRaisesRegex(ImageError, "动图"):
            normalize_image(data)


if __name__ == "__main__":
    unittest.main()

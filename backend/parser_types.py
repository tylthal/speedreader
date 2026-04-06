"""Shared types for all ebook format parsers."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from enum import Enum

IMAGES_DIR = "/workspace/data/images"

_EXT_MAP = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
    "image/bmp": ".bmp",
    "image/tiff": ".tiff",
}


def save_inline_image(
    data: bytes,
    pub_uuid: str,
    counter: int,
    mime_type: str = "image/jpeg",
) -> tuple[str, int, int]:
    """Save image bytes to disk and return (relative_path, width, height).

    Parameters
    ----------
    data : raw image bytes
    pub_uuid : unique publication identifier for directory grouping
    counter : sequential image number for filename
    mime_type : MIME type of the image

    Returns (relative_path, width, height).
    """
    ext = _EXT_MAP.get(mime_type, ".jpg")
    safe_name = f"inline_{counter:04d}{ext}"
    rel_path = f"{pub_uuid}/{safe_name}"
    abs_path = os.path.join(IMAGES_DIR, rel_path)
    os.makedirs(os.path.dirname(abs_path), exist_ok=True)

    with open(abs_path, "wb") as f:
        f.write(data)

    width, height = 0, 0
    try:
        from PIL import Image
        with Image.open(abs_path) as img:
            width, height = img.size
    except Exception:
        pass

    return rel_path, width, height


class ContentType(str, Enum):
    TEXT = "text"
    IMAGE = "image"


@dataclass
class InlineImage:
    """An image embedded within text content (e.g., EPUB illustrations)."""
    placeholder: str  # unique marker in the text, e.g. "{{IMG_0}}"
    image_path: str   # relative path under data/images/{pub_uuid}/
    alt: str = ""
    width: int = 0
    height: int = 0
    mime_type: str = "image/jpeg"


@dataclass
class ParsedChapter:
    title: str
    text: str
    inline_images: list[InlineImage] = field(default_factory=list)


@dataclass
class ImagePage:
    page_index: int
    image_path: str  # relative path under data/images/{pub_uuid}/
    width: int
    height: int
    mime_type: str  # "image/jpeg", "image/png", "image/webp"


@dataclass
class ParsedImageChapter:
    title: str
    pages: list[ImagePage] = field(default_factory=list)


@dataclass
class ParsedBook:
    title: str
    author: str
    content_type: ContentType = ContentType.TEXT
    chapters: list[ParsedChapter] = field(default_factory=list)
    image_chapters: list[ParsedImageChapter] = field(default_factory=list)

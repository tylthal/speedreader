"""CBZ/CBR parser: extracts comic book pages as image content."""

from __future__ import annotations

import os
import re
import uuid
import zipfile
from xml.etree import ElementTree

from backend.parser_types import (
    ContentType, ImagePage, ParsedBook, ParsedImageChapter,
)

IMAGES_DIR = "/workspace/data/images"
_IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff"}
_MIME_MAP = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".tiff": "image/tiff",
}


def _natural_sort_key(s: str) -> list:
    """Sort strings with embedded numbers naturally (page1, page2, page10)."""
    return [
        int(part) if part.isdigit() else part.lower()
        for part in re.split(r"(\d+)", s)
    ]


def _is_image_file(name: str) -> bool:
    """Check if a filename has an image extension."""
    return os.path.splitext(name.lower())[1] in _IMAGE_EXTENSIONS


def _get_mime_type(name: str) -> str:
    """Get MIME type from filename."""
    ext = os.path.splitext(name.lower())[1]
    return _MIME_MAP.get(ext, "image/jpeg")


def _parse_comic_info(xml_data: bytes) -> tuple[str, str]:
    """Parse ComicInfo.xml for metadata."""
    try:
        root = ElementTree.fromstring(xml_data)
        title = ""
        author = ""

        title_el = root.find("Title")
        if title_el is not None and title_el.text:
            title = title_el.text.strip()
        if not title:
            series_el = root.find("Series")
            number_el = root.find("Number")
            if series_el is not None and series_el.text:
                title = series_el.text.strip()
                if number_el is not None and number_el.text:
                    title += f" #{number_el.text.strip()}"

        writer_el = root.find("Writer")
        if writer_el is not None and writer_el.text:
            author = writer_el.text.strip()

        return title or "Untitled", author or "Unknown Author"
    except ElementTree.ParseError:
        return "Untitled", "Unknown Author"


def _extract_images_from_zip(file_path: str, pub_uuid: str) -> tuple[str, str, list[ParsedImageChapter]]:
    """Extract images from a ZIP-based archive (CBZ)."""
    output_dir = os.path.join(IMAGES_DIR, pub_uuid)
    os.makedirs(output_dir, exist_ok=True)

    title = "Untitled"
    author = "Unknown Author"

    with zipfile.ZipFile(file_path, "r") as zf:
        # Check for ComicInfo.xml
        for name in zf.namelist():
            if name.lower() == "comicinfo.xml":
                title, author = _parse_comic_info(zf.read(name))
                break

        # Get all image files
        image_names = sorted(
            [n for n in zf.namelist() if _is_image_file(n)],
            key=_natural_sort_key,
        )

        if not image_names:
            raise ValueError("No image files found in the archive.")

        # Group by directory for chapter detection
        dir_groups: dict[str, list[str]] = {}
        for name in image_names:
            dirname = os.path.dirname(name)
            dir_groups.setdefault(dirname, []).append(name)

        chapters: list[ParsedImageChapter] = []

        if len(dir_groups) > 1:
            # Multiple directories = multiple chapters
            for dir_name in sorted(dir_groups.keys(), key=_natural_sort_key):
                files = dir_groups[dir_name]
                chapter_title = os.path.basename(dir_name) if dir_name else "Chapter 1"
                pages: list[ImagePage] = []

                for page_idx, img_name in enumerate(files):
                    # Extract to output directory with flat naming
                    safe_name = f"{len(chapters):03d}_{page_idx:04d}{os.path.splitext(img_name)[1]}"
                    out_path = os.path.join(output_dir, safe_name)
                    with zf.open(img_name) as src, open(out_path, "wb") as dst:
                        dst.write(src.read())

                    # Get image dimensions using basic header parsing
                    width, height = _get_image_dimensions(out_path)

                    pages.append(ImagePage(
                        page_index=page_idx,
                        image_path=f"{pub_uuid}/{safe_name}",
                        width=width,
                        height=height,
                        mime_type=_get_mime_type(img_name),
                    ))

                chapters.append(ParsedImageChapter(title=chapter_title, pages=pages))
        else:
            # Single directory = one chapter
            pages: list[ImagePage] = []
            for page_idx, img_name in enumerate(image_names):
                safe_name = f"{page_idx:04d}{os.path.splitext(img_name)[1]}"
                out_path = os.path.join(output_dir, safe_name)
                with zf.open(img_name) as src, open(out_path, "wb") as dst:
                    dst.write(src.read())

                width, height = _get_image_dimensions(out_path)

                pages.append(ImagePage(
                    page_index=page_idx,
                    image_path=f"{pub_uuid}/{safe_name}",
                    width=width,
                    height=height,
                    mime_type=_get_mime_type(img_name),
                ))

            chapters.append(ParsedImageChapter(title="Full Comic", pages=pages))

    if not title or title == "Untitled":
        title = os.path.splitext(os.path.basename(file_path))[0]

    return title, author, chapters


def _get_image_dimensions(file_path: str) -> tuple[int, int]:
    """Get image dimensions from file header without loading the full image.

    Uses Pillow if available, falls back to basic header parsing.
    """
    try:
        from PIL import Image
        with Image.open(file_path) as img:
            return img.size
    except ImportError:
        pass

    # Basic fallback for common formats
    try:
        with open(file_path, "rb") as f:
            header = f.read(32)

        # PNG
        if header[:8] == b"\x89PNG\r\n\x1a\n":
            import struct
            w, h = struct.unpack(">II", header[16:24])
            return w, h

        # JPEG - more complex, just return 0,0 as fallback
        return 0, 0
    except Exception:
        return 0, 0


def parse_cbz_cbr(file_path: str) -> ParsedBook:
    """Parse a CBZ or CBR comic book archive into image chapters."""
    ext = os.path.splitext(file_path.lower())[1]
    pub_uuid = str(uuid.uuid4())

    if ext == ".cbz":
        title, author, chapters = _extract_images_from_zip(file_path, pub_uuid)
    elif ext == ".cbr":
        try:
            import rarfile
        except ImportError:
            raise ValueError(
                "CBR support requires the 'rarfile' package and 'unrar' system tool. "
                "Install with: pip install rarfile"
            )

        # Extract RAR to temp, re-package as zip logic or use rarfile directly
        output_dir = os.path.join(IMAGES_DIR, pub_uuid)
        os.makedirs(output_dir, exist_ok=True)

        rf = rarfile.RarFile(file_path)
        image_names = sorted(
            [n for n in rf.namelist() if _is_image_file(n)],
            key=_natural_sort_key,
        )

        if not image_names:
            raise ValueError("No image files found in the CBR archive.")

        pages: list[ImagePage] = []
        for page_idx, img_name in enumerate(image_names):
            safe_name = f"{page_idx:04d}{os.path.splitext(img_name)[1]}"
            out_path = os.path.join(output_dir, safe_name)
            with rf.open(img_name) as src, open(out_path, "wb") as dst:
                dst.write(src.read())

            width, height = _get_image_dimensions(out_path)
            pages.append(ImagePage(
                page_index=page_idx,
                image_path=f"{pub_uuid}/{safe_name}",
                width=width,
                height=height,
                mime_type=_get_mime_type(img_name),
            ))

        rf.close()

        title = os.path.splitext(os.path.basename(file_path))[0]
        author = "Unknown Author"
        chapters = [ParsedImageChapter(title="Full Comic", pages=pages)]
    else:
        raise ValueError(f"Unsupported comic format: {ext}")

    return ParsedBook(
        title=title,
        author=author,
        content_type=ContentType.IMAGE,
        image_chapters=chapters,
    )

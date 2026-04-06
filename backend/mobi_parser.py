"""MOBI parser: extracts metadata and chapter text from .mobi files."""

from __future__ import annotations

import os
import re
import shutil
import tempfile
import uuid

import mobi
from bs4 import BeautifulSoup, Tag

from backend.parser_types import InlineImage, ParsedBook, ParsedChapter, save_inline_image

_WHITESPACE_RE = re.compile(r"\s+")
_MIN_CHAPTER_LENGTH = 50
_FALLBACK_WORD_LIMIT = 3000
_HEADING_TAGS = ("h1", "h2", "h3")
_MIN_IMAGE_SIZE = 500  # bytes — skip tiny decoration images


def _normalize_text(text: str) -> str:
    """Collapse whitespace into single spaces and strip."""
    return _WHITESPACE_RE.sub(" ", text).strip()


def _find_extracted_images(extracted_dir: str) -> dict[str, str]:
    """Build a mapping of basename → absolute path for images in extracted dir."""
    image_exts = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg"}
    images: dict[str, str] = {}
    if not extracted_dir or not os.path.isdir(extracted_dir):
        return images
    for root, _dirs, files in os.walk(extracted_dir):
        for fname in files:
            if os.path.splitext(fname.lower())[1] in image_exts:
                abs_path = os.path.join(root, fname)
                images[fname] = abs_path
                # Also store path relative to extracted dir
                rel = os.path.relpath(abs_path, extracted_dir)
                images[rel] = abs_path
    return images


def _replace_images(
    soup: BeautifulSoup,
    extracted_images: dict[str, str],
    pub_uuid: str,
    counter_start: int,
) -> tuple[int, list[InlineImage]]:
    """Replace <img> tags with placeholders, saving referenced images to disk."""
    inline_images: list[InlineImage] = []
    counter = counter_start

    for img_tag in soup.find_all("img"):
        src = img_tag.get("src", "") or img_tag.get("recindex", "")
        if not src:
            img_tag.decompose()
            continue

        # Try to find the image file
        basename = os.path.basename(src)
        abs_path = extracted_images.get(src) or extracted_images.get(basename)

        if not abs_path or not os.path.isfile(abs_path):
            img_tag.decompose()
            continue

        # Skip tiny images (icons, spacers)
        if os.path.getsize(abs_path) < _MIN_IMAGE_SIZE:
            img_tag.decompose()
            continue

        # Detect MIME type
        ext = os.path.splitext(abs_path.lower())[1]
        mime_map = {
            ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
            ".png": "image/png", ".gif": "image/gif",
            ".webp": "image/webp", ".svg": "image/svg+xml",
        }
        mime = mime_map.get(ext, "image/jpeg")

        with open(abs_path, "rb") as f:
            data = f.read()

        placeholder = f"{{{{IMG_{counter}}}}}"
        rel_path, width, height = save_inline_image(data, pub_uuid, counter, mime)

        alt = img_tag.get("alt", "")
        inline_images.append(InlineImage(
            placeholder=placeholder,
            image_path=rel_path,
            alt=alt,
            width=width,
            height=height,
            mime_type=mime,
        ))
        img_tag.replace_with(f" {placeholder} ")
        counter += 1

    return counter, inline_images


def _split_by_headings(soup: BeautifulSoup) -> list[ParsedChapter]:
    """Split HTML content into chapters using heading tags and page breaks."""
    chapters: list[ParsedChapter] = []
    break_tags = soup.find_all(_HEADING_TAGS + ("mbp:pagebreak",))

    if not break_tags:
        return []

    chapter_counter = 0
    for i, tag in enumerate(break_tags):
        if tag.name in _HEADING_TAGS:
            title = tag.get_text(strip=True)
        else:
            title = ""

        content_parts: list[str] = []
        sibling = tag.next_sibling
        next_break = break_tags[i + 1] if i + 1 < len(break_tags) else None

        while sibling:
            if sibling == next_break:
                break
            if hasattr(sibling, "get_text"):
                content_parts.append(sibling.get_text(separator=" "))
            elif isinstance(sibling, str):
                content_parts.append(sibling)
            sibling = sibling.next_sibling

        text = _normalize_text(" ".join(content_parts))
        if len(text) < _MIN_CHAPTER_LENGTH:
            continue

        chapter_counter += 1
        final_title = title if title else f"Chapter {chapter_counter}"
        chapters.append(ParsedChapter(title=final_title, text=text))

    return chapters


def _split_by_word_count(text: str, limit: int = _FALLBACK_WORD_LIMIT) -> list[ParsedChapter]:
    """Split plain text into chapters at roughly *limit* word boundaries."""
    words = text.split()
    if not words:
        return []

    chapters: list[ParsedChapter] = []
    chapter_counter = 0

    for start in range(0, len(words), limit):
        chunk_words = words[start : start + limit]
        chunk_text = " ".join(chunk_words).strip()
        if len(chunk_text) < _MIN_CHAPTER_LENGTH:
            continue
        chapter_counter += 1
        chapters.append(ParsedChapter(
            title=f"Chapter {chapter_counter}",
            text=chunk_text,
        ))

    return chapters


def parse_mobi(file_path: str) -> ParsedBook:
    """Parse a MOBI file into chapters with inline images."""
    if not os.path.isfile(file_path):
        raise FileNotFoundError(f"MOBI file not found: {file_path}")

    tmp_dir = tempfile.mkdtemp(prefix="mobi_parse_")
    try:
        try:
            tempdir, extracted_path = mobi.extract(file_path)
        except Exception as exc:
            raise ValueError(f"Failed to unpack MOBI file: {exc}") from exc

        if not extracted_path or not os.path.isfile(extracted_path):
            raise ValueError("MOBI extraction produced no readable content.")

        try:
            with open(extracted_path, "r", encoding="utf-8") as f:
                html_content = f.read()
        except UnicodeDecodeError:
            with open(extracted_path, "r", encoding="latin-1") as f:
                html_content = f.read()

        if not html_content.strip():
            raise ValueError("MOBI file contains no text content.")

        soup = BeautifulSoup(html_content, "lxml")

        # -- metadata --------------------------------------------------------
        title_tag = soup.find("title")
        title = title_tag.get_text(strip=True) if title_tag else "Untitled"
        if not title:
            title = "Untitled"

        author_tag = soup.find("meta", attrs={"name": "author"})
        author = author_tag.get("content", "").strip() if author_tag else ""
        if not author:
            dc_tag = soup.find("meta", attrs={"name": "dc:creator"})
            author = dc_tag.get("content", "").strip() if dc_tag else "Unknown Author"
        if not author:
            author = "Unknown Author"

        # -- extract images --------------------------------------------------
        pub_uuid = str(uuid.uuid4())
        extracted_dir = os.path.dirname(extracted_path)
        extracted_images = _find_extracted_images(extracted_dir)
        # Also check the mobi tempdir
        if tempdir and tempdir != extracted_dir:
            extracted_images.update(_find_extracted_images(tempdir))

        image_counter, all_inline_images = _replace_images(
            soup, extracted_images, pub_uuid, 0,
        )

        # -- split into chapters ---------------------------------------------
        chapters = _split_by_headings(soup)

        if not chapters:
            full_text = _normalize_text(soup.get_text(separator=" "))
            if len(full_text) < _MIN_CHAPTER_LENGTH:
                return ParsedBook(title=title, author=author, chapters=[])
            chapters = _split_by_word_count(full_text)

        # Distribute inline images to chapters based on placeholder presence
        if all_inline_images:
            img_map = {img.placeholder: img for img in all_inline_images}
            import re as _re
            _ph_re = _re.compile(r"\{\{IMG_(\d+)\}\}")
            for chapter in chapters:
                matches = _ph_re.findall(chapter.text)
                for m in matches:
                    placeholder = f"{{{{IMG_{m}}}}}"
                    if placeholder in img_map:
                        chapter.inline_images.append(img_map[placeholder])

        return ParsedBook(title=title, author=author, chapters=chapters)

    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        if "tempdir" in dir() and tempdir and os.path.isdir(tempdir):
            shutil.rmtree(tempdir, ignore_errors=True)

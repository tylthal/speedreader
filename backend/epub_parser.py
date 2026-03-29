"""EPUB parser: extracts metadata and chapter text from .epub files."""

from __future__ import annotations

import re
from dataclasses import dataclass

import ebooklib
from ebooklib import epub
from bs4 import BeautifulSoup


@dataclass
class ParsedChapter:
    title: str
    text: str


@dataclass
class ParsedBook:
    title: str
    author: str
    chapters: list[ParsedChapter]


_WHITESPACE_RE = re.compile(r"\s+")
_HEADING_TAGS = ("h1", "h2", "h3")
_MIN_CHAPTER_LENGTH = 50


def _extract_text(html_content: bytes | str) -> tuple[str | None, str]:
    """Extract heading title and body text from an HTML chapter.

    Returns (title_or_none, plain_text).
    """
    if isinstance(html_content, bytes):
        # ebooklib may return bytes; try decoding as utf-8 first
        try:
            html_content = html_content.decode("utf-8")
        except UnicodeDecodeError:
            html_content = html_content.decode("latin-1")

    soup = BeautifulSoup(html_content, "lxml")

    # Try to find a heading for the chapter title
    title: str | None = None
    for tag_name in _HEADING_TAGS:
        heading = soup.find(tag_name)
        if heading:
            title = heading.get_text(strip=True)
            if title:
                break
            title = None  # empty heading, keep looking

    # Extract all text, normalise whitespace
    raw_text = soup.get_text(separator=" ")
    text = _WHITESPACE_RE.sub(" ", raw_text).strip()

    return title, text


def _get_metadata_value(book: epub.EpubBook, namespace: str, key: str) -> str | None:
    """Safely pull a single metadata string from an EpubBook."""
    try:
        entries = book.get_metadata(namespace, key)
        if entries:
            value = entries[0][0]  # (value, attributes) tuple
            if isinstance(value, str) and value.strip():
                return value.strip()
    except Exception:
        pass
    return None


def parse_epub(file_path: str) -> ParsedBook:
    """Parse an EPUB file and return structured book data.

    Parameters
    ----------
    file_path:
        Path to an ``.epub`` file on disk.

    Returns
    -------
    ParsedBook
        Dataclass containing title, author, and a list of ParsedChapter
        objects in spine (reading) order.

    Raises
    ------
    FileNotFoundError
        If *file_path* does not exist.
    ebooklib.epub.EpubException
        If the file is not a valid EPUB.
    """
    book = epub.read_epub(file_path, options={"ignore_ncx": True})

    # --- metadata -----------------------------------------------------------
    title = (
        _get_metadata_value(book, "DC", "title")
        or _get_metadata_value(book, "http://purl.org/dc/elements/1.1/", "title")
        or "Untitled"
    )
    author = (
        _get_metadata_value(book, "DC", "creator")
        or _get_metadata_value(book, "http://purl.org/dc/elements/1.1/", "creator")
        or "Unknown Author"
    )

    # --- chapters in spine order --------------------------------------------
    chapters: list[ParsedChapter] = []
    chapter_counter = 0

    # book.spine is a list of (id, linear) tuples
    spine_ids = [item_id for item_id, _ in book.spine]
    items_by_id: dict[str, epub.EpubItem] = {
        item.get_id(): item for item in book.get_items()
    }

    for item_id in spine_ids:
        item = items_by_id.get(item_id)
        if item is None:
            continue
        if item.get_type() != ebooklib.ITEM_DOCUMENT:
            continue

        content = item.get_content()
        if not content:
            continue

        heading_title, text = _extract_text(content)

        # Skip very short chapters (front/back matter, copyright pages, etc.)
        if len(text) < _MIN_CHAPTER_LENGTH:
            continue

        chapter_counter += 1
        final_title = heading_title or f"Chapter {chapter_counter}"

        chapters.append(ParsedChapter(title=final_title, text=text))

    return ParsedBook(title=title, author=author, chapters=chapters)

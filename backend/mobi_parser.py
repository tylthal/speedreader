"""MOBI parser: extracts metadata and chapter text from .mobi files."""

from __future__ import annotations

import os
import re
import shutil
import tempfile

import mobi
from bs4 import BeautifulSoup

from backend.epub_parser import ParsedBook, ParsedChapter

_WHITESPACE_RE = re.compile(r"\s+")
_MIN_CHAPTER_LENGTH = 50
_FALLBACK_WORD_LIMIT = 3000
_HEADING_TAGS = ("h1", "h2", "h3")


def _normalize_text(text: str) -> str:
    """Collapse whitespace into single spaces and strip."""
    return _WHITESPACE_RE.sub(" ", text).strip()


def _split_by_headings(soup: BeautifulSoup) -> list[ParsedChapter]:
    """Split HTML content into chapters using heading tags and page breaks."""
    chapters: list[ParsedChapter] = []

    # Collect all potential break points: headings and Kindle page breaks
    break_tags = soup.find_all(_HEADING_TAGS + ("mbp:pagebreak",))

    if not break_tags:
        return []

    chapter_counter = 0
    for i, tag in enumerate(break_tags):
        # Determine chapter title
        if tag.name in _HEADING_TAGS:
            title = tag.get_text(strip=True)
        else:
            title = ""

        # Gather text between this break and the next
        content_parts: list[str] = []
        # Include text from the tag itself if it's a heading
        if tag.name in _HEADING_TAGS:
            pass  # title already captured

        # Walk siblings until next break tag
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
    """Parse a MOBI file into chapters.

    Parameters
    ----------
    file_path:
        Path to a ``.mobi`` file on disk.

    Returns
    -------
    ParsedBook
        Dataclass containing title, author, and a list of ParsedChapter
        objects extracted from the MOBI content.

    Raises
    ------
    FileNotFoundError
        If *file_path* does not exist.
    ValueError
        If the MOBI file cannot be unpacked or parsed.
    """
    if not os.path.isfile(file_path):
        raise FileNotFoundError(f"MOBI file not found: {file_path}")

    tmp_dir = tempfile.mkdtemp(prefix="mobi_parse_")
    try:
        # mobi.extract returns (tempdir, filepath_to_extracted_content)
        try:
            tempdir, extracted_path = mobi.extract(file_path)
        except Exception as exc:
            raise ValueError(f"Failed to unpack MOBI file: {exc}") from exc

        # Read the extracted HTML content
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

        # MOBI metadata for author is not reliably in the HTML; default it.
        author_tag = soup.find("meta", attrs={"name": "author"})
        author = author_tag.get("content", "").strip() if author_tag else ""
        if not author:
            # Try dc:creator
            dc_tag = soup.find("meta", attrs={"name": "dc:creator"})
            author = dc_tag.get("content", "").strip() if dc_tag else "Unknown Author"
        if not author:
            author = "Unknown Author"

        # -- split into chapters ---------------------------------------------
        chapters = _split_by_headings(soup)

        if not chapters:
            # Fallback: extract all text and split by word count
            full_text = _normalize_text(soup.get_text(separator=" "))
            if len(full_text) < _MIN_CHAPTER_LENGTH:
                return ParsedBook(title=title, author=author, chapters=[])
            chapters = _split_by_word_count(full_text)

        return ParsedBook(title=title, author=author, chapters=chapters)

    finally:
        # Clean up temp directories
        shutil.rmtree(tmp_dir, ignore_errors=True)
        # Also clean up the directory created by mobi.extract
        if "tempdir" in dir() and tempdir and os.path.isdir(tempdir):
            shutil.rmtree(tempdir, ignore_errors=True)

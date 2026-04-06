"""HTML parser: extracts metadata and chapter text from .html/.htm files."""

from __future__ import annotations

import re

from bs4 import BeautifulSoup

from backend.parser_types import ParsedBook, ParsedChapter

_WHITESPACE_RE = re.compile(r"\s+")
_HEADING_TAGS = ("h1", "h2", "h3")
_MIN_CHAPTER_LENGTH = 50


def _split_by_headings(soup: BeautifulSoup) -> list[ParsedChapter]:
    """Split HTML at heading boundaries."""
    body = soup.find("body") or soup
    headings = body.find_all(_HEADING_TAGS)

    if len(headings) <= 1:
        return []

    chapters: list[ParsedChapter] = []
    from bs4 import Tag

    for i, heading in enumerate(headings):
        title = heading.get_text(strip=True) or f"Section {i + 1}"

        texts: list[str] = [heading.get_text(separator=" ")]
        sibling = heading.next_sibling

        while sibling is not None:
            if isinstance(sibling, Tag) and sibling.name in _HEADING_TAGS:
                break
            if isinstance(sibling, Tag):
                nested = sibling.find(_HEADING_TAGS)
                if nested:
                    break
                texts.append(sibling.get_text(separator=" "))
            elif hasattr(sibling, "string") and sibling.string:
                texts.append(str(sibling.string))
            sibling = sibling.next_sibling

        text = _WHITESPACE_RE.sub(" ", " ".join(texts)).strip()
        if len(text) >= _MIN_CHAPTER_LENGTH:
            chapters.append(ParsedChapter(title=title, text=text))

    return chapters


def parse_html(file_path: str) -> ParsedBook:
    """Parse an HTML file into chapters."""
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read()
    except UnicodeDecodeError:
        with open(file_path, "r", encoding="latin-1") as f:
            content = f.read()

    soup = BeautifulSoup(content, "lxml")

    # Metadata
    title_tag = soup.find("title")
    title = title_tag.get_text(strip=True) if title_tag else "Untitled"
    if not title:
        title = "Untitled"

    author_tag = soup.find("meta", attrs={"name": "author"})
    author = author_tag.get("content", "").strip() if author_tag else "Unknown Author"
    if not author:
        author = "Unknown Author"

    # Try heading-based splitting
    chapters = _split_by_headings(soup)

    if not chapters:
        # Entire document as one chapter
        body = soup.find("body") or soup
        text = _WHITESPACE_RE.sub(" ", body.get_text(separator=" ")).strip()
        if len(text) >= _MIN_CHAPTER_LENGTH:
            chapters = [ParsedChapter(title=title, text=text)]

    return ParsedBook(title=title, author=author, chapters=chapters)

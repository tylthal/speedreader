"""Markdown parser: extracts chapters from .md files using heading structure."""

from __future__ import annotations

import os
import re

from backend.parser_types import ParsedBook, ParsedChapter

_MIN_CHAPTER_LENGTH = 50

# ATX headings: # Heading, ## Heading, ### Heading
_ATX_HEADING_RE = re.compile(r"^(#{1,3})\s+(.+)$", re.MULTILINE)

# Setext headings: underlined with === or ---
_SETEXT_H1_RE = re.compile(r"^(.+)\n={3,}\s*$", re.MULTILINE)
_SETEXT_H2_RE = re.compile(r"^(.+)\n-{3,}\s*$", re.MULTILINE)

# Markdown syntax to strip for plain text output
_STRIP_PATTERNS = [
    (re.compile(r"!\[([^\]]*)\]\([^)]+\)"), r"\1"),          # images
    (re.compile(r"\[([^\]]+)\]\([^)]+\)"), r"\1"),            # links
    (re.compile(r"`{3}[^`]*`{3}", re.DOTALL), ""),            # fenced code blocks
    (re.compile(r"`([^`]+)`"), r"\1"),                         # inline code
    (re.compile(r"\*{2}(.+?)\*{2}"), r"\1"),                  # bold
    (re.compile(r"\*(.+?)\*"), r"\1"),                         # italic
    (re.compile(r"_{2}(.+?)_{2}"), r"\1"),                     # bold underscore
    (re.compile(r"_(.+?)_"), r"\1"),                           # italic underscore
    (re.compile(r"^>\s?", re.MULTILINE), ""),                  # blockquotes
    (re.compile(r"^[-*+]\s+", re.MULTILINE), ""),              # unordered lists
    (re.compile(r"^\d+\.\s+", re.MULTILINE), ""),              # ordered lists
    (re.compile(r"^#{1,6}\s+", re.MULTILINE), ""),             # heading markers
]


def _strip_markdown(text: str) -> str:
    """Remove Markdown syntax to produce plain text."""
    for pattern, replacement in _STRIP_PATTERNS:
        text = pattern.sub(replacement, text)
    return text.strip()


def parse_md(file_path: str) -> ParsedBook:
    """Parse a Markdown file into chapters based on headings."""
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read()
    except UnicodeDecodeError:
        with open(file_path, "r", encoding="latin-1") as f:
            content = f.read()

    # Find all headings with their positions
    headings: list[tuple[int, int, str]] = []  # (position, level, title)

    for m in _ATX_HEADING_RE.finditer(content):
        level = len(m.group(1))
        headings.append((m.start(), level, m.group(2).strip()))

    for m in _SETEXT_H1_RE.finditer(content):
        headings.append((m.start(), 1, m.group(1).strip()))
    for m in _SETEXT_H2_RE.finditer(content):
        headings.append((m.start(), 2, m.group(1).strip()))

    headings.sort(key=lambda h: h[0])

    # Title from first h1 or filename
    title = "Untitled"
    for _, level, heading_text in headings:
        if level == 1:
            title = heading_text
            break
    if title == "Untitled":
        title = os.path.splitext(os.path.basename(file_path))[0]

    # Split into chapters at h1/h2 boundaries
    chapter_headings = [(pos, lvl, txt) for pos, lvl, txt in headings if lvl <= 2]

    chapters: list[ParsedChapter] = []

    if chapter_headings:
        for i, (pos, _, heading_text) in enumerate(chapter_headings):
            end = chapter_headings[i + 1][0] if i + 1 < len(chapter_headings) else len(content)
            section = content[pos:end]
            text = _strip_markdown(section)
            if len(text) >= _MIN_CHAPTER_LENGTH:
                chapters.append(ParsedChapter(title=heading_text, text=text))

    if not chapters:
        # Whole document as one chapter
        text = _strip_markdown(content)
        if len(text) >= _MIN_CHAPTER_LENGTH:
            chapters = [ParsedChapter(title=title, text=text)]

    return ParsedBook(title=title, author="Unknown Author", chapters=chapters)

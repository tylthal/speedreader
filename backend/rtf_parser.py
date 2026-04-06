"""RTF parser: extracts text from .rtf files."""

from __future__ import annotations

import re

from striprtf.striprtf import rtf_to_text

from backend.parser_types import ParsedBook, ParsedChapter

_MIN_CHAPTER_LENGTH = 50
_FALLBACK_WORD_LIMIT = 3000

_CHAPTER_HEADING_RE = re.compile(
    r"^\s*(chapter|part|section|prologue|epilogue)\s*[\s.:—\-]*(\d+|[ivxlcdm]+)?\s*[.:—\-]?\s*(.*)$",
    re.IGNORECASE,
)


def _split_by_headings(text: str) -> list[ParsedChapter]:
    """Split RTF text at chapter-like headings."""
    lines = text.splitlines()
    chapters: list[ParsedChapter] = []
    current_title = ""
    current_lines: list[str] = []

    for line in lines:
        if _CHAPTER_HEADING_RE.match(line.strip()):
            if current_lines:
                body = "\n".join(current_lines).strip()
                if len(body) >= _MIN_CHAPTER_LENGTH:
                    title = current_title or f"Chapter {len(chapters) + 1}"
                    chapters.append(ParsedChapter(title=title, text=body))
            current_title = line.strip()
            current_lines = []
        else:
            current_lines.append(line)

    if current_lines:
        body = "\n".join(current_lines).strip()
        if len(body) >= _MIN_CHAPTER_LENGTH:
            title = current_title or f"Chapter {len(chapters) + 1}"
            chapters.append(ParsedChapter(title=title, text=body))

    return chapters


def _split_by_word_count(text: str, limit: int = _FALLBACK_WORD_LIMIT) -> list[ParsedChapter]:
    """Fallback: split by word count."""
    words = text.split()
    chapters: list[ParsedChapter] = []
    for start in range(0, len(words), limit):
        chunk = " ".join(words[start:start + limit]).strip()
        if len(chunk) >= _MIN_CHAPTER_LENGTH:
            chapters.append(ParsedChapter(
                title=f"Chapter {len(chapters) + 1}",
                text=chunk,
            ))
    return chapters


def parse_rtf(file_path: str) -> ParsedBook:
    """Parse an RTF file into chapters."""
    with open(file_path, "r", encoding="utf-8", errors="replace") as f:
        rtf_content = f.read()

    text = rtf_to_text(rtf_content)
    if not text or not text.strip():
        raise ValueError("RTF file contains no readable text.")

    # Try to extract title from first line
    lines = text.strip().splitlines()
    title = lines[0].strip()[:100] if lines else "Untitled"

    chapters = _split_by_headings(text)
    if not chapters:
        chapters = _split_by_word_count(text)

    return ParsedBook(title=title, author="Unknown Author", chapters=chapters)

"""Plain text parser: extracts chapters from .txt files using heuristics."""

from __future__ import annotations

import re

from backend.parser_types import ParsedBook, ParsedChapter

_CHAPTER_HEADING_RE = re.compile(
    r"^\s*(chapter|part|book|section|prologue|epilogue|introduction|preface)"
    r"[\s.:—\-]*(\d+|[ivxlcdm]+)?\s*[.:—\-]?\s*(.*)$",
    re.IGNORECASE,
)
_SEPARATOR_RE = re.compile(r"^[\s*=\-_#]{3,}$")
_MIN_CHAPTER_LENGTH = 50
_FALLBACK_WORD_LIMIT = 3000


def _detect_encoding(data: bytes) -> str:
    """Try common encodings in order."""
    for enc in ("utf-8", "latin-1", "cp1252"):
        try:
            data.decode(enc)
            return enc
        except (UnicodeDecodeError, LookupError):
            continue
    return "utf-8"


def _split_by_headings(text: str) -> list[ParsedChapter]:
    """Split text into chapters at heading-like lines."""
    lines = text.splitlines()
    chapters: list[ParsedChapter] = []
    current_title = ""
    current_lines: list[str] = []

    for line in lines:
        match = _CHAPTER_HEADING_RE.match(line.strip())
        if match:
            # Save previous chapter
            if current_lines:
                body = "\n".join(current_lines).strip()
                if len(body) >= _MIN_CHAPTER_LENGTH:
                    title = current_title or f"Chapter {len(chapters) + 1}"
                    chapters.append(ParsedChapter(title=title, text=body))
            current_title = line.strip()
            current_lines = []
        else:
            current_lines.append(line)

    # Final chapter
    if current_lines:
        body = "\n".join(current_lines).strip()
        if len(body) >= _MIN_CHAPTER_LENGTH:
            title = current_title or f"Chapter {len(chapters) + 1}"
            chapters.append(ParsedChapter(title=title, text=body))

    return chapters


def _split_by_separators(text: str) -> list[ParsedChapter]:
    """Split at visual separator lines (===, ---, ***)."""
    lines = text.splitlines()
    sections: list[list[str]] = [[]]

    for line in lines:
        if _SEPARATOR_RE.match(line.strip()) and sections[-1]:
            sections.append([])
        else:
            sections[-1].append(line)

    chapters: list[ParsedChapter] = []
    for i, section_lines in enumerate(sections):
        body = "\n".join(section_lines).strip()
        if len(body) >= _MIN_CHAPTER_LENGTH:
            chapters.append(ParsedChapter(
                title=f"Section {len(chapters) + 1}",
                text=body,
            ))

    return chapters if len(chapters) > 1 else []


def _split_by_word_count(text: str, limit: int = _FALLBACK_WORD_LIMIT) -> list[ParsedChapter]:
    """Split text into chapters at roughly *limit* word boundaries."""
    words = text.split()
    if not words:
        return []

    chapters: list[ParsedChapter] = []
    for start in range(0, len(words), limit):
        chunk = " ".join(words[start:start + limit]).strip()
        if len(chunk) >= _MIN_CHAPTER_LENGTH:
            chapters.append(ParsedChapter(
                title=f"Chapter {len(chapters) + 1}",
                text=chunk,
            ))
    return chapters


def parse_txt(file_path: str) -> ParsedBook:
    """Parse a plain text file into chapters.

    Tries chapter heading patterns, then separator lines, then
    double-blank-line splitting, and finally word-count splitting.
    """
    with open(file_path, "rb") as f:
        raw = f.read()

    encoding = _detect_encoding(raw)
    text = raw.decode(encoding)

    # Extract title from first non-empty line
    lines = text.strip().splitlines()
    title = lines[0].strip()[:100] if lines else "Untitled"

    # Try strategies in order
    chapters = _split_by_headings(text)
    if not chapters:
        chapters = _split_by_separators(text)
    if not chapters:
        # Split at double blank lines
        sections = re.split(r"\n\s*\n\s*\n", text)
        if len(sections) > 3:
            chapters = []
            for i, section in enumerate(sections):
                section = section.strip()
                if len(section) >= _MIN_CHAPTER_LENGTH:
                    chapters.append(ParsedChapter(
                        title=f"Section {len(chapters) + 1}",
                        text=section,
                    ))
    if not chapters:
        chapters = _split_by_word_count(text)

    return ParsedBook(title=title, author="Unknown Author", chapters=chapters)

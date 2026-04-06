"""DJVU parser: extracts text from .djvu files using djvulibre CLI tools."""

from __future__ import annotations

import os
import re
import shutil
import subprocess

from backend.parser_types import ParsedBook, ParsedChapter

_WHITESPACE_RE = re.compile(r"\s+")
_MIN_CHAPTER_LENGTH = 50
_PAGES_PER_FALLBACK_CHAPTER = 10


def _check_djvutxt() -> str:
    """Find the djvutxt binary path."""
    path = shutil.which("djvutxt")
    if path:
        return path
    # Common locations
    for candidate in ("/usr/bin/djvutxt", "/usr/local/bin/djvutxt"):
        if os.path.isfile(candidate):
            return candidate
    raise ValueError(
        "DJVU support requires 'djvutxt' from the djvulibre package. "
        "Install with: apt-get install djvulibre-bin"
    )


def _get_page_count(file_path: str) -> int:
    """Get the number of pages in a DJVU file."""
    try:
        result = subprocess.run(
            ["djvused", file_path, "-e", "n"],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode == 0 and result.stdout.strip().isdigit():
            return int(result.stdout.strip())
    except (subprocess.TimeoutExpired, FileNotFoundError):
        pass
    return 0


def _extract_page_text(file_path: str, page: int) -> str:
    """Extract text from a single DJVU page."""
    djvutxt = _check_djvutxt()
    try:
        result = subprocess.run(
            [djvutxt, f"--page={page}", file_path],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode == 0:
            return _WHITESPACE_RE.sub(" ", result.stdout).strip()
    except subprocess.TimeoutExpired:
        pass
    return ""


def _extract_all_text(file_path: str) -> str:
    """Extract all text from a DJVU file at once."""
    djvutxt = _check_djvutxt()
    try:
        result = subprocess.run(
            [djvutxt, file_path],
            capture_output=True, text=True, timeout=120,
        )
        if result.returncode == 0:
            return result.stdout
    except subprocess.TimeoutExpired:
        pass
    return ""


def _extract_metadata(file_path: str) -> tuple[str, str]:
    """Try to extract title and author from DJVU metadata."""
    try:
        result = subprocess.run(
            ["djvused", file_path, "-e", "print-meta"],
            capture_output=True, text=True, timeout=10,
        )
        if result.returncode == 0:
            title = ""
            author = ""
            for line in result.stdout.splitlines():
                line = line.strip().strip('"')
                if line.lower().startswith("title"):
                    title = line.split('"', 1)[-1].strip().strip('"')
                elif line.lower().startswith("author"):
                    author = line.split('"', 1)[-1].strip().strip('"')
            return title or "Untitled", author or "Unknown Author"
    except (subprocess.TimeoutExpired, FileNotFoundError):
        pass
    return "Untitled", "Unknown Author"


def parse_djvu(file_path: str) -> ParsedBook:
    """Parse a DJVU file into chapters.

    Uses djvulibre CLI tools (djvutxt, djvused) for text extraction.
    Falls back to page-grouped chapters if no TOC is available.
    """
    if not os.path.isfile(file_path):
        raise FileNotFoundError(f"DJVU file not found: {file_path}")

    _check_djvutxt()  # fail fast if tools not available

    title, author = _extract_metadata(file_path)
    if title == "Untitled":
        title = os.path.splitext(os.path.basename(file_path))[0]

    page_count = _get_page_count(file_path)

    if page_count == 0:
        # Try extracting all text at once
        full_text = _extract_all_text(file_path)
        if not full_text.strip():
            raise ValueError("DJVU file contains no extractable text.")

        text = _WHITESPACE_RE.sub(" ", full_text).strip()
        words = text.split()
        chapters: list[ParsedChapter] = []
        for start in range(0, len(words), 3000):
            chunk = " ".join(words[start:start + 3000]).strip()
            if len(chunk) >= _MIN_CHAPTER_LENGTH:
                chapters.append(ParsedChapter(
                    title=f"Chapter {len(chapters) + 1}",
                    text=chunk,
                ))
        return ParsedBook(title=title, author=author, chapters=chapters)

    # Extract text page by page and group into chapters
    page_texts: list[str] = []
    for page_num in range(1, page_count + 1):
        page_texts.append(_extract_page_text(file_path, page_num))

    # Group pages into chapters
    chapters: list[ParsedChapter] = []
    meaningful_pages = [
        (idx, text) for idx, text in enumerate(page_texts)
        if len(text) >= _MIN_CHAPTER_LENGTH
    ]

    if not meaningful_pages:
        # Very little text — likely a scanned document with poor OCR
        full_text = " ".join(page_texts).strip()
        if len(full_text) >= _MIN_CHAPTER_LENGTH:
            chapters.append(ParsedChapter(title="Full Document", text=full_text))
        else:
            raise ValueError(
                "DJVU file contains very little extractable text. "
                "It may be a scanned document without an OCR text layer."
            )
    elif len(meaningful_pages) < 20:
        for idx, (page_idx, text) in enumerate(meaningful_pages):
            chapters.append(ParsedChapter(title=f"Section {idx + 1}", text=text))
    else:
        chunk: list[str] = []
        for i, (page_idx, text) in enumerate(meaningful_pages):
            chunk.append(text)
            if len(chunk) >= _PAGES_PER_FALLBACK_CHAPTER or i == len(meaningful_pages) - 1:
                combined = "\n\n".join(chunk).strip()
                if len(combined) >= _MIN_CHAPTER_LENGTH:
                    chapters.append(ParsedChapter(
                        title=f"Chapter {len(chapters) + 1}",
                        text=combined,
                    ))
                chunk = []

    return ParsedBook(title=title, author=author, chapters=chapters)

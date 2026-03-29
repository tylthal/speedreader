"""PDF parser: extracts metadata and chapter text from .pdf files using PyMuPDF."""

from __future__ import annotations

import re

import fitz  # PyMuPDF

from backend.epub_parser import ParsedBook, ParsedChapter

_WHITESPACE_RE = re.compile(r"\s+")
_BLANK_LINES_RE = re.compile(r"\n{3,}")
_MIN_PAGE_TEXT_LENGTH = 50
_PAGES_PER_FALLBACK_CHAPTER = 10


def _normalize_text(text: str) -> str:
    """Collapse excessive whitespace and blank lines."""
    text = _BLANK_LINES_RE.sub("\n\n", text)
    # Normalise runs of spaces/tabs within lines (but keep newlines)
    lines = text.splitlines()
    cleaned = []
    for line in lines:
        cleaned.append(_WHITESPACE_RE.sub(" ", line).strip())
    return "\n".join(cleaned).strip()


def _extract_page_text(page: fitz.Page) -> str:
    """Extract and normalize text from a single PDF page."""
    raw = page.get_text("text")
    return _normalize_text(raw) if raw else ""


def parse_pdf(file_path: str) -> ParsedBook:
    """Parse a PDF file into chapters.

    Parameters
    ----------
    file_path:
        Path to a ``.pdf`` file on disk.

    Returns
    -------
    ParsedBook
        Dataclass containing title, author, and a list of ParsedChapter
        objects derived from the PDF's table of contents or page groupings.

    Raises
    ------
    FileNotFoundError
        If *file_path* does not exist.
    ValueError
        If the PDF is password-protected or otherwise unreadable.
    """
    try:
        doc = fitz.open(file_path)
    except Exception as exc:
        raise ValueError(f"Cannot open PDF: {exc}") from exc

    if doc.is_encrypted:
        doc.close()
        raise ValueError("PDF is password-protected and cannot be parsed.")

    if doc.page_count == 0:
        doc.close()
        raise ValueError("PDF has no pages.")

    # -- metadata ------------------------------------------------------------
    metadata = doc.metadata or {}
    title = (metadata.get("title") or "").strip() or "Untitled"
    author = (metadata.get("author") or "").strip() or "Unknown Author"

    # -- extract text per page -----------------------------------------------
    page_texts: list[str] = []
    for page_num in range(doc.page_count):
        page = doc.load_page(page_num)
        text = _extract_page_text(page)
        page_texts.append(text)

    # -- group into chapters -------------------------------------------------
    toc = doc.get_toc()  # list of [level, title, page_number]
    doc.close()

    chapters: list[ParsedChapter] = []

    if toc:
        # Use TOC entries to define chapter boundaries.
        # page_number in TOC is 1-based.
        toc_entries = []
        for level, entry_title, page_number in toc:
            # Clamp page numbers to valid range (1-based)
            page_idx = max(0, min(page_number - 1, len(page_texts) - 1))
            toc_entries.append((entry_title.strip(), page_idx))

        for i, (entry_title, start_page) in enumerate(toc_entries):
            # End page is the start of the next TOC entry, or end of document
            if i + 1 < len(toc_entries):
                end_page = toc_entries[i + 1][1]
            else:
                end_page = len(page_texts)

            # Gather text for this chapter's pages
            chapter_parts = []
            for p in range(start_page, end_page):
                if p < len(page_texts) and len(page_texts[p]) >= _MIN_PAGE_TEXT_LENGTH:
                    chapter_parts.append(page_texts[p])

            combined = "\n\n".join(chapter_parts).strip()
            if len(combined) < _MIN_PAGE_TEXT_LENGTH:
                continue

            chapter_title = entry_title if entry_title else f"Chapter {len(chapters) + 1}"
            chapters.append(ParsedChapter(title=chapter_title, text=combined))
    else:
        # No TOC -- create synthetic chapters
        # Filter to pages with meaningful text
        meaningful_pages = [
            (idx, text) for idx, text in enumerate(page_texts)
            if len(text) >= _MIN_PAGE_TEXT_LENGTH
        ]

        if not meaningful_pages:
            return ParsedBook(title=title, author=author, chapters=[])

        if len(meaningful_pages) < 20:
            # Treat each page as a section
            for idx, (page_idx, text) in enumerate(meaningful_pages):
                chapters.append(ParsedChapter(
                    title=f"Section {idx + 1}",
                    text=text,
                ))
        else:
            # Group every ~10 pages into a chapter
            chunk: list[str] = []
            chapter_counter = 0
            for i, (page_idx, text) in enumerate(meaningful_pages):
                chunk.append(text)
                if len(chunk) >= _PAGES_PER_FALLBACK_CHAPTER or i == len(meaningful_pages) - 1:
                    combined = "\n\n".join(chunk).strip()
                    if len(combined) >= _MIN_PAGE_TEXT_LENGTH:
                        chapter_counter += 1
                        chapters.append(ParsedChapter(
                            title=f"Chapter {chapter_counter}",
                            text=combined,
                        ))
                    chunk = []

    return ParsedBook(title=title, author=author, chapters=chapters)

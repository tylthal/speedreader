"""PDF parser: extracts metadata and chapter text from .pdf files using PyMuPDF."""

from __future__ import annotations

import re
import uuid

import fitz  # PyMuPDF

from backend.parser_types import InlineImage, ParsedBook, ParsedChapter, save_inline_image

_WHITESPACE_RE = re.compile(r"\s+")
_BLANK_LINES_RE = re.compile(r"\n{3,}")
_MIN_PAGE_TEXT_LENGTH = 50
_PAGES_PER_FALLBACK_CHAPTER = 10
# Skip tiny images (icons, bullets, decorations)
_MIN_IMAGE_DIMENSION = 50


def _normalize_text(text: str) -> str:
    """Collapse excessive whitespace and blank lines."""
    text = _BLANK_LINES_RE.sub("\n\n", text)
    lines = text.splitlines()
    cleaned = []
    for line in lines:
        cleaned.append(_WHITESPACE_RE.sub(" ", line).strip())
    return "\n".join(cleaned).strip()


def _extract_page_text(page: fitz.Page) -> str:
    """Extract and normalize text from a single PDF page."""
    raw = page.get_text("text")
    return _normalize_text(raw) if raw else ""


def _extract_page_images(
    page: fitz.Page,
    doc: fitz.Document,
    pub_uuid: str,
    image_counter: int,
) -> tuple[int, list[InlineImage]]:
    """Extract meaningful images from a PDF page.

    Returns (next_counter, list_of_inline_images).
    """
    inline_images: list[InlineImage] = []
    image_list = page.get_images(full=True)

    for img_info in image_list:
        xref = img_info[0]
        try:
            base_image = doc.extract_image(xref)
        except Exception:
            continue

        if not base_image or not base_image.get("image"):
            continue

        width = base_image.get("width", 0)
        height = base_image.get("height", 0)

        # Skip tiny images
        if width < _MIN_IMAGE_DIMENSION or height < _MIN_IMAGE_DIMENSION:
            continue

        mime = f"image/{base_image.get('ext', 'jpeg')}"
        if mime == "image/ppm":
            mime = "image/png"  # ppm isn't web-friendly

        placeholder = f"{{{{IMG_{image_counter}}}}}"
        rel_path, w, h = save_inline_image(
            base_image["image"], pub_uuid, image_counter, mime,
        )

        inline_images.append(InlineImage(
            placeholder=placeholder,
            image_path=rel_path,
            alt="",
            width=w or width,
            height=h or height,
            mime_type=mime,
        ))
        image_counter += 1

    return image_counter, inline_images


def parse_pdf(file_path: str) -> ParsedBook:
    """Parse a PDF file into chapters with inline images."""
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

    pub_uuid = str(uuid.uuid4())
    image_counter = 0

    # -- extract text and images per page ------------------------------------
    page_texts: list[str] = []
    page_images: list[list[InlineImage]] = []

    for page_num in range(doc.page_count):
        page = doc.load_page(page_num)
        text = _extract_page_text(page)
        image_counter, images = _extract_page_images(page, doc, pub_uuid, image_counter)
        page_texts.append(text)
        page_images.append(images)

    # -- group into chapters -------------------------------------------------
    toc = doc.get_toc()
    doc.close()

    chapters: list[ParsedChapter] = []

    if toc:
        toc_entries = []
        for level, entry_title, page_number in toc:
            page_idx = max(0, min(page_number - 1, len(page_texts) - 1))
            toc_entries.append((entry_title.strip(), page_idx))

        for i, (entry_title, start_page) in enumerate(toc_entries):
            if i + 1 < len(toc_entries):
                end_page = toc_entries[i + 1][1]
            else:
                end_page = len(page_texts)

            chapter_parts = []
            chapter_images: list[InlineImage] = []
            for p in range(start_page, end_page):
                if p < len(page_texts):
                    text = page_texts[p]
                    imgs = page_images[p]
                    if imgs:
                        # Insert image placeholders at the start of the page text
                        placeholders = " ".join(img.placeholder for img in imgs)
                        text = f"{placeholders} {text}" if text else placeholders
                        chapter_images.extend(imgs)
                    if len(text) >= _MIN_PAGE_TEXT_LENGTH or imgs:
                        chapter_parts.append(text)

            combined = "\n\n".join(chapter_parts).strip()
            if len(combined) < _MIN_PAGE_TEXT_LENGTH and not chapter_images:
                continue

            chapter_title = entry_title if entry_title else f"Chapter {len(chapters) + 1}"
            chapters.append(ParsedChapter(
                title=chapter_title, text=combined, inline_images=chapter_images,
            ))
    else:
        meaningful_pages = [
            (idx, page_texts[idx], page_images[idx])
            for idx in range(len(page_texts))
            if len(page_texts[idx]) >= _MIN_PAGE_TEXT_LENGTH or page_images[idx]
        ]

        if not meaningful_pages:
            return ParsedBook(title=title, author=author, chapters=[])

        if len(meaningful_pages) < 20:
            for idx, (page_idx, text, imgs) in enumerate(meaningful_pages):
                if imgs:
                    placeholders = " ".join(img.placeholder for img in imgs)
                    text = f"{placeholders} {text}" if text else placeholders
                chapters.append(ParsedChapter(
                    title=f"Section {idx + 1}",
                    text=text,
                    inline_images=imgs,
                ))
        else:
            chunk_texts: list[str] = []
            chunk_images: list[InlineImage] = []
            chapter_counter = 0
            for i, (page_idx, text, imgs) in enumerate(meaningful_pages):
                if imgs:
                    placeholders = " ".join(img.placeholder for img in imgs)
                    text = f"{placeholders} {text}" if text else placeholders
                    chunk_images.extend(imgs)
                chunk_texts.append(text)
                if len(chunk_texts) >= _PAGES_PER_FALLBACK_CHAPTER or i == len(meaningful_pages) - 1:
                    combined = "\n\n".join(chunk_texts).strip()
                    if len(combined) >= _MIN_PAGE_TEXT_LENGTH or chunk_images:
                        chapter_counter += 1
                        chapters.append(ParsedChapter(
                            title=f"Chapter {chapter_counter}",
                            text=combined,
                            inline_images=chunk_images,
                        ))
                    chunk_texts = []
                    chunk_images = []

    return ParsedBook(title=title, author=author, chapters=chapters)

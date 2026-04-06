"""FictionBook2 parser: extracts metadata and chapters from .fb2 files."""

from __future__ import annotations

import base64
import os
import re
import uuid
import zipfile

from lxml import etree

from backend.parser_types import InlineImage, ParsedBook, ParsedChapter, save_inline_image

_FB2_NS = "http://www.gribuser.ru/xml/fictionbook/2.0"
_XLINK_NS = "http://www.w3.org/1999/xlink"
_NS = {"fb": _FB2_NS, "l": _XLINK_NS}
_WHITESPACE_RE = re.compile(r"\s+")
_MIN_CHAPTER_LENGTH = 50


def _extract_binaries(tree: etree._Element, pub_uuid: str) -> dict[str, InlineImage]:
    """Extract all <binary> elements to disk and return id → InlineImage mapping."""
    binaries: dict[str, InlineImage] = {}
    counter = 0

    for binary_el in tree.findall(f"{{{_FB2_NS}}}binary"):
        bin_id = binary_el.get("id", "")
        content_type = binary_el.get("content-type", "image/jpeg")
        data_b64 = binary_el.text
        if not bin_id or not data_b64:
            continue

        try:
            data = base64.b64decode(data_b64.strip())
        except Exception:
            continue

        if len(data) < 500:
            continue  # Skip tiny decorations

        placeholder = f"{{{{IMG_{counter}}}}}"
        rel_path, width, height = save_inline_image(data, pub_uuid, counter, content_type)

        binaries[bin_id] = InlineImage(
            placeholder=placeholder,
            image_path=rel_path,
            alt="",
            width=width,
            height=height,
            mime_type=content_type,
        )
        # Also map with # prefix since FB2 uses href="#id"
        binaries[f"#{bin_id}"] = binaries[bin_id]
        counter += 1

    return binaries


def _get_text_with_images(
    element: etree._Element,
    binaries: dict[str, InlineImage],
    collected_images: list[InlineImage],
) -> str:
    """Recursively extract text from an element, replacing <image> refs with placeholders."""
    tag = element.tag
    if tag == f"{{{_FB2_NS}}}binary":
        return ""

    # Handle <image> elements — replace with placeholder
    if tag == f"{{{_FB2_NS}}}image":
        href = element.get(f"{{{_XLINK_NS}}}href", "") or element.get("href", "")
        if href and href in binaries:
            img = binaries[href]
            if img not in collected_images:
                collected_images.append(img)
            return f" {img.placeholder} "
        return ""

    parts: list[str] = []
    if element.text:
        parts.append(element.text)
    for child in element:
        parts.append(_get_text_with_images(child, binaries, collected_images))
        if child.tail:
            parts.append(child.tail)
    return " ".join(parts)


def _extract_section_title(section: etree._Element) -> str:
    """Get the title from a <section><title>... element."""
    title_el = section.find("fb:title", _NS)
    if title_el is not None:
        # Extract title text without image placeholders
        parts: list[str] = []
        for p in title_el.findall(f".//{{{_FB2_NS}}}p"):
            if p.text:
                parts.append(p.text.strip())
        result = _WHITESPACE_RE.sub(" ", " ".join(parts)).strip()
        if result:
            return result
        # Fallback: all text from title element
        return _WHITESPACE_RE.sub(" ", "".join(title_el.itertext())).strip()
    return ""


def _parse_sections(
    body: etree._Element,
    binaries: dict[str, InlineImage],
) -> list[ParsedChapter]:
    """Walk <section> elements and produce chapters with inline images."""
    chapters: list[ParsedChapter] = []
    sections = body.findall("fb:section", _NS)

    if not sections:
        collected: list[InlineImage] = []
        text = _WHITESPACE_RE.sub(
            " ", _get_text_with_images(body, binaries, collected),
        ).strip()
        if len(text) >= _MIN_CHAPTER_LENGTH:
            chapters.append(ParsedChapter(
                title="Chapter 1", text=text, inline_images=collected,
            ))
        return chapters

    for i, section in enumerate(sections):
        title = _extract_section_title(section) or f"Chapter {i + 1}"

        subsections = section.findall("fb:section", _NS)
        if subsections:
            for j, sub in enumerate(subsections):
                sub_title = _extract_section_title(sub)
                collected: list[InlineImage] = []
                sub_text = _WHITESPACE_RE.sub(
                    " ", _get_text_with_images(sub, binaries, collected),
                ).strip()
                if len(sub_text) >= _MIN_CHAPTER_LENGTH:
                    full_title = f"{title} - {sub_title}" if sub_title else f"{title} ({j + 1})"
                    chapters.append(ParsedChapter(
                        title=full_title, text=sub_text, inline_images=collected,
                    ))
        else:
            collected: list[InlineImage] = []
            text = _WHITESPACE_RE.sub(
                " ", _get_text_with_images(section, binaries, collected),
            ).strip()
            if len(text) >= _MIN_CHAPTER_LENGTH:
                chapters.append(ParsedChapter(
                    title=title, text=text, inline_images=collected,
                ))

    return chapters


def parse_fb2(file_path: str) -> ParsedBook:
    """Parse a FictionBook2 (.fb2 or .fb2.zip) file into chapters with images."""
    if file_path.lower().endswith(".fb2.zip") or file_path.lower().endswith(".zip"):
        with zipfile.ZipFile(file_path, "r") as zf:
            fb2_names = [n for n in zf.namelist() if n.lower().endswith(".fb2")]
            if not fb2_names:
                raise ValueError("No .fb2 file found inside the ZIP archive.")
            xml_data = zf.read(fb2_names[0])
    else:
        with open(file_path, "rb") as f:
            xml_data = f.read()

    try:
        tree = etree.fromstring(xml_data)
    except etree.XMLSyntaxError as exc:
        raise ValueError(f"Invalid FB2 XML: {exc}") from exc

    # Metadata from <title-info>
    title_info = tree.find(".//fb:description/fb:title-info", _NS)

    title = "Untitled"
    author = "Unknown Author"

    if title_info is not None:
        book_title = title_info.find("fb:book-title", _NS)
        if book_title is not None and book_title.text:
            title = book_title.text.strip()

        author_el = title_info.find("fb:author", _NS)
        if author_el is not None:
            first = author_el.find("fb:first-name", _NS)
            last = author_el.find("fb:last-name", _NS)
            parts = []
            if first is not None and first.text:
                parts.append(first.text.strip())
            if last is not None and last.text:
                parts.append(last.text.strip())
            if parts:
                author = " ".join(parts)

    # Extract binary images
    pub_uuid = str(uuid.uuid4())
    binaries = _extract_binaries(tree, pub_uuid)

    # Parse body sections
    body = tree.find("fb:body", _NS)
    if body is None:
        return ParsedBook(title=title, author=author, chapters=[])

    chapters = _parse_sections(body, binaries)

    return ParsedBook(title=title, author=author, chapters=chapters)

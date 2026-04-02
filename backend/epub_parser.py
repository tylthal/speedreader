"""EPUB parser: extracts metadata and chapter text from .epub files.

Handles multiple chapter detection strategies:
1. TOC fragment-based splitting (anchors within a single XHTML file)
2. Spine-based iteration with TOC title enrichment
3. Heading-based splitting for large single-file books
"""

from __future__ import annotations

import re
from dataclasses import dataclass

import ebooklib
from ebooklib import epub
from bs4 import BeautifulSoup, Tag


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
_LARGE_CHAPTER_THRESHOLD = 5000  # chars — trigger heading-based split

# Titles/filenames that indicate front/back matter (case-insensitive)
_SKIP_PATTERNS = re.compile(
    r"^(copyright|copy right|contents|table of contents|title\s*page|"
    r"half\s*title|cover|colophon|dedication|also\s+by|other\s+books|"
    r"about\s+the\s+author|acknowledgment|imprint|"
    r"books?\s+by|praise\s+for|endorsement|blurb)s?\s*$",
    re.IGNORECASE,
)
# Simple title-only pages (just "Title" with no other words)
_TITLE_ONLY = re.compile(r"^title$", re.IGNORECASE)


def _decode_content(html_content: bytes | str) -> str:
    """Decode bytes to string, trying UTF-8 then Latin-1."""
    if isinstance(html_content, bytes):
        try:
            return html_content.decode("utf-8")
        except UnicodeDecodeError:
            return html_content.decode("latin-1")
    return html_content


def _extract_text(html_content: bytes | str) -> tuple[str | None, str]:
    """Extract heading title and body text from an HTML chapter.

    Returns (title_or_none, plain_text).
    """
    html_str = _decode_content(html_content)
    soup = BeautifulSoup(html_str, "lxml")

    # Try to find a heading for the chapter title
    title: str | None = None
    for tag_name in _HEADING_TAGS:
        heading = soup.find(tag_name)
        if heading:
            title = heading.get_text(strip=True)
            if title:
                break
            title = None

    # Extract all text, normalise whitespace
    raw_text = soup.get_text(separator=" ")
    text = _WHITESPACE_RE.sub(" ", raw_text).strip()

    return title, text


def _split_by_toc_fragments(
    html_content: bytes | str,
    fragment_entries: list[tuple[str, str]],
) -> list[ParsedChapter]:
    """Split a single XHTML document into chapters using TOC fragment anchors.

    Uses a string-position approach: finds each anchor's position in the
    full text extraction, then slices between positions. This is more
    robust than DOM walking for varied HTML structures.
    """
    html_str = _decode_content(html_content)
    soup = BeautifulSoup(html_str, "lxml")
    body = soup.find("body") or soup

    # Get the full text of the document
    full_text = body.get_text(separator=" ")
    full_text = _WHITESPACE_RE.sub(" ", full_text).strip()

    if not full_text:
        return []

    # Find the text position of each anchor by extracting the text
    # of the element the anchor is in (or near), then finding it in full_text
    anchor_positions: list[tuple[int, str]] = []  # (char_position, title)

    for frag_id, title in fragment_entries:
        el = soup.find(id=frag_id)
        if el is None:
            el = soup.find(attrs={"name": frag_id})
        if el is None:
            continue

        # Find the nearest block-level parent or heading that contains text
        # to use as a position marker
        marker_el = el
        if not el.get_text(strip=True):
            # Anchor is empty (e.g., <a id="chap01"></a>)
            # Look at the next sibling for a heading or text
            nxt = el.next_sibling
            while nxt and not (isinstance(nxt, Tag) and nxt.get_text(strip=True)):
                nxt = nxt.next_sibling
            if nxt and isinstance(nxt, Tag):
                marker_el = nxt

        # Get the marker text and find its position in full_text
        marker_text = marker_el.get_text(separator=" ")
        marker_text = _WHITESPACE_RE.sub(" ", marker_text).strip()

        if marker_text:
            # Find the first occurrence of this text that we haven't passed yet
            search_start = anchor_positions[-1][0] + 1 if anchor_positions else 0
            pos = full_text.find(marker_text[:80], search_start)
            if pos == -1:
                pos = full_text.find(marker_text[:40], search_start)
            if pos >= 0:
                anchor_positions.append((pos, title))
            else:
                # Couldn't find marker text — use position just after last chapter
                # This handles empty anchors where the content follows immediately
                fallback_pos = anchor_positions[-1][0] + 1 if anchor_positions else 0
                # Try to find the title text itself in the document
                title_pos = full_text.find(title[:30], fallback_pos)
                if title_pos >= 0:
                    anchor_positions.append((title_pos, title))
                elif anchor_positions:
                    # Last resort: place it at the end of the previous chapter's
                    # expected region (will capture remaining text)
                    anchor_positions.append((fallback_pos, title))

    if not anchor_positions:
        return []

    chapters: list[ParsedChapter] = []

    # Capture content BEFORE the first anchor — this is often a chapter
    # that spans from a previous file (e.g., the Prologue before Chapter I)
    first_pos = anchor_positions[0][0]
    if first_pos > _MIN_CHAPTER_LENGTH:
        pre_text = full_text[:first_pos].strip()
        if len(pre_text) >= _MIN_CHAPTER_LENGTH:
            # Find the best heading for the pre-anchor content.
            # Skip headings that are just the book title (h1 often repeats it).
            pre_soup = BeautifulSoup(html_str, "lxml")
            pre_title = None
            first_anchor_title = anchor_positions[0][1]
            for h in pre_soup.find_all(_HEADING_TAGS):
                h_text = h.get_text(strip=True)
                if not h_text:
                    continue
                # Skip if it matches the first anchor's title (not a chapter heading)
                if h_text == first_anchor_title:
                    break
                # Skip generic book titles (often h1) — prefer h2/h3 as chapter titles
                if h.name == 'h1':
                    # Store as fallback, keep looking for a more specific heading
                    if pre_title is None:
                        pre_title = h_text
                    continue
                # h2/h3 is likely the actual chapter title
                pre_title = h_text
                break
            if pre_title and not _SKIP_PATTERNS.match(pre_title.strip()):
                chapters.append(ParsedChapter(title=pre_title, text=pre_text))

    # Slice the full text between consecutive anchor positions
    for i, (pos, title) in enumerate(anchor_positions):
        end_pos = anchor_positions[i + 1][0] if i + 1 < len(anchor_positions) else len(full_text)
        text = full_text[pos:end_pos].strip()
        if len(text) >= _MIN_CHAPTER_LENGTH:
            chapters.append(ParsedChapter(title=title, text=text))

    return chapters


def _split_by_headings(
    html_content: bytes | str,
) -> list[ParsedChapter]:
    """Split a large XHTML document into chapters at heading boundaries.

    Scans for h1, h2, h3 tags and splits the document at each one.
    Falls back to returning the whole document as one chapter if no
    headings are found.
    """
    html_str = _decode_content(html_content)
    soup = BeautifulSoup(html_str, "lxml")
    body = soup.find("body") or soup

    # Find all headings in document order
    headings = body.find_all(_HEADING_TAGS)

    if len(headings) <= 1:
        return []  # no splitting possible

    chapters: list[ParsedChapter] = []

    for i, heading in enumerate(headings):
        title = heading.get_text(strip=True)
        if not title:
            title = f"Section {i + 1}"

        # Collect text from this heading until the next heading
        texts: list[str] = [heading.get_text(separator=" ")]
        sibling = heading.next_sibling

        while sibling is not None:
            if isinstance(sibling, Tag) and sibling.name in _HEADING_TAGS:
                break
            if isinstance(sibling, Tag):
                # Check if a heading is nested inside
                nested = sibling.find(_HEADING_TAGS)
                if nested:
                    # Extract text before the nested heading
                    pre_text = ""
                    for child in sibling.children:
                        if child == nested or (isinstance(child, Tag) and child.find(_HEADING_TAGS)):
                            break
                        if isinstance(child, Tag):
                            pre_text += child.get_text(separator=" ") + " "
                        elif hasattr(child, "string") and child.string:
                            pre_text += str(child.string) + " "
                    texts.append(pre_text)
                    break
                texts.append(sibling.get_text(separator=" "))
            elif hasattr(sibling, "string") and sibling.string:
                texts.append(str(sibling.string))
            sibling = sibling.next_sibling

        text = _WHITESPACE_RE.sub(" ", " ".join(texts)).strip()
        if len(text) >= _MIN_CHAPTER_LENGTH:
            chapters.append(ParsedChapter(title=title, text=text))

    return chapters


def _get_metadata_value(book: epub.EpubBook, namespace: str, key: str) -> str | None:
    """Safely pull a single metadata string from an EpubBook."""
    try:
        entries = book.get_metadata(namespace, key)
        if entries:
            value = entries[0][0]
            if isinstance(value, str) and value.strip():
                return value.strip()
    except Exception:
        pass
    return None


def _build_toc_entries(book: epub.EpubBook) -> list[tuple[str, str, str]]:
    """Build a flat list of TOC entries: (filename, fragment_or_empty, title).

    Walks the EPUB TOC (NCX or nav) recursively and returns entries
    in document order, preserving fragment identifiers.
    """
    entries: list[tuple[str, str, str]] = []

    def _walk(toc_items: list) -> None:
        for entry in toc_items:
            if isinstance(entry, tuple):
                section, children = entry
                if hasattr(section, "href") and hasattr(section, "title") and section.title:
                    href = section.href
                    parts = href.split("#", 1)
                    fname = parts[0]
                    fragment = parts[1] if len(parts) > 1 else ""
                    if fname:
                        entries.append((fname, fragment, section.title.strip()))
                _walk(children)
            elif hasattr(entry, "href") and hasattr(entry, "title") and entry.title:
                href = entry.href
                parts = href.split("#", 1)
                fname = parts[0]
                fragment = parts[1] if len(parts) > 1 else ""
                if fname:
                    entries.append((fname, fragment, entry.title.strip()))

    try:
        _walk(book.toc)
    except Exception:
        pass

    return entries


def parse_epub(file_path: str) -> ParsedBook:
    """Parse an EPUB file and return structured book data.

    Uses a multi-strategy approach for chapter detection:
    1. TOC entries with fragment anchors → split single files into chapters
    2. Spine items matched to TOC titles → one file = one chapter
    3. Heading-based splitting → for large files with no TOC coverage

    Parameters
    ----------
    file_path:
        Path to an ``.epub`` file on disk.

    Returns
    -------
    ParsedBook
    """
    book = epub.read_epub(file_path)

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

    # --- TOC entries (with fragments) ---------------------------------------
    toc_entries = _build_toc_entries(book)

    # Group TOC entries by filename
    toc_by_file: dict[str, list[tuple[str, str]]] = {}
    toc_title_map: dict[str, str] = {}  # filename → first TOC title (no fragment)
    for fname, fragment, toc_title in toc_entries:
        if fragment:
            toc_by_file.setdefault(fname, []).append((fragment, toc_title))
        if fname not in toc_title_map:
            toc_title_map[fname] = toc_title

    # --- chapters in spine order --------------------------------------------
    chapters: list[ParsedChapter] = []
    chapter_counter = 0
    processed_files: set[str] = set()

    # book.spine is a list of (id, linear) tuples
    items_by_id: dict[str, epub.EpubItem] = {
        item.get_id(): item for item in book.get_items()
    }

    for item_id, linear in book.spine:
        # Skip non-linear items (covers, copyright pages, etc.)
        if linear == "no":
            continue

        item = items_by_id.get(item_id)
        if item is None:
            continue
        if item.get_type() != ebooklib.ITEM_DOCUMENT:
            continue

        fname = item.get_name()
        if fname in processed_files:
            continue
        processed_files.add(fname)

        content = item.get_content()
        if not content:
            continue

        # Strategy 1: TOC has fragment anchors into this file → split by fragments
        fragment_entries = toc_by_file.get(fname)
        if fragment_entries and len(fragment_entries) > 1:
            frag_chapters = _split_by_toc_fragments(content, fragment_entries)
            if frag_chapters:
                # Filter out front/back matter from fragment-split results
                frag_chapters = [
                    ch for ch in frag_chapters
                    if not _SKIP_PATTERNS.match(ch.title.strip())
                    and not _TITLE_ONLY.match(ch.title.strip())
                ]
                chapters.extend(frag_chapters)
                chapter_counter += len(frag_chapters)
                continue

        # Strategy 2: Normal single-file chapter
        heading_title, text = _extract_text(content)

        if len(text) < _MIN_CHAPTER_LENGTH:
            continue

        # Strategy 3: Large file with no fragment TOC → try heading-based split
        if len(text) > _LARGE_CHAPTER_THRESHOLD and not fragment_entries:
            heading_chapters = _split_by_headings(content)
            if heading_chapters:
                heading_chapters = [
                    ch for ch in heading_chapters
                    if not _SKIP_PATTERNS.match(ch.title.strip())
                    and not _TITLE_ONLY.match(ch.title.strip())
                ]
                chapters.extend(heading_chapters)
                chapter_counter += len(heading_chapters)
                continue

        # Single chapter from this file
        chapter_counter += 1
        toc_title = toc_title_map.get(fname)
        final_title = toc_title or heading_title or f"Chapter {chapter_counter}"

        # Skip front/back matter by title — check BOTH toc title and heading
        if _SKIP_PATTERNS.match(final_title.strip()) or _TITLE_ONLY.match(final_title.strip()):
            chapter_counter -= 1
            continue
        # Also skip if heading indicates front matter even when TOC says otherwise
        if heading_title and _SKIP_PATTERNS.match(heading_title.strip()):
            chapter_counter -= 1
            continue

        # Skip short items with no TOC entry (likely front/back matter)
        if not toc_title and len(text) < 2000:
            chapter_counter -= 1
            continue

        chapters.append(ParsedChapter(title=final_title, text=text))

    return ParsedBook(title=title, author=author, chapters=chapters)

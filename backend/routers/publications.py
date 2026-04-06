import json
import os
import re
import shutil
import uuid
from typing import Callable

from fastapi import APIRouter, HTTPException, UploadFile

from backend.database import get_db
from backend.parser_types import ContentType, ParsedBook
from backend.epub_parser import parse_epub
from backend.pdf_parser import parse_pdf
from backend.mobi_parser import parse_mobi
from backend.txt_parser import parse_txt
from backend.html_parser import parse_html
from backend.md_parser import parse_md
from backend.fb2_parser import parse_fb2
from backend.rtf_parser import parse_rtf
from backend.docx_parser import parse_docx
from backend.djvu_parser import parse_djvu
from backend.cbz_cbr_parser import parse_cbz_cbr
from backend.chunker import chunk_text
from backend.models import (
    PublicationOut, PublicationDetail, ChapterOut,
    ImagePageOut, ImagePageBatchOut,
)

router = APIRouter(prefix="/publications", tags=["publications"])

UPLOAD_DIR = "/workspace/data/uploads"

# Maps file extension to parser function
_PARSER_MAP: dict[str, Callable[[str], ParsedBook]] = {
    ".epub": parse_epub,
    ".pdf": parse_pdf,
    ".mobi": parse_mobi,
    ".azw3": parse_mobi,
    ".txt": parse_txt,
    ".html": parse_html,
    ".htm": parse_html,
    ".md": parse_md,
    ".fb2": parse_fb2,
    ".rtf": parse_rtf,
    ".docx": parse_docx,
    ".djvu": parse_djvu,
    ".cbz": parse_cbz_cbr,
    ".cbr": parse_cbz_cbr,
}

_SUPPORTED_EXTENSIONS = set(_PARSER_MAP.keys()) | {".fb2.zip"}


def _detect_extension(filename_lower: str) -> str:
    """Detect file extension, handling compound extensions like .fb2.zip."""
    if filename_lower.endswith(".fb2.zip"):
        return ".fb2"
    return os.path.splitext(filename_lower)[1]


@router.post("/upload", response_model=PublicationOut)
async def upload_publication(file: UploadFile):
    if not file.filename:
        raise HTTPException(status_code=400, detail="No filename provided.")

    filename_lower = file.filename.lower()
    ext = _detect_extension(filename_lower)

    if ext not in _PARSER_MAP:
        supported = ", ".join(sorted(_SUPPORTED_EXTENSIONS))
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file format. Accepted: {supported}",
        )

    # Save file to disk
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    unique_name = f"{uuid.uuid4()}_{file.filename}"
    file_path = os.path.join(UPLOAD_DIR, unique_name)

    contents = await file.read()
    with open(file_path, "wb") as f:
        f.write(contents)

    # Parse based on file extension
    parser = _PARSER_MAP[ext]
    try:
        book = parser(file_path)
    except Exception as exc:
        os.remove(file_path)
        raise HTTPException(status_code=422, detail=f"Failed to parse file: {exc}")

    # Store in DB using a transaction
    async with get_db() as db:
        cursor = await db.execute(
            "INSERT INTO publications (title, author, filename, content_type) VALUES (?, ?, ?, ?)",
            (book.title, book.author, file.filename, book.content_type.value),
        )
        pub_id = cursor.lastrowid

        if book.content_type == ContentType.TEXT:
            # Text content: chunk into segments
            _IMG_PLACEHOLDER_RE = re.compile(r"\{\{IMG_(\d+)\}\}")
            total_segments = 0
            for ch_idx, chapter in enumerate(book.chapters):
                ch_cursor = await db.execute(
                    "INSERT INTO chapters (publication_id, chapter_index, title, text_content) VALUES (?, ?, ?, ?)",
                    (pub_id, ch_idx, chapter.title, chapter.text),
                )
                ch_id = ch_cursor.lastrowid

                # Build placeholder → InlineImage mapping for this chapter
                img_map: dict[str, object] = {}
                for img in (chapter.inline_images or []):
                    img_map[img.placeholder] = img

                segments = chunk_text(chapter.text)
                for seg in segments:
                    # Check if this segment contains image placeholders
                    seg_images_json = None
                    matches = _IMG_PLACEHOLDER_RE.findall(seg.text)
                    if matches and img_map:
                        seg_images = []
                        for m in matches:
                            placeholder = f"{{{{IMG_{m}}}}}"
                            img = img_map.get(placeholder)
                            if img:
                                seg_images.append({
                                    "image_path": img.image_path,
                                    "alt": img.alt,
                                    "width": img.width,
                                    "height": img.height,
                                    "mime_type": img.mime_type,
                                })
                        if seg_images:
                            seg_images_json = json.dumps(seg_images)
                            # Remove placeholders from segment text for clean display
                            clean_text = _IMG_PLACEHOLDER_RE.sub("", seg.text).strip()
                            clean_text = re.sub(r"\s{2,}", " ", clean_text)
                            if clean_text:
                                seg = seg.__class__(
                                    index=seg.index,
                                    text=clean_text,
                                    word_count=len(clean_text.split()),
                                    duration_ms=seg.duration_ms,
                                )

                    await db.execute(
                        "INSERT INTO segments (chapter_id, segment_index, text, word_count, duration_ms, inline_images) VALUES (?, ?, ?, ?, ?, ?)",
                        (ch_id, seg.index, seg.text, seg.word_count, seg.duration_ms, seg_images_json),
                    )
                total_segments += len(segments)

            await db.execute(
                "UPDATE publications SET total_segments = ? WHERE id = ?",
                (total_segments, pub_id),
            )

        elif book.content_type == ContentType.IMAGE:
            # Image content: store image page references
            total_pages = 0
            for ch_idx, img_chapter in enumerate(book.image_chapters):
                ch_cursor = await db.execute(
                    "INSERT INTO chapters (publication_id, chapter_index, title, text_content) VALUES (?, ?, ?, NULL)",
                    (pub_id, ch_idx, img_chapter.title),
                )
                ch_id = ch_cursor.lastrowid

                for page in img_chapter.pages:
                    await db.execute(
                        "INSERT INTO image_pages (chapter_id, page_index, image_path, width, height, mime_type) VALUES (?, ?, ?, ?, ?, ?)",
                        (ch_id, page.page_index, page.image_path, page.width, page.height, page.mime_type),
                    )
                total_pages += len(img_chapter.pages)

            await db.execute(
                "UPDATE publications SET total_pages = ? WHERE id = ?",
                (total_pages, pub_id),
            )

        await db.commit()

        row = await db.execute("SELECT * FROM publications WHERE id = ?", (pub_id,))
        pub_row = await row.fetchone()

    return PublicationOut(**dict(pub_row))


@router.get("/", response_model=list[PublicationOut])
async def list_publications():
    async with get_db() as db:
        cursor = await db.execute("SELECT * FROM publications ORDER BY id")
        rows = await cursor.fetchall()
    return [PublicationOut(**dict(r)) for r in rows]


@router.delete("/{pub_id}", status_code=204)
async def delete_publication(pub_id: int):
    async with get_db() as db:
        cursor = await db.execute("SELECT id FROM publications WHERE id = ?", (pub_id,))
        if not await cursor.fetchone():
            raise HTTPException(status_code=404, detail="Publication not found.")

        # Collect image directories to clean up after DB delete
        img_cursor = await db.execute(
            "SELECT DISTINCT image_path FROM image_pages "
            "WHERE chapter_id IN (SELECT id FROM chapters WHERE publication_id = ?)",
            (pub_id,),
        )
        img_rows = await img_cursor.fetchall()
        image_dirs: set[str] = set()
        for row in img_rows:
            # image_path is like "uuid/0001.jpg" — extract the uuid directory
            parts = row["image_path"].split("/", 1)
            if parts:
                image_dirs.add(os.path.join("/workspace/data/images", parts[0]))

        await db.execute(
            "DELETE FROM image_pages WHERE chapter_id IN (SELECT id FROM chapters WHERE publication_id = ?)",
            (pub_id,),
        )
        await db.execute(
            "DELETE FROM segments WHERE chapter_id IN (SELECT id FROM chapters WHERE publication_id = ?)",
            (pub_id,),
        )
        await db.execute("DELETE FROM chapters WHERE publication_id = ?", (pub_id,))
        await db.execute("DELETE FROM reading_progress WHERE publication_id = ?", (pub_id,))
        await db.execute("DELETE FROM bookmarks WHERE publication_id = ?", (pub_id,))
        await db.execute("DELETE FROM highlights WHERE publication_id = ?", (pub_id,))
        await db.execute("DELETE FROM publications WHERE id = ?", (pub_id,))
        await db.commit()

    # Clean up extracted image files from disk
    for img_dir in image_dirs:
        shutil.rmtree(img_dir, ignore_errors=True)


@router.get("/{pub_id}", response_model=PublicationDetail)
async def get_publication(pub_id: int):
    async with get_db() as db:
        cursor = await db.execute("SELECT * FROM publications WHERE id = ?", (pub_id,))
        pub_row = await cursor.fetchone()
        if not pub_row:
            raise HTTPException(status_code=404, detail="Publication not found.")

        ch_cursor = await db.execute(
            "SELECT id, publication_id, chapter_index, title FROM chapters WHERE publication_id = ? ORDER BY chapter_index",
            (pub_id,),
        )
        ch_rows = await ch_cursor.fetchall()

    chapters = [ChapterOut(**dict(r)) for r in ch_rows]
    return PublicationDetail(**dict(pub_row), chapters=chapters)


@router.get("/{pub_id}/chapters/{chapter_id}/pages", response_model=ImagePageBatchOut)
async def get_image_pages(pub_id: int, chapter_id: int, start: int = 0, end: int = 20):
    async with get_db() as db:
        # Verify the chapter belongs to this publication
        ch_cursor = await db.execute(
            "SELECT id FROM chapters WHERE id = ? AND publication_id = ?",
            (chapter_id, pub_id),
        )
        if not await ch_cursor.fetchone():
            raise HTTPException(status_code=404, detail="Chapter not found.")

        # Get total count
        count_cursor = await db.execute(
            "SELECT COUNT(*) FROM image_pages WHERE chapter_id = ?",
            (chapter_id,),
        )
        total = (await count_cursor.fetchone())[0]

        # Get page range
        cursor = await db.execute(
            "SELECT * FROM image_pages WHERE chapter_id = ? AND page_index >= ? AND page_index < ? ORDER BY page_index",
            (chapter_id, start, end),
        )
        rows = await cursor.fetchall()

    pages = [ImagePageOut(**dict(r)) for r in rows]
    return ImagePageBatchOut(
        chapter_id=chapter_id,
        start_index=start,
        end_index=end,
        pages=pages,
        total_pages=total,
    )

import os
import uuid

from fastapi import APIRouter, HTTPException, UploadFile

from backend.database import get_db
from backend.epub_parser import parse_epub
from backend.pdf_parser import parse_pdf
from backend.mobi_parser import parse_mobi
from backend.chunker import chunk_text
from backend.models import PublicationOut, PublicationDetail, ChapterOut

router = APIRouter(prefix="/publications", tags=["publications"])

UPLOAD_DIR = "/workspace/data/uploads"

_SUPPORTED_EXTENSIONS = {".epub", ".pdf", ".mobi"}


@router.post("/upload", response_model=PublicationOut)
async def upload_publication(file: UploadFile):
    # Validate extension
    if not file.filename:
        raise HTTPException(status_code=400, detail="No filename provided.")

    filename_lower = file.filename.lower()
    ext = os.path.splitext(filename_lower)[1]
    if ext not in _SUPPORTED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail="Unsupported file format. Accepted formats: .epub, .pdf, .mobi",
        )

    # Save file to disk
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    unique_name = f"{uuid.uuid4()}_{file.filename}"
    file_path = os.path.join(UPLOAD_DIR, unique_name)

    contents = await file.read()
    with open(file_path, "wb") as f:
        f.write(contents)

    # Parse based on file extension
    try:
        if ext == ".epub":
            book = parse_epub(file_path)
        elif ext == ".pdf":
            book = parse_pdf(file_path)
        elif ext == ".mobi":
            book = parse_mobi(file_path)
    except Exception as exc:
        os.remove(file_path)
        raise HTTPException(status_code=422, detail=f"Failed to parse file: {exc}")

    # Store in DB using a transaction
    async with get_db() as db:
        cursor = await db.execute(
            "INSERT INTO publications (title, author, filename) VALUES (?, ?, ?)",
            (book.title, book.author, file.filename),
        )
        pub_id = cursor.lastrowid

        total_segments = 0
        for ch_idx, chapter in enumerate(book.chapters):
            ch_cursor = await db.execute(
                "INSERT INTO chapters (publication_id, chapter_index, title, text_content) VALUES (?, ?, ?, ?)",
                (pub_id, ch_idx, chapter.title, chapter.text),
            )
            ch_id = ch_cursor.lastrowid

            segments = chunk_text(chapter.text)
            for seg in segments:
                await db.execute(
                    "INSERT INTO segments (chapter_id, segment_index, text, word_count, duration_ms) VALUES (?, ?, ?, ?, ?)",
                    (ch_id, seg.index, seg.text, seg.word_count, seg.duration_ms),
                )
            total_segments += len(segments)

        await db.execute(
            "UPDATE publications SET total_segments = ? WHERE id = ?",
            (total_segments, pub_id),
        )
        await db.commit()

        # Fetch the created publication
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

        # Get chapter IDs for cascading deletes
        ch_cursor = await db.execute(
            "SELECT id FROM chapters WHERE publication_id = ?", (pub_id,)
        )
        ch_ids = [r["id"] for r in await ch_cursor.fetchall()]

        if ch_ids:
            placeholders = ",".join("?" * len(ch_ids))
            await db.execute(f"DELETE FROM segments WHERE chapter_id IN ({placeholders})", ch_ids)

        await db.execute("DELETE FROM chapters WHERE publication_id = ?", (pub_id,))
        await db.execute("DELETE FROM reading_progress WHERE publication_id = ?", (pub_id,))
        await db.execute("DELETE FROM bookmarks WHERE publication_id = ?", (pub_id,))
        await db.execute("DELETE FROM highlights WHERE publication_id = ?", (pub_id,))
        await db.execute("DELETE FROM publications WHERE id = ?", (pub_id,))
        await db.commit()


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

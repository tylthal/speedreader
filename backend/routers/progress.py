from fastapi import APIRouter, HTTPException

from backend.database import get_db
from backend.models import ReadingProgressIn, ReadingProgressOut

router = APIRouter(prefix="/progress", tags=["progress"])


async def _compute_segments_read(db, pub_id: int, chapter_id: int, segment_index: int) -> int:
    """Count total segments in all preceding chapters + current segment_index."""
    ch_cursor = await db.execute(
        "SELECT id, chapter_index FROM chapters WHERE publication_id = ? ORDER BY chapter_index",
        (pub_id,),
    )
    chapters = await ch_cursor.fetchall()

    segments_before = 0
    for ch in chapters:
        if ch["id"] == chapter_id:
            break
        cnt = await db.execute(
            "SELECT COUNT(*) as cnt FROM segments WHERE chapter_id = ?",
            (ch["id"],),
        )
        cnt_row = await cnt.fetchone()
        segments_before += cnt_row["cnt"]

    return segments_before + segment_index


@router.get("/publications/{pub_id}", response_model=ReadingProgressOut)
async def get_progress(pub_id: int):
    async with get_db() as db:
        cursor = await db.execute(
            "SELECT publication_id, chapter_id, segment_index, word_index, wpm, reading_mode, updated_at "
            "FROM reading_progress WHERE publication_id = ?",
            (pub_id,),
        )
        row = await cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="No saved progress for this publication.")

        progress = dict(row)
        progress["segments_read"] = await _compute_segments_read(
            db, pub_id, progress["chapter_id"], progress["segment_index"]
        )

    return ReadingProgressOut(**progress)


@router.put("/publications/{pub_id}", response_model=ReadingProgressOut)
async def upsert_progress(pub_id: int, body: ReadingProgressIn):
    async with get_db() as db:
        await db.execute(
            "INSERT OR REPLACE INTO reading_progress "
            "(publication_id, chapter_id, segment_index, word_index, wpm, reading_mode, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)",
            (pub_id, body.chapter_id, body.segment_index, body.word_index, body.wpm, body.reading_mode),
        )
        await db.commit()

        cursor = await db.execute(
            "SELECT publication_id, chapter_id, segment_index, word_index, wpm, reading_mode, updated_at "
            "FROM reading_progress WHERE publication_id = ?",
            (pub_id,),
        )
        row = await cursor.fetchone()
        progress = dict(row)
        progress["segments_read"] = await _compute_segments_read(
            db, pub_id, progress["chapter_id"], progress["segment_index"]
        )

    return ReadingProgressOut(**progress)

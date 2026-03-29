from fastapi import APIRouter, HTTPException

from backend.database import get_db
from backend.models import ReadingProgressIn, ReadingProgressOut

router = APIRouter(prefix="/progress", tags=["progress"])


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
    return ReadingProgressOut(**dict(row))


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
    return ReadingProgressOut(**dict(row))

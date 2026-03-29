from fastapi import APIRouter, HTTPException

from backend.database import get_db
from backend.models import HighlightIn, HighlightOut

router = APIRouter(prefix="/highlights", tags=["highlights"])


@router.post("/publications/{pub_id}", response_model=HighlightOut)
async def create_highlight(pub_id: int, body: HighlightIn):
    async with get_db() as db:
        cursor = await db.execute(
            "INSERT INTO highlights (publication_id, chapter_id, segment_index, text, color, note) VALUES (?, ?, ?, ?, ?, ?)",
            (pub_id, body.chapter_id, body.segment_index, body.text, body.color, body.note),
        )
        await db.commit()
        highlight_id = cursor.lastrowid

        row = await db.execute("SELECT * FROM highlights WHERE id = ?", (highlight_id,))
        highlight = await row.fetchone()

    return HighlightOut(**dict(highlight))


@router.get("/publications/{pub_id}", response_model=list[HighlightOut])
async def list_highlights(pub_id: int):
    async with get_db() as db:
        cursor = await db.execute(
            "SELECT * FROM highlights WHERE publication_id = ? ORDER BY created_at DESC",
            (pub_id,),
        )
        rows = await cursor.fetchall()

    return [HighlightOut(**dict(r)) for r in rows]


@router.delete("/{highlight_id}", status_code=204)
async def delete_highlight(highlight_id: int):
    async with get_db() as db:
        cursor = await db.execute("DELETE FROM highlights WHERE id = ?", (highlight_id,))
        await db.commit()
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Highlight not found.")

from fastapi import APIRouter, HTTPException

from backend.database import get_db
from backend.models import BookmarkIn, BookmarkOut

router = APIRouter(prefix="/bookmarks", tags=["bookmarks"])


@router.post("/publications/{pub_id}", response_model=BookmarkOut)
async def create_bookmark(pub_id: int, body: BookmarkIn):
    async with get_db() as db:
        try:
            cursor = await db.execute(
                "INSERT INTO bookmarks (publication_id, chapter_id, segment_index, note) VALUES (?, ?, ?, ?)",
                (pub_id, body.chapter_id, body.segment_index, body.note),
            )
            await db.commit()
            bookmark_id = cursor.lastrowid
        except Exception:
            raise HTTPException(
                status_code=409,
                detail="Bookmark already exists for this segment.",
            )

        row = await db.execute("SELECT * FROM bookmarks WHERE id = ?", (bookmark_id,))
        bookmark = await row.fetchone()

    return BookmarkOut(**dict(bookmark))


@router.get("/publications/{pub_id}", response_model=list[BookmarkOut])
async def list_bookmarks(pub_id: int):
    async with get_db() as db:
        cursor = await db.execute(
            "SELECT * FROM bookmarks WHERE publication_id = ? ORDER BY created_at DESC",
            (pub_id,),
        )
        rows = await cursor.fetchall()

    return [BookmarkOut(**dict(r)) for r in rows]


@router.delete("/{bookmark_id}", status_code=204)
async def delete_bookmark(bookmark_id: int):
    async with get_db() as db:
        cursor = await db.execute("DELETE FROM bookmarks WHERE id = ?", (bookmark_id,))
        await db.commit()
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Bookmark not found.")

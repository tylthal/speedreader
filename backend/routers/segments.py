from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse

from backend.database import get_db
from backend.models import SegmentOut, SegmentBatchOut

DATA_SAVER_MAX_BATCH = 20

router = APIRouter(prefix="/publications", tags=["segments"])


@router.get("/{pub_id}/chapters/{chapter_id}/segments", response_model=SegmentBatchOut)
async def get_segments(
    request: Request,
    pub_id: int,
    chapter_id: int,
    start: int = Query(default=0, ge=0),
    end: int = Query(default=50, ge=0),
):
    save_data = request.headers.get("Save-Data", "").lower() == "on"
    if save_data and (end - start) > DATA_SAVER_MAX_BATCH:
        end = start + DATA_SAVER_MAX_BATCH
    async with get_db() as db:
        # Validate that the chapter belongs to the publication
        cursor = await db.execute(
            "SELECT id FROM chapters WHERE id = ? AND publication_id = ?",
            (chapter_id, pub_id),
        )
        ch_row = await cursor.fetchone()
        if not ch_row:
            raise HTTPException(
                status_code=404,
                detail="Chapter not found or does not belong to this publication.",
            )

        # Get total segment count for this chapter
        count_cursor = await db.execute(
            "SELECT COUNT(*) as cnt FROM segments WHERE chapter_id = ?",
            (chapter_id,),
        )
        count_row = await count_cursor.fetchone()
        total_segments = count_row["cnt"]

        # Fetch the requested range of segments
        seg_cursor = await db.execute(
            "SELECT * FROM segments WHERE chapter_id = ? AND segment_index >= ? AND segment_index < ? ORDER BY segment_index",
            (chapter_id, start, end),
        )
        seg_rows = await seg_cursor.fetchall()

    segments = [SegmentOut(**dict(r)) for r in seg_rows]

    result = SegmentBatchOut(
        chapter_id=chapter_id,
        start_index=start,
        end_index=end,
        segments=segments,
        total_segments=total_segments,
    )

    if save_data:
        response = JSONResponse(content=result.model_dump())
        response.headers["Vary"] = "Save-Data"
        return response

    return result

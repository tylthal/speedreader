from pydantic import BaseModel


class PublicationOut(BaseModel):
    id: int
    title: str | None = None
    author: str | None = None
    filename: str | None = None
    status: str = "ready"
    total_segments: int = 0
    content_type: str = "text"
    total_pages: int = 0
    created_at: str | None = None


class ChapterOut(BaseModel):
    id: int
    publication_id: int
    chapter_index: int
    title: str | None = None


class InlineImageOut(BaseModel):
    image_url: str
    alt: str = ""
    width: int = 0
    height: int = 0


class SegmentOut(BaseModel):
    id: int
    chapter_id: int
    segment_index: int
    text: str
    word_count: int
    duration_ms: int
    inline_images: list[InlineImageOut] | None = None


class SegmentBatchOut(BaseModel):
    chapter_id: int
    start_index: int
    end_index: int
    segments: list[SegmentOut]
    total_segments: int


class PublicationDetail(PublicationOut):
    chapters: list[ChapterOut] = []


class ReadingProgressIn(BaseModel):
    chapter_id: int
    segment_index: int
    word_index: int = 0
    wpm: int
    reading_mode: str = "phrase"


class ReadingProgressOut(BaseModel):
    publication_id: int
    chapter_id: int
    segment_index: int
    word_index: int = 0
    wpm: int
    reading_mode: str = "phrase"
    updated_at: str
    segments_read: int = 0


class ImagePageOut(BaseModel):
    id: int
    chapter_id: int
    page_index: int
    image_path: str
    width: int | None = None
    height: int | None = None
    mime_type: str = "image/jpeg"


class ImagePageBatchOut(BaseModel):
    chapter_id: int
    start_index: int
    end_index: int
    pages: list[ImagePageOut]
    total_pages: int


class BookmarkIn(BaseModel):
    chapter_id: int
    segment_index: int
    note: str = ""


class BookmarkOut(BaseModel):
    id: int
    publication_id: int
    chapter_id: int
    segment_index: int
    note: str
    created_at: str


class HighlightIn(BaseModel):
    chapter_id: int
    segment_index: int
    text: str
    color: str = "yellow"
    note: str = ""


class HighlightOut(BaseModel):
    id: int
    publication_id: int
    chapter_id: int
    segment_index: int
    text: str
    color: str
    note: str
    created_at: str

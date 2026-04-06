export type ContentType = 'text' | 'image'

export interface Publication {
  id: number
  title: string
  author: string
  filename: string
  status: string
  total_segments: number
  content_type: ContentType
  total_pages: number
  created_at: string
}

export interface ImagePage {
  id: number
  chapter_id: number
  page_index: number
  image_path: string
  width: number | null
  height: number | null
  mime_type: string
}

export interface ImagePageBatch {
  chapter_id: number
  start_index: number
  end_index: number
  pages: ImagePage[]
  total_pages: number
}

export interface Chapter {
  id: number
  publication_id: number
  chapter_index: number
  title: string
}

export interface PublicationDetail extends Publication {
  chapters: Chapter[]
}

export interface SegmentInlineImage {
  image_url: string
  alt: string
  width: number
  height: number
}

export interface Segment {
  id: number
  chapter_id: number
  segment_index: number
  text: string
  word_count: number
  duration_ms: number
  inline_images?: SegmentInlineImage[] | null
}

export interface SegmentBatch {
  chapter_id: number
  start_index: number
  end_index: number
  segments: Segment[]
  total_segments: number
}

export interface ReadingProgress {
  publication_id: number
  chapter_id: number
  segment_index: number
  word_index: number
  wpm: number
  reading_mode: string
  updated_at: string
  segments_read: number
}

export interface Bookmark {
  id: number
  publication_id: number
  chapter_id: number
  segment_index: number
  note: string
  created_at: string
}

export interface Highlight {
  id: number
  publication_id: number
  chapter_id: number
  segment_index: number
  text: string
  color: string
  note: string
  created_at: string
}

export interface ProgressInput {
  chapter_id: number
  segment_index: number
  word_index: number
  wpm: number
  reading_mode: string
}

export interface BookmarkInput {
  chapter_id: number
  segment_index: number
  note?: string
}

export interface HighlightInput {
  chapter_id: number
  segment_index: number
  text: string
  color?: string
  note?: string
}

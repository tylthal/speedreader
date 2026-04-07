export type ContentType = 'text' | 'image'

export type DisplayMode = 'plain' | 'formatted'

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
  /** OPFS-resolvable cover URL (when present). */
  cover_url?: string | null
  /** Per-book display mode preference. */
  display_mode_pref?: DisplayMode | null
}

/** A node in the hierarchical TOC tree (PRD §6.4). */
export interface TocNode {
  title: string
  /** Index into PublicationDetail.chapters; -1 for display-only parents. */
  section_index: number
  children?: TocNode[]
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
  /** Hierarchical TOC tree, if the source has one. Optional. */
  toc_tree?: TocNode[] | null
}

export interface SegmentInlineImage {
  image_url: string
  alt: string
  width: number
  height: number
}

export type SegmentKind = 'text' | 'section_title'

export interface Segment {
  id: number
  chapter_id: number
  segment_index: number
  text: string
  word_count: number
  duration_ms: number
  inline_images?: SegmentInlineImage[] | null
  /** Anchor inside the section's html string for Plain↔Formatted mapping. */
  html_anchor?: string | null
  /** 'section_title' for synthetic title segments at section boundaries. */
  kind?: SegmentKind | null
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

export interface ProgressInput {
  chapter_id: number
  segment_index: number
  word_index: number
  wpm: number
  reading_mode: string
}

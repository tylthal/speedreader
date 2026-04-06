import Dexie from 'dexie'
import type { Table } from 'dexie'

// ---------------------------------------------------------------------------
// Table interfaces
// ---------------------------------------------------------------------------

export interface DBPublication {
  id?: number
  title: string
  author: string
  filename: string
  status: string
  total_segments: number
  content_type: 'text' | 'image'
  total_pages: number
  created_at: string
}

export interface DBChapter {
  id?: number
  publication_id: number
  chapter_index: number
  title: string
  text_content: string | null
  segment_count: number
}

export interface DBSegment {
  id?: number
  chapter_id: number
  segment_index: number
  text: string
  word_count: number
  duration_ms: number
  inline_images: string | null // JSON string matching backend format
}

export interface DBImagePage {
  id?: number
  chapter_id: number
  page_index: number
  image_path: string // OPFS key or server-relative path
  width: number | null
  height: number | null
  mime_type: string
}

export interface DBReadingProgress {
  id?: number
  publication_id: number
  chapter_id: number
  segment_index: number
  word_index: number
  wpm: number
  reading_mode: string
  updated_at: string
}

export interface DBBookmark {
  id?: number
  publication_id: number
  chapter_id: number
  segment_index: number
  note: string
  created_at: string
}

export interface DBHighlight {
  id?: number
  publication_id: number
  chapter_id: number
  segment_index: number
  text: string
  color: string
  note: string
  created_at: string
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

class SpeedReaderDB extends Dexie {
  publications!: Table<DBPublication, number>
  chapters!: Table<DBChapter, number>
  segments!: Table<DBSegment, number>
  image_pages!: Table<DBImagePage, number>
  reading_progress!: Table<DBReadingProgress, number>
  bookmarks!: Table<DBBookmark, number>
  highlights!: Table<DBHighlight, number>

  constructor() {
    super('speedreader')
    this.version(1).stores({
      publications: '++id, status, content_type, created_at',
      chapters: '++id, publication_id, [publication_id+chapter_index]',
      segments: '++id, chapter_id, [chapter_id+segment_index]',
      image_pages: '++id, chapter_id, [chapter_id+page_index]',
      reading_progress: '++id, &publication_id',
      bookmarks: '++id, publication_id, [publication_id+chapter_id+segment_index]',
      highlights: '++id, publication_id, [publication_id+chapter_id+segment_index]',
    })
  }
}

export const db = new SpeedReaderDB()

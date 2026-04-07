import Dexie from 'dexie'
import type { Table } from 'dexie'

// ---------------------------------------------------------------------------
// Table interfaces
// ---------------------------------------------------------------------------

export type DisplayMode = 'plain' | 'formatted'

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
  // --- Reader redesign additions ---
  /** Relative OPFS path of the cover image, if extracted at upload time. */
  cover_path?: string | null
  /** Per-book preferred display mode. Falls back to the global default. */
  display_mode_pref?: DisplayMode | null
  /** JSON-encoded TOC tree (hierarchy from NCX/PDF outline) for the sidebar. */
  toc_json?: string | null
}

/**
 * A chapter row. The PRD calls these "sections" — we keep the legacy table
 * name `chapters` to avoid a churny rename of every reader-side reference in
 * P1; the rename is queued for the reader rewrite phase.
 */
export interface DBChapter {
  id?: number
  publication_id: number
  chapter_index: number
  title: string
  text_content: string | null
  segment_count: number
  // --- Reader redesign additions ---
  /** Sanitized HTML for formatted view. Empty string for PDF/CBZ. */
  html?: string | null
  /** JSON blob of format-specific metadata (e.g. PDF page range). */
  meta?: string | null
}

export type SegmentKind = 'text' | 'section_title'

export interface DBSegment {
  id?: number
  chapter_id: number
  segment_index: number
  text: string
  word_count: number
  duration_ms: number
  inline_images: string | null // JSON string matching backend format
  // --- Reader redesign additions ---
  /** HTML element id (or character offset) inside the section's html string. */
  html_anchor?: string | null
  /** Distinguishes synthetic section-title segments from regular text. */
  kind?: SegmentKind | null
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

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

class SpeedReaderDB extends Dexie {
  publications!: Table<DBPublication, number>
  chapters!: Table<DBChapter, number>
  segments!: Table<DBSegment, number>
  image_pages!: Table<DBImagePage, number>
  reading_progress!: Table<DBReadingProgress, number>

  constructor() {
    super('speedreader')

    // v1: legacy schema (kept so Dexie's upgrade machinery has a starting
    // point on machines that already opened the old db).
    this.version(1).stores({
      publications: '++id, status, content_type, created_at',
      chapters: '++id, publication_id, [publication_id+chapter_index]',
      segments: '++id, chapter_id, [chapter_id+segment_index]',
      image_pages: '++id, chapter_id, [chapter_id+page_index]',
      reading_progress: '++id, &publication_id',
      bookmarks: '++id, publication_id, [publication_id+chapter_id+segment_index]',
      highlights: '++id, publication_id, [publication_id+chapter_id+segment_index]',
    })

    // v2: reader redesign.
    //  - bookmarks/highlights tables removed (set to null per Dexie's drop syntax)
    //  - new fields are non-indexed; they only need a stores() bump to be
    //    visible to the typed Table<> wrapper, not for querying.
    this.version(2).stores({
      publications: '++id, status, content_type, created_at',
      chapters: '++id, publication_id, [publication_id+chapter_index]',
      segments: '++id, chapter_id, [chapter_id+segment_index]',
      image_pages: '++id, chapter_id, [chapter_id+page_index]',
      reading_progress: '++id, &publication_id',
      bookmarks: null,
      highlights: null,
    })
  }
}

export const db = new SpeedReaderDB()

// ---------------------------------------------------------------------------
// One-time wipe (PRD §11)
// ---------------------------------------------------------------------------
//
// The redesign assumes a clean slate. Rather than write a real migration we
// drop the database the first time the v2 build runs, and let users re-upload.
// A localStorage flag prevents this from running twice. The wipe happens on
// the very first call to ensureSchemaWipe(); callers must `await` it before
// touching the db.

const SCHEMA_WIPE_FLAG = 'speedreader-schema-v2-wiped'

let wipePromise: Promise<void> | null = null

export function ensureSchemaWipe(): Promise<void> {
  if (wipePromise) return wipePromise
  wipePromise = (async () => {
    if (typeof localStorage === 'undefined') return
    try {
      if (localStorage.getItem(SCHEMA_WIPE_FLAG) === '1') return
    } catch {
      return
    }
    try {
      console.warn('[speedreader] wiping legacy database for v2 schema (one-time)')
      await db.delete()
      await db.open()
    } catch (err) {
      console.error('[speedreader] schema wipe failed', err)
    } finally {
      try {
        localStorage.setItem(SCHEMA_WIPE_FLAG, '1')
      } catch {
        /* ignore */
      }
    }
  })()
  return wipePromise
}

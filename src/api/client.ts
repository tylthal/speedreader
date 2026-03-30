export interface Publication {
  id: number
  title: string
  author: string
  filename: string
  status: string
  total_segments: number
  created_at: string
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

export interface Segment {
  id: number
  chapter_id: number
  segment_index: number
  text: string
  word_count: number
  duration_ms: number
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

const BASE = '/api/v1'

function getSaveDataHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const conn = (navigator as any).connection;
  if (conn?.saveData) {
    headers['Save-Data'] = 'on';
  }
  return headers;
}

export async function uploadBook(file: File): Promise<Publication> {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch(`${BASE}/publications/upload`, {
    method: 'POST',
    body: form,
  })
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`)
  return res.json()
}

export async function getPublications(): Promise<Publication[]> {
  const res = await fetch(`${BASE}/publications/`, {
    headers: getSaveDataHeaders(),
  })
  if (!res.ok) throw new Error(`Failed to fetch publications: ${res.status}`)
  return res.json()
}

export async function getPublication(id: number): Promise<PublicationDetail> {
  const res = await fetch(`${BASE}/publications/${id}`, {
    headers: getSaveDataHeaders(),
  })
  if (!res.ok) throw new Error(`Failed to fetch publication: ${res.status}`)
  return res.json()
}

export async function getSegments(
  pubId: number,
  chapterId: number,
  start: number,
  end: number,
): Promise<SegmentBatch> {
  const params = new URLSearchParams({
    start: String(start),
    end: String(end),
  })
  const res = await fetch(`${BASE}/publications/${pubId}/chapters/${chapterId}/segments?${params}`, {
    headers: getSaveDataHeaders(),
  })
  if (!res.ok) throw new Error(`Failed to fetch segments: ${res.status}`)
  return res.json()
}

export async function getProgress(pubId: number): Promise<ReadingProgress | null> {
  const res = await fetch(`${BASE}/progress/publications/${pubId}`)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Failed to fetch progress: ${res.status}`)
  return res.json()
}

export async function saveProgress(
  pubId: number,
  data: { chapter_id: number; segment_index: number; word_index: number; wpm: number; reading_mode: string },
): Promise<ReadingProgress> {
  const res = await fetch(`${BASE}/progress/publications/${pubId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error(`Failed to save progress: ${res.status}`)
  return res.json()
}

// Bookmarks

export async function createBookmark(
  pubId: number,
  data: { chapter_id: number; segment_index: number; note?: string },
): Promise<Bookmark> {
  const res = await fetch(`${BASE}/bookmarks/publications/${pubId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error(`Failed to create bookmark: ${res.status}`)
  return res.json()
}

export async function getBookmarks(pubId: number): Promise<Bookmark[]> {
  const res = await fetch(`${BASE}/bookmarks/publications/${pubId}`)
  if (!res.ok) throw new Error(`Failed to fetch bookmarks: ${res.status}`)
  return res.json()
}

export async function deleteBookmark(id: number): Promise<void> {
  const res = await fetch(`${BASE}/bookmarks/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`Failed to delete bookmark: ${res.status}`)
}

// Highlights

export async function createHighlight(
  pubId: number,
  data: { chapter_id: number; segment_index: number; text: string; color?: string; note?: string },
): Promise<Highlight> {
  const res = await fetch(`${BASE}/highlights/publications/${pubId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error(`Failed to create highlight: ${res.status}`)
  return res.json()
}

export async function getHighlights(pubId: number): Promise<Highlight[]> {
  const res = await fetch(`${BASE}/highlights/publications/${pubId}`)
  if (!res.ok) throw new Error(`Failed to fetch highlights: ${res.status}`)
  return res.json()
}

export async function deleteHighlight(id: number): Promise<void> {
  const res = await fetch(`${BASE}/highlights/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`Failed to delete highlight: ${res.status}`)
}

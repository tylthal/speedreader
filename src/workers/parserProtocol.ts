/**
 * Message protocol between main thread and parser Web Worker.
 *
 * Images are transferred as ArrayBuffers (zero-copy) since Blobs
 * can't be transferred. The main thread wraps them back into Blobs.
 */

// ---------------------------------------------------------------------------
// Serialized types (no Blobs — ArrayBuffers instead)
// ---------------------------------------------------------------------------

export interface SerializedInlineImage {
  placeholder: string
  imageData: ArrayBuffer
  alt: string
  width: number
  height: number
  mimeType: string
}

export interface SerializedChapter {
  title: string
  text: string
  inlineImages: SerializedInlineImage[]
}

export interface SerializedImagePage {
  pageIndex: number
  imageData: ArrayBuffer
  width: number
  height: number
  mimeType: string
}

export interface SerializedImageChapter {
  title: string
  pages: SerializedImagePage[]
}

export interface SerializedParsedBook {
  title: string
  author: string
  contentType: 'text' | 'image'
  chapters: SerializedChapter[]
  imageChapters: SerializedImageChapter[]
}

export interface ChunkedSegment {
  index: number
  text: string
  word_count: number
  duration_ms: number
}

export interface ChunkedChapter {
  title: string
  text: string
  segments: ChunkedSegment[]
  inlineImages: SerializedInlineImage[]
}

/** Final result: parsed + chunked, ready for DB insertion */
export interface WorkerResult {
  book: SerializedParsedBook
  /** Only present for text content — chapters with segments pre-computed */
  chunkedChapters: ChunkedChapter[]
}

// ---------------------------------------------------------------------------
// Messages: Main → Worker
// ---------------------------------------------------------------------------

export interface ParseRequest {
  type: 'parse'
  id: string
  data: ArrayBuffer
  filename: string
}

// ---------------------------------------------------------------------------
// Messages: Worker → Main
// ---------------------------------------------------------------------------

export interface ProgressMessage {
  type: 'progress'
  id: string
  phase: 'parsing' | 'chunking'
  percent: number
}

export interface DoneMessage {
  type: 'done'
  id: string
  result: WorkerResult
}

export interface ErrorMessage {
  type: 'error'
  id: string
  message: string
}

export type WorkerOutMessage = ProgressMessage | DoneMessage | ErrorMessage

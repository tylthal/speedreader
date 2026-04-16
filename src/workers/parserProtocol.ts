import type { InternalTocNode } from '../lib/tocTree'

/**
 * Message protocol between main thread and parser Web Worker.
 *
 * Images are transferred as ArrayBuffers (zero-copy) since Blobs can't be
 * transferred. The main thread wraps them back into Blobs and stores them
 * (cover into OPFS, image pages into image_pages, etc.).
 *
 * Reader-redesign shape: parsers emit `sections`, optionally a `cover`, an
 * optional `tocTree`, and (for CBZ) an `imagePages` sidecar.
 */

// ---------------------------------------------------------------------------
// Serialized leaves (no Blobs — ArrayBuffers instead)
// ---------------------------------------------------------------------------

export interface SerializedCover {
  imageData: ArrayBuffer
  mimeType: string
}

export interface SerializedImagePage {
  pageIndex: number
  imageData: ArrayBuffer
  width: number
  height: number
  mimeType: string
}

export interface SerializedParsedImage {
  name: string
  imageData: ArrayBuffer
  mimeType: string
}

export interface SerializedSection {
  title: string
  text: string
  html: string
  meta?: Record<string, unknown>
}

export type SerializedTocNode = InternalTocNode

export interface SerializedParsedBook {
  title: string
  author: string
  contentType: 'text' | 'image'
  sections: SerializedSection[]
  cover?: SerializedCover
  tocTree?: SerializedTocNode[]
  imagePages?: SerializedImagePage[]
  parsedImages?: SerializedParsedImage[]
}

export interface ChunkedSegment {
  index: number
  text: string
  word_count: number
  duration_ms: number
  section_index?: number
  kind?: 'text' | 'section_title'
}

export interface ChunkedSection {
  title: string
  text: string
  html: string
  meta?: Record<string, unknown>
  segments: ChunkedSegment[]
}

/** Final result: parsed + chunked, ready for DB insertion. */
export interface WorkerResult {
  book: SerializedParsedBook
  chunkedSections: ChunkedSection[]
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface PingRequest {
  type: 'ping'
  id: string
}

export interface ParseRequest {
  type: 'parse'
  id: string
  data: ArrayBuffer
  filename: string
}

export type WorkerInMessage = PingRequest | ParseRequest

export interface PongMessage {
  type: 'pong'
  id: string
  /** True iff the worker's global scope exposes DOMParser. */
  hasDOMParser: boolean
}

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

export type WorkerOutMessage =
  | PongMessage
  | ProgressMessage
  | DoneMessage
  | ErrorMessage

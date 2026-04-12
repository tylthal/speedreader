import type {
  Publication,
  PublicationDetail,
  SegmentBatch,
  ImagePageBatch,
  DisplayMode,
  Bookmark,
  BookmarkType,
  CreateBookmarkInput,
  AutoBookmarkLocation,
} from './types'

export interface SpeedReaderClient {
  uploadBook(file: File): Promise<Publication>
  getPublications(): Promise<Publication[]>
  getArchivedPublications(): Promise<Publication[]>
  archivePublication(id: number): Promise<void>
  unarchivePublication(id: number): Promise<void>
  deletePublication(id: number): Promise<void>
  getPublication(id: number): Promise<PublicationDetail>
  getSegments(pubId: number, chapterId: number, start: number, end: number): Promise<SegmentBatch>
  getImagePages(pubId: number, chapterId: number, start: number, end: number): Promise<ImagePageBatch>
  setDisplayModePref(pubId: number, mode: DisplayMode | null): Promise<void>
  getBookmarks(pubId: number): Promise<Bookmark[]>
  getAutoBookmark(pubId: number, type: 'last_opened' | 'farthest_read'): Promise<Bookmark | null>
  getAutoBookmarksForPubs(pubIds: number[], type: 'last_opened' | 'farthest_read'): Promise<Map<number, Bookmark>>
  createBookmark(pubId: number, data: CreateBookmarkInput): Promise<Bookmark>
  updateBookmark(bookmarkId: number, name: string): Promise<Bookmark>
  deleteBookmark(bookmarkId: number): Promise<void>
  upsertAutoBookmark(pubId: number, type: 'last_opened' | 'farthest_read', location: AutoBookmarkLocation): Promise<Bookmark>
}

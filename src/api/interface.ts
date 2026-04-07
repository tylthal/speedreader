import type {
  Publication,
  PublicationDetail,
  SegmentBatch,
  ImagePageBatch,
  ReadingProgress,
  ProgressInput,
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
  getImageUrl(imagePath: string): string
  getProgress(pubId: number): Promise<ReadingProgress | null>
  saveProgress(pubId: number, data: ProgressInput): Promise<ReadingProgress>
}

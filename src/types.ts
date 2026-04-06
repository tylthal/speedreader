export type ReadingMode = 'phrase' | 'rsvp' | 'scroll' | 'track' | 'image';

export interface InlineImage {
  image_url: string;
  alt: string;
  width: number;
  height: number;
}

export interface Segment {
  id: number;
  chapter_id: number;
  segment_index: number;
  text: string;
  word_count: number;
  duration_ms: number;
  inline_images?: InlineImage[] | null;
}

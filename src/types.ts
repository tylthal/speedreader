export type ReadingMode = 'phrase' | 'rsvp';

export interface Segment {
  id: number;
  chapter_id: number;
  segment_index: number;
  text: string;
  word_count: number;
  duration_ms: number;
}

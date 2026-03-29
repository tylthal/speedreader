import { useRef, useEffect, useCallback } from 'react';
import { FixedSizeList as List } from 'react-window';
import type { ListChildComponentProps } from 'react-window';
import type { Segment } from '../types';

interface TranscriptPaneProps {
  segments: Segment[];
  currentIndex: number;
  onSegmentClick: (index: number) => void;
  bookmarkedIndices?: Set<number>;
  highlightedIndices?: Map<number, string>;
}

const ROW_HEIGHT = 60;

export default function TranscriptPane({
  segments,
  currentIndex,
  onSegmentClick,
  bookmarkedIndices,
  highlightedIndices,
}: TranscriptPaneProps) {
  const listRef = useRef<List>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const heightRef = useRef(400);

  useEffect(() => {
    if (containerRef.current) {
      const h = containerRef.current.clientHeight;
      if (h > 0) heightRef.current = h;
    }
  }, []);

  useEffect(() => {
    if (listRef.current && segments.length > 0) {
      listRef.current.scrollToItem(currentIndex, 'center');
    }
  }, [currentIndex, segments.length]);

  const Row = useCallback(
    ({ index, style }: ListChildComponentProps) => {
      const seg = segments[index];
      const isActive = index === currentIndex;
      const isBookmarked = bookmarkedIndices?.has(seg.segment_index) ?? false;
      const highlightColor = highlightedIndices?.get(seg.segment_index);
      const rowClasses = [
        'transcript-pane__row',
        highlightColor ? `transcript__row--highlighted transcript__row--highlighted-${highlightColor}` : '',
      ]
        .filter(Boolean)
        .join(' ');
      return (
        <div
          style={{ ...style, position: 'relative' as const }}
          className={rowClasses}
          role="listitem"
          aria-current={isActive ? 'true' : undefined}
          onClick={() => onSegmentClick(index)}
          onKeyDown={(e: React.KeyboardEvent) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onSegmentClick(index);
            }
          }}
          tabIndex={0}
        >
          <span
            className={`transcript-pane__text${isActive ? ' transcript-pane__text--active' : ''}`}
          >
            {seg.text}
          </span>
          {isBookmarked && (
            <span className="transcript__bookmark-icon" aria-label="Bookmarked">
              {'\uD83D\uDD16'}
            </span>
          )}
        </div>
      );
    },
    [segments, currentIndex, onSegmentClick, bookmarkedIndices, highlightedIndices],
  );

  return (
    <div className="transcript-pane" ref={containerRef} role="list" aria-label="Reading transcript">
      {segments.length > 0 && (
        <List
          ref={listRef}
          height={heightRef.current}
          itemCount={segments.length}
          itemSize={ROW_HEIGHT}
          width="100%"
          overscanCount={10}
        >
          {Row}
        </List>
      )}
    </div>
  );
}

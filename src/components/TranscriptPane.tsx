import { useRef, useState, useEffect, useCallback } from 'react';
import { FixedSizeList as List } from 'react-window';
import type { ListChildComponentProps } from 'react-window';
import type { Segment } from '../types';

interface TranscriptPaneProps {
  segments: Segment[];
  currentIndex: number;
  onSegmentClick: (index: number) => void;
}

const ROW_HEIGHT = 60;

export default function TranscriptPane({
  segments,
  currentIndex,
  onSegmentClick,
}: TranscriptPaneProps) {
  const listRef = useRef<List>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(400);

  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(([entry]) => {
      const h = entry.contentRect.height;
      if (h > 0) setHeight(h);
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
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
      return (
        <div
          style={{ ...style, position: 'relative' as const }}
          className="transcript-pane__row"
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
        </div>
      );
    },
    [segments, currentIndex, onSegmentClick],
  );

  return (
    <div className="transcript-pane" ref={containerRef} role="list" aria-label="Reading transcript">
      {segments.length > 0 && (
        <List
          ref={listRef}
          height={height}
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

import { useRef, useState, useCallback } from 'react';
import type { Publication, ReadingProgress } from '../api/types';

interface BookCardProps {
  pub: Publication;
  progress?: ReadingProgress;
  onTap: (pub: Publication) => void;
  onSwipeAction?: (pub: Publication) => void;
  onLongPress?: (pub: Publication, rect: DOMRect) => void;
  swipeLabel?: string;
  swipeColor?: 'accent' | 'danger';
  disabled?: boolean;
}

export default function BookCard({
  pub,
  progress,
  onTap,
  onSwipeAction,
  onLongPress,
  swipeLabel = 'Archive',
  swipeColor = 'accent',
  disabled,
}: BookCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const startX = useRef(0);
  const startY = useRef(0);
  const currentX = useRef(0);
  const swiping = useRef(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const didLongPress = useRef(false);
  const [swipeOffset, setSwipeOffset] = useState(0);
  const THRESHOLD = 80;

  const getProgressPercent = useCallback(() => {
    if (!progress) return 0;
    if (pub.content_type === 'image' && pub.total_pages > 0) {
      return Math.round(((progress.absolute_segment_index + 1) / pub.total_pages) * 100);
    }
    if (pub.content_type !== 'image' && pub.total_segments > 0) {
      return Math.round((progress.segments_read / pub.total_segments) * 100);
    }
    return 0;
  }, [progress, pub]);

  const format = pub.filename?.split('.').pop()?.toUpperCase() || '';
  const pct = getProgressPercent();

  const resetSwipe = () => {
    setSwipeOffset(0);
    swiping.current = false;
  };

  const onTouchStart = (e: React.TouchEvent) => {
    const touch = e.touches[0];
    startX.current = touch.clientX;
    startY.current = touch.clientY;
    currentX.current = touch.clientX;
    swiping.current = false;
    didLongPress.current = false;

    if (onLongPress) {
      longPressTimer.current = setTimeout(() => {
        didLongPress.current = true;
        const rect = cardRef.current?.getBoundingClientRect();
        if (rect) onLongPress(pub, rect);
      }, 500);
    }
  };

  const onTouchMove = (e: React.TouchEvent) => {
    const touch = e.touches[0];
    const dx = touch.clientX - startX.current;
    const dy = touch.clientY - startY.current;

    // If vertical movement dominates, let the page scroll
    if (!swiping.current && Math.abs(dy) > Math.abs(dx)) {
      clearTimeout(longPressTimer.current);
      return;
    }

    if (Math.abs(dx) > 10) {
      swiping.current = true;
      clearTimeout(longPressTimer.current);
    }

    if (swiping.current && onSwipeAction) {
      // Only allow left swipe
      const offset = Math.min(0, dx);
      const dampened = offset * 0.6;
      currentX.current = touch.clientX;
      setSwipeOffset(dampened);
    }
  };

  const onTouchEnd = () => {
    clearTimeout(longPressTimer.current);

    if (didLongPress.current) {
      resetSwipe();
      return;
    }

    if (swiping.current && onSwipeAction && swipeOffset < -THRESHOLD) {
      onSwipeAction(pub);
    }
    resetSwipe();
  };

  const handleClick = () => {
    if (!swiping.current && !didLongPress.current && !disabled) {
      onTap(pub);
    }
  };

  return (
    <div className="book-card__wrapper" ref={cardRef}>
      {/* Swipe reveal background */}
      {onSwipeAction && (
        <div className={`book-card__swipe-bg book-card__swipe-bg--${swipeColor}`}>
          <span className="book-card__swipe-label">{swipeLabel}</span>
        </div>
      )}

      <div
        className={`book-card${disabled ? ' book-card--disabled' : ''}${pub.cover_url ? ' book-card--has-cover' : ''}`}
        style={{ transform: `translateX(${swipeOffset}px)` }}
        onClick={handleClick}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        role="article"
        aria-label={`${pub.title} by ${pub.author}`}
      >
        {pub.cover_url ? (
          <div className="book-card__cover">
            <img
              src={pub.cover_url}
              alt=""
              className="book-card__cover-img"
              loading="lazy"
              decoding="async"
              onError={() => console.warn('[card] cover img failed to load', { pubId: pub.id, src: pub.cover_url })}
            />
          </div>
        ) : (
          <div className="book-card__spine" />
        )}

        <div className="book-card__content">
          <div className="book-card__header">
            <h3 className="book-card__title">{pub.title}</h3>
            {format && <span className="book-card__format">{format}</span>}
          </div>

          <p className="book-card__author">{pub.author || 'Unknown author'}</p>

          <div className="book-card__footer">
            <span className="book-card__meta">
              {pub.content_type === 'image'
                ? `${pub.total_pages.toLocaleString()} pages`
                : `${pub.total_segments.toLocaleString()} segments`}
            </span>
            {pct > 0 && (
              <span className="book-card__progress-label">{pct}%</span>
            )}
          </div>

          {pct > 0 && (
            <div className="book-card__progress-track">
              <div
                className="book-card__progress-fill"
                style={{ width: `${Math.min(100, pct)}%` }}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

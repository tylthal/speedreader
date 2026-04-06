import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { getImageUrl } from '../api/client';
import { usePageLoader } from '../hooks/usePageLoader';
import { useImageGestures } from '../hooks/useImageGestures';
import { useProgressSaver } from '../hooks/useProgressSaver';
import { useWakeLock } from '../hooks/useWakeLock';
import type { Chapter } from '../api/client';

interface ImageReaderProps {
  publicationId: number;
  chapters: Chapter[];
  initialChapterIdx: number;
  initialPageIndex: number;
}

type FitMode = 'width' | 'height' | 'contain';

export default function ImageReader({
  publicationId,
  chapters,
  initialChapterIdx,
  initialPageIndex,
}: ImageReaderProps) {
  const [chapterIdx, setChapterIdx] = useState(initialChapterIdx);
  const [currentPage, setCurrentPage] = useState(initialPageIndex);
  const [fitMode, setFitMode] = useState<FitMode>('width');
  const [zoom, setZoom] = useState(1);
  const [controlsOpen, setControlsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  const currentChapter = chapters[chapterIdx];
  const currentChapterId = currentChapter?.id ?? 0;

  const [pageState, pageActions] = usePageLoader(publicationId, currentChapterId);

  // Reset page on chapter change
  const prevChapterId = useRef(currentChapterId);
  useEffect(() => {
    if (prevChapterId.current !== currentChapterId) {
      prevChapterId.current = currentChapterId;
      setCurrentPage(0);
    }
  }, [currentChapterId]);

  const handleNextPage = useCallback(() => {
    if (currentPage < pageState.totalPages - 1) {
      setCurrentPage((p) => p + 1);
      pageActions.goToPage(currentPage + 1);
    } else if (chapterIdx < chapters.length - 1) {
      setChapterIdx((i) => i + 1);
      setCurrentPage(0);
    }
  }, [currentPage, pageState.totalPages, chapterIdx, chapters.length, pageActions]);

  const handlePrevPage = useCallback(() => {
    if (currentPage > 0) {
      setCurrentPage((p) => p - 1);
      pageActions.goToPage(currentPage - 1);
    } else if (chapterIdx > 0) {
      setChapterIdx((i) => i - 1);
      // Will be set to last page of prev chapter when pages load
    }
  }, [currentPage, chapterIdx, pageActions]);

  const handleZoomChange = useCallback((newZoom: number) => {
    setZoom(newZoom);
  }, []);

  useImageGestures({
    onNextPage: handleNextPage,
    onPrevPage: handlePrevPage,
    onZoomChange: handleZoomChange,
    containerRef,
  });

  // Preload on page change
  useEffect(() => {
    pageActions.goToPage(currentPage);
  }, [currentPage, pageActions]);

  // Progress saver — overload segment_index as page_index
  useProgressSaver({
    publicationId,
    chapterId: currentChapterId,
    segmentIndex: currentPage,
    wordIndex: 0,
    wpm: 0,
    readingMode: 'image',
    enabled: true,
  });

  useWakeLock(true);

  const currentPageData = pageState.pages.find((p) => p.page_index === currentPage);
  const imageUrl = currentPageData ? getImageUrl(currentPageData.image_path) : null;

  const fitClass =
    fitMode === 'width' ? 'image-page-viewer--fit-width'
    : fitMode === 'height' ? 'image-page-viewer--fit-height'
    : 'image-page-viewer--fit-contain';

  const cycleFitMode = useCallback(() => {
    setFitMode((m) => m === 'width' ? 'height' : m === 'height' ? 'contain' : 'width');
  }, []);

  if (pageState.isLoading && pageState.pages.length === 0) {
    return <div className="reader-viewport__loading">Loading pages...</div>;
  }

  if (pageState.error) {
    return <div className="reader-viewport__error">{pageState.error}</div>;
  }

  return (
    <div className="reader-viewport image-reader" role="main" aria-label="Comic reader" id="main-content">
      {/* Image display area */}
      <div
        ref={containerRef}
        className={`image-page-viewer ${fitClass}`}
        onClick={() => setControlsOpen((o) => !o)}
      >
        {imageUrl ? (
          <img
            className="image-page-viewer__img"
            src={imageUrl}
            alt={`Page ${currentPage + 1}`}
            draggable={false}
          />
        ) : (
          <div className="image-page-viewer__empty">No page available</div>
        )}
      </div>

      {/* Page indicator */}
      <div className="image-controls__page-indicator">
        {currentPage + 1} / {pageState.totalPages}
      </div>

      {/* Controls overlay */}
      <div className={`image-controls ${controlsOpen ? 'image-controls--open' : ''}`}>
        {/* Chapter nav */}
        <div className="image-controls__chapter-row">
          <button
            className="image-controls__nav-btn"
            onClick={() => { setChapterIdx((i) => Math.max(0, i - 1)); setCurrentPage(0); }}
            disabled={chapterIdx === 0}
            aria-label="Previous chapter"
          >
            ‹
          </button>
          <span className="image-controls__chapter-title">
            {currentChapter?.title ?? 'Untitled'}
          </span>
          <button
            className="image-controls__nav-btn"
            onClick={() => { setChapterIdx((i) => Math.min(chapters.length - 1, i + 1)); setCurrentPage(0); }}
            disabled={chapterIdx >= chapters.length - 1}
            aria-label="Next chapter"
          >
            ›
          </button>
        </div>

        {/* Page slider */}
        <div className="image-controls__slider-row">
          <button
            className="image-controls__nav-btn"
            onClick={handlePrevPage}
            disabled={currentPage === 0 && chapterIdx === 0}
            aria-label="Previous page"
          >
            ‹
          </button>
          <input
            type="range"
            className="image-controls__page-slider"
            min={0}
            max={Math.max(0, pageState.totalPages - 1)}
            value={currentPage}
            onChange={(e) => {
              const idx = parseInt(e.target.value, 10);
              setCurrentPage(idx);
              pageActions.goToPage(idx);
            }}
            aria-label="Page slider"
          />
          <button
            className="image-controls__nav-btn"
            onClick={handleNextPage}
            disabled={currentPage >= pageState.totalPages - 1 && chapterIdx >= chapters.length - 1}
            aria-label="Next page"
          >
            ›
          </button>
        </div>

        {/* Actions */}
        <div className="image-controls__actions-row">
          <button className="image-controls__action-btn" onClick={cycleFitMode} aria-label="Change fit mode">
            {fitMode === 'width' ? 'Fit W' : fitMode === 'height' ? 'Fit H' : 'Fit All'}
          </button>
          <button
            className="image-controls__action-btn"
            onClick={() => handleZoomChange(zoom > 1 ? 1 : 2)}
            aria-label={zoom > 1 ? 'Reset zoom' : 'Zoom in'}
          >
            {zoom > 1 ? 'Reset' : 'Zoom 2x'}
          </button>
          <button className="image-controls__action-btn image-controls__exit-btn" onClick={() => navigate('/')} aria-label="Exit reader">
            Exit
          </button>
        </div>
      </div>
    </div>
  );
}

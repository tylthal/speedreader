import { useState, useEffect, useCallback, useRef } from 'react';
import { getImagePages, getImageUrl } from '../api/client';
import type { ImagePage } from '../api/client';

interface PageLoaderState {
  pages: ImagePage[];
  totalPages: number;
  isLoading: boolean;
  error: string | null;
}

interface PageLoaderActions {
  goToPage: (pageIndex: number) => void;
  refresh: () => void;
}

export function usePageLoader(
  publicationId: number,
  chapterId: number,
): [PageLoaderState, PageLoaderActions] {
  const [state, setState] = useState<PageLoaderState>({
    pages: [],
    totalPages: 0,
    isLoading: true,
    error: null,
  });
  const preloadedRef = useRef<Set<string>>(new Set());

  const loadPages = useCallback(async () => {
    if (!chapterId) return;
    setState((s) => ({ ...s, isLoading: true, error: null }));
    try {
      // Load all pages for the chapter (comics typically have <200 pages per chapter)
      const batch = await getImagePages(publicationId, chapterId, 0, 9999);
      setState({
        pages: batch.pages,
        totalPages: batch.total_pages,
        isLoading: false,
        error: null,
      });

      // Preload first few images
      batch.pages.slice(0, 3).forEach((page) => {
        const url = getImageUrl(page.image_path);
        if (!preloadedRef.current.has(url)) {
          const img = new Image();
          img.src = url;
          preloadedRef.current.add(url);
        }
      });
    } catch (err) {
      setState((s) => ({
        ...s,
        isLoading: false,
        error: err instanceof Error ? err.message : 'Failed to load pages',
      }));
    }
  }, [publicationId, chapterId]);

  useEffect(() => {
    preloadedRef.current.clear();
    loadPages();
  }, [loadPages]);

  const goToPage = useCallback(
    (pageIndex: number) => {
      // Preload adjacent pages
      const pagesToPreload = [pageIndex - 1, pageIndex, pageIndex + 1, pageIndex + 2];
      for (const idx of pagesToPreload) {
        const page = state.pages.find((p) => p.page_index === idx);
        if (page) {
          const url = getImageUrl(page.image_path);
          if (!preloadedRef.current.has(url)) {
            const img = new Image();
            img.src = url;
            preloadedRef.current.add(url);
          }
        }
      }
    },
    [state.pages],
  );

  return [state, { goToPage, refresh: loadPages }];
}

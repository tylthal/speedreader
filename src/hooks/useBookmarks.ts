import { useState, useEffect, useCallback } from 'react';
import {
  getBookmarks,
  createBookmark,
  deleteBookmark,
  type Bookmark,
} from '../api/client';

export function useBookmarks(publicationId: number) {
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    getBookmarks(publicationId)
      .then((data) => {
        if (!cancelled) setBookmarks(data);
      })
      .catch(() => {
        // silently fail – bookmarks are non-critical
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [publicationId]);

  const addBookmark = useCallback(
    async (chapterId: number, segmentIndex: number, note?: string) => {
      const bookmark = await createBookmark(publicationId, {
        chapter_id: chapterId,
        segment_index: segmentIndex,
        note,
      });
      setBookmarks((prev) => [bookmark, ...prev]);
      return bookmark;
    },
    [publicationId],
  );

  const removeBookmark = useCallback(async (bookmarkId: number) => {
    await deleteBookmark(bookmarkId);
    setBookmarks((prev) => prev.filter((b) => b.id !== bookmarkId));
  }, []);

  const isBookmarked = useCallback(
    (chapterId: number, segmentIndex: number) => {
      return bookmarks.some(
        (b) => b.chapter_id === chapterId && b.segment_index === segmentIndex,
      );
    },
    [bookmarks],
  );

  return { bookmarks, addBookmark, removeBookmark, isBookmarked, isLoading };
}

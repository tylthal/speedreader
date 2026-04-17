import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import type { Publication, Bookmark } from '../db/localClient';
import { getPref, setPref } from '../lib/uiPrefs';

export type LibrarySort = 'recent' | 'title' | 'author';
const SORTS: readonly LibrarySort[] = ['recent', 'title', 'author'];

function readInitialSort(): LibrarySort {
  const raw = getPref('librarySort');
  return SORTS.includes(raw as LibrarySort) ? (raw as LibrarySort) : 'recent';
}

function applySort(
  pubs: Publication[],
  progressByPublication: Record<number, Bookmark>,
  sort: LibrarySort,
): Publication[] {
  const out = [...pubs];
  if (sort === 'recent') {
    out.sort((a, b) => {
      const pa = progressByPublication[a.id];
      const pb = progressByPublication[b.id];
      if (pa && pb) return new Date(pb.updated_at).getTime() - new Date(pa.updated_at).getTime();
      if (pa) return -1;
      if (pb) return 1;
      return b.id - a.id;
    });
  } else if (sort === 'title') {
    out.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  } else if (sort === 'author') {
    out.sort((a, b) => (a.author || '').localeCompare(b.author || ''));
  }
  return out;
}

function matches(pub: Publication, q: string): boolean {
  if (!q) return true;
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  const title = (pub.title || '').toLowerCase();
  const author = (pub.author || '').toLowerCase();
  return title.includes(needle) || author.includes(needle);
}

export function useLibrarySearch(
  publications: Publication[],
  progressMap: Record<number, Bookmark>,
): {
  query: string;
  setQuery: (q: string) => void;
  sort: LibrarySort;
  setSort: (s: LibrarySort) => void;
  filtered: Publication[];
  isSearching: boolean;
  resultCount: number;
} {
  const [query, setQuery] = useState('');
  const [sort, setSortState] = useState<LibrarySort>(readInitialSort);
  const deferredQuery = useDeferredValue(query);

  useEffect(() => {
    setPref('librarySort', sort);
  }, [sort]);

  const filtered = useMemo(() => {
    const sorted = applySort(publications, progressMap, sort);
    if (!deferredQuery.trim()) return sorted;
    return sorted.filter((p) => matches(p, deferredQuery));
  }, [publications, progressMap, sort, deferredQuery]);

  return {
    query,
    setQuery,
    sort,
    setSort: setSortState,
    filtered,
    isSearching: deferredQuery.trim().length > 0,
    resultCount: filtered.length,
  };
}

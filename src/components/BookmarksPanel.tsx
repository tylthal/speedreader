import { memo, useState, useRef, useEffect, useCallback } from 'react'
import type { Bookmark } from '../api/types'
import { useBookmarkSelector, bookmarkStore } from '../state/bookmarkStore'

interface BookmarksPanelProps {
  open: boolean
  chapters: { id: number; title: string }[]
  onJump: (position: {
    chapterId: number
    chapterIdx: number
    absoluteSegmentIndex: number
    wordIndex: number
  }) => void
  onClose: () => void
}

function BookmarksPanel({ open, chapters, onJump, onClose }: BookmarksPanelProps) {
  const lastOpened = useBookmarkSelector((s) => s.lastOpened)
  const farthestRead = useBookmarkSelector((s) => s.farthestRead)
  const bookmarks = useBookmarkSelector((s) => s.bookmarks)

  const handleJump = useCallback(
    (b: Bookmark) => {
      onJump({
        chapterId: b.chapter_id,
        chapterIdx: b.chapter_idx,
        absoluteSegmentIndex: b.absolute_segment_index,
        wordIndex: b.word_index,
      })
      onClose()
    },
    [onJump, onClose],
  )

  return (
    <div
      className={`bookmarks-panel${open ? ' bookmarks-panel--open' : ' bookmarks-panel--closed'}`}
      role={open ? 'dialog' : undefined}
      aria-modal={open ? 'true' : undefined}
      aria-hidden={open ? undefined : 'true'}
      aria-label="Bookmarks"
    >
      <div className="bookmarks-panel__backdrop" onClick={onClose} />
      <aside className="bookmarks-panel__panel">
        <header className="bookmarks-panel__header">
          <h2 className="bookmarks-panel__title">Bookmarks</h2>
          <button
            className="bookmarks-panel__close"
            onClick={onClose}
            aria-label="Close bookmarks"
          >
            &#x2715;
          </button>
        </header>

        <div className="bookmarks-panel__content">
          {/* Auto bookmarks section */}
          <div className="bookmarks-panel__auto-section">
            <span className="bookmarks-panel__section-label">Auto</span>
            <AutoBookmarkRow
              label="Last Opened"
              bookmark={lastOpened}
              chapters={chapters}
              onJump={handleJump}
            />
            <AutoBookmarkRow
              label="Farthest Read"
              bookmark={farthestRead}
              chapters={chapters}
              onJump={handleJump}
            />
          </div>

          <div className="bookmarks-panel__divider" />

          {/* User bookmarks section */}
          <div className="bookmarks-panel__user-section">
            {bookmarks.length === 0 ? (
              <div className="bookmarks-panel__empty">
                <p>No bookmarks yet.</p>
                <p className="bookmarks-panel__empty-hint">
                  Long-press on text while paused to create one.
                </p>
              </div>
            ) : (
              bookmarks.map((b) => (
                <UserBookmarkRow
                  key={b.id}
                  bookmark={b}
                  chapters={chapters}
                  onJump={handleJump}
                />
              ))
            )}
          </div>
        </div>
      </aside>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Auto bookmark row
// ---------------------------------------------------------------------------

function AutoBookmarkRow({
  label,
  bookmark,
  chapters,
  onJump,
}: {
  label: string
  bookmark: Bookmark | null
  chapters: { id: number; title: string }[]
  onJump: (b: Bookmark) => void
}) {
  const chapterTitle = bookmark
    ? chapters.find((c) => c.id === bookmark.chapter_id)?.title ?? ''
    : ''

  return (
    <button
      className="bookmarks-panel__auto-row"
      disabled={!bookmark}
      onClick={() => bookmark && onJump(bookmark)}
      aria-label={`${label}${chapterTitle ? `: ${chapterTitle}` : ''}`}
    >
      <span className="bookmarks-panel__auto-icon">
        {label === 'Last Opened' ? '\u{1F4D6}' : '\u{1F3C1}'}
      </span>
      <span className="bookmarks-panel__auto-info">
        <span className="bookmarks-panel__auto-label">{label}</span>
        {chapterTitle && (
          <span className="bookmarks-panel__auto-chapter">{chapterTitle}</span>
        )}
      </span>
    </button>
  )
}

// ---------------------------------------------------------------------------
// User bookmark row
// ---------------------------------------------------------------------------

function UserBookmarkRow({
  bookmark,
  chapters,
  onJump,
}: {
  bookmark: Bookmark
  chapters: { id: number; title: string }[]
  onJump: (b: Bookmark) => void
}) {
  const [editing, setEditing] = useState(false)
  const [editName, setEditName] = useState(bookmark.name ?? '')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  const commitRename = useCallback(() => {
    const trimmed = editName.trim()
    if (trimmed && trimmed !== bookmark.name) {
      bookmarkStore.renameBookmark(bookmark.id, trimmed)
    }
    setEditing(false)
  }, [editName, bookmark.id, bookmark.name])

  const handleDelete = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      bookmarkStore.removeBookmark(bookmark.id)
    },
    [bookmark.id],
  )

  const chapterTitle = chapters.find((c) => c.id === bookmark.chapter_id)?.title ?? ''

  return (
    <div className="bookmarks-panel__user-row" onClick={() => onJump(bookmark)}>
      <div className="bookmarks-panel__user-info">
        {editing ? (
          <input
            ref={inputRef}
            className="bookmarks-panel__rename-input"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename()
              if (e.key === 'Escape') setEditing(false)
            }}
            onClick={(e) => e.stopPropagation()}
            maxLength={100}
          />
        ) : (
          <span
            className="bookmarks-panel__user-name"
            onDoubleClick={(e) => {
              e.stopPropagation()
              setEditName(bookmark.name ?? '')
              setEditing(true)
            }}
            title="Double-click to rename"
          >
            {bookmark.name ?? 'Untitled'}
          </span>
        )}
        {chapterTitle && (
          <span className="bookmarks-panel__user-chapter">{chapterTitle}</span>
        )}
        {bookmark.snippet && (
          <span className="bookmarks-panel__user-snippet">{bookmark.snippet}</span>
        )}
      </div>
      <button
        className="bookmarks-panel__delete-btn"
        onClick={handleDelete}
        aria-label={`Delete bookmark: ${bookmark.name}`}
      >
        &#x2715;
      </button>
    </div>
  )
}

const MemoizedBookmarksPanel = memo(BookmarksPanel)
MemoizedBookmarksPanel.displayName = 'BookmarksPanel'
export default MemoizedBookmarksPanel

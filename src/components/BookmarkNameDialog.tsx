import { useEffect, useRef, useState } from 'react'

interface BookmarkNameDialogProps {
  defaultName: string
  onConfirm: (name: string) => void
  onCancel: () => void
}

/**
 * Modal dialog prompting the user to name a new bookmark.
 * Auto-focuses the input with the default name pre-selected.
 */
export default function BookmarkNameDialog({
  defaultName,
  onConfirm,
  onCancel,
}: BookmarkNameDialogProps) {
  const [name, setName] = useState(defaultName)
  const inputRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)

  // Auto-focus and select all text on mount
  useEffect(() => {
    requestAnimationFrame(() => {
      const input = inputRef.current
      if (input) {
        input.focus()
        input.select()
      }
      dialogRef.current?.classList.add('bookmark-dialog--visible')
    })
  }, [])

  // Escape to cancel
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [onCancel])

  const handleSubmit = () => {
    const trimmed = name.trim()
    onConfirm(trimmed || defaultName)
  }

  return (
    <div className="bookmark-dialog__overlay" onClick={onCancel}>
      <div
        ref={dialogRef}
        className="bookmark-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Name this bookmark"
      >
        <h3 className="bookmark-dialog__title">Name this bookmark</h3>
        <input
          ref={inputRef}
          className="bookmark-dialog__input"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSubmit()
          }}
          maxLength={100}
          aria-label="Bookmark name"
        />
        <div className="bookmark-dialog__actions">
          <button
            className="bookmark-dialog__btn bookmark-dialog__btn--cancel"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            className="bookmark-dialog__btn bookmark-dialog__btn--save"
            onClick={handleSubmit}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

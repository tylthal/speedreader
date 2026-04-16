import { useEffect, useRef, useState } from 'react'
import BasePanel from './BasePanel'

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

  // Auto-focus and select all text on mount
  useEffect(() => {
    requestAnimationFrame(() => {
      const input = inputRef.current
      if (input) {
        input.focus()
        input.select()
      }
    })
  }, [])

  const handleSubmit = () => {
    const trimmed = name.trim()
    onConfirm(trimmed || defaultName)
  }

  return (
    <BasePanel
      onClose={onCancel}
      visibleClass="bookmark-dialog--visible"
      overlayClassName="bookmark-dialog__overlay"
      className="bookmark-dialog"
      ariaLabel="Name this bookmark"
      ariaModal
      animateBackdropClose={false}
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
    </BasePanel>
  )
}

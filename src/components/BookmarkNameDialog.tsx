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

  // Auto-focus and select all text after the enter animation settles —
  // iOS Safari jumps the entire layout to center the focused input on
  // first paint when the software keyboard opens; delaying the focus
  // until the dialog has positioned avoids that collision.
  useEffect(() => {
    const timer = setTimeout(() => {
      const input = inputRef.current
      if (input) {
        input.focus()
        input.select()
      }
    }, 220)
    return () => clearTimeout(timer)
  }, [])

  // Mirror the software-keyboard height into a CSS var so the dialog
  // can lift above it (visualViewport shrinks when the keyboard opens
  // on iOS / Android; window.innerHeight does not).
  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : undefined
    if (!vv) return
    const update = () => {
      const keyboard = Math.max(0, window.innerHeight - vv.height - vv.offsetTop)
      document.documentElement.style.setProperty('--keyboard-height', `${Math.round(keyboard)}px`)
    }
    update()
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
      document.documentElement.style.removeProperty('--keyboard-height')
    }
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

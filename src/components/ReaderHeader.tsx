import type { DisplayMode } from '../api/client'

interface ReaderHeaderProps {
  bookTitle: string
  sectionTitle: string
  displayMode: DisplayMode
  onToggleDisplayMode?: () => void
  onOpenToc: () => void
  onExit: () => void
  /** Hide the display-mode toggle entirely (e.g. for CBZ — PRD §4.5). */
  hideDisplayToggle?: boolean
  /** True when displayMode is set but the active reading mode forces plain. */
  formattedSuppressed?: boolean
}

/**
 * Persistent reader header (PRD §6.2 / §9.2).
 *
 * Houses the back button, the book title, a "now reading" section subtitle,
 * the TOC button, and the Plain↔Formatted display-mode toggle.
 */
export default function ReaderHeader({
  bookTitle,
  sectionTitle,
  displayMode,
  onToggleDisplayMode,
  onOpenToc,
  onExit,
  hideDisplayToggle,
  formattedSuppressed = false,
}: ReaderHeaderProps) {
  const toggleEnabled = !hideDisplayToggle && Boolean(onToggleDisplayMode)
  return (
    <header className="reader-header" role="banner">
      <button
        className="reader-header__btn reader-header__back"
        onClick={onExit}
        aria-label="Exit book"
      >
        &#x2190;
      </button>

      <div className="reader-header__titles">
        <span className="reader-header__book" title={bookTitle}>
          {bookTitle}
        </span>
        <span className="reader-header__section" title={sectionTitle}>
          {sectionTitle || 'Untitled'}
        </span>
      </div>

      {!hideDisplayToggle && (
        <button
          className={`reader-header__btn reader-header__toggle${displayMode === 'formatted' ? ' reader-header__toggle--formatted' : ''}${formattedSuppressed ? ' reader-header__toggle--suppressed' : ''}`}
          onClick={toggleEnabled ? onToggleDisplayMode : undefined}
          disabled={!toggleEnabled}
          aria-label={`Display mode: ${displayMode === 'formatted' ? 'Formatted' : 'Plain text'}${formattedSuppressed ? ' (forced plain in this reading mode)' : ''}`}
          aria-pressed={displayMode === 'formatted'}
          title={
            formattedSuppressed
              ? 'Switch to Scroll or Track mode to see the formatted view'
              : toggleEnabled
              ? `Switch to ${displayMode === 'formatted' ? 'plain text' : 'formatted'}`
              : 'Formatted view coming soon'
          }
        >
          {displayMode === 'formatted' ? 'Aa' : 'A'}
        </button>
      )}

      <button
        className="reader-header__btn reader-header__toc"
        onClick={onOpenToc}
        aria-label="Open table of contents"
      >
        &#x2630;
      </button>
    </header>
  )
}

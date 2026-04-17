import { useEffect, useState } from 'react'
import { useServiceWorkerUpdate } from '../hooks/useServiceWorkerUpdate'

const AUTO_HIDE_MS = 10_000

export default function UpdateToast() {
  const { updateAvailable, applyUpdate } = useServiceWorkerUpdate()
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    if (!updateAvailable || dismissed) return
    const timer = setTimeout(() => setDismissed(true), AUTO_HIDE_MS)
    return () => clearTimeout(timer)
  }, [updateAvailable, dismissed])

  if (!updateAvailable || dismissed) return null

  return (
    <div className="update-toast" role="status" aria-live="polite">
      <span className="update-toast__message">A new version is available</span>
      <div className="update-toast__actions">
        <button
          className="update-toast__button"
          type="button"
          onClick={applyUpdate}
        >
          Update
        </button>
        <button
          className="update-toast__close"
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss update toast"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="3" y1="3" x2="11" y2="11" />
            <line x1="11" y1="3" x2="3" y2="11" />
          </svg>
        </button>
      </div>
    </div>
  )
}

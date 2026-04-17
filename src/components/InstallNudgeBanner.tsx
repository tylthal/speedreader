import { useInstallPrompt } from '../hooks/useInstallPrompt'
import { useBodyClass } from '../hooks/useBodyClass'

function IosShareIcon() {
  return (
    <svg
      className="install-banner__share-svg"
      width="14"
      height="18"
      viewBox="0 0 14 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M7 1.5 V11" />
      <path d="M3.5 5 L7 1.5 L10.5 5" />
      <path d="M2.5 8 H2 a1.5 1.5 0 0 0 -1.5 1.5 v6 A1.5 1.5 0 0 0 2 17 h10 a1.5 1.5 0 0 0 1.5 -1.5 v-6 A1.5 1.5 0 0 0 12 8 h-0.5" />
    </svg>
  )
}

export default function InstallNudgeBanner() {
  const { canInstall, isInstalled, isDismissed, platform, install, dismiss } =
    useInstallPrompt()

  const visible = canInstall && !isInstalled && !isDismissed
  useBodyClass('has-install-banner', visible)

  if (!visible) return null

  if (platform === 'ios') {
    return (
      <div className="install-banner" role="banner">
        <div className="install-banner__content">
          <div className="install-banner__text">
            <strong>Install SpeedReader:</strong>
            <span className="install-banner__ios-steps">
              {' '}tap the Share button{' '}
              <span className="install-banner__share-icon" aria-label="Share">
                <IosShareIcon />
              </span>
              {' '}then &ldquo;Add to Home Screen&rdquo;
            </span>
          </div>
          <button
            className="install-banner__action"
            onClick={dismiss}
            type="button"
          >
            Got it
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="install-banner" role="banner">
      <div className="install-banner__content">
        <span className="install-banner__text">
          Install SpeedReader for the best experience
        </span>
        <button
          className="install-banner__action"
          onClick={install}
          type="button"
        >
          Install
        </button>
        <button
          className="install-banner__dismiss"
          onClick={dismiss}
          type="button"
          aria-label="Dismiss install banner"
        >
          &#x2715;
        </button>
      </div>
    </div>
  )
}

import { useInstallPrompt } from '../hooks/useInstallPrompt'

export default function InstallNudgeBanner() {
  const { canInstall, isInstalled, isDismissed, platform, install, dismiss } =
    useInstallPrompt()

  if (!canInstall || isInstalled || isDismissed) return null

  if (platform === 'ios') {
    return (
      <div className="install-banner" role="banner">
        <div className="install-banner__content">
          <div className="install-banner__text">
            <strong>Install SpeedReader:</strong>
            <span className="install-banner__ios-steps">
              {' '}tap the Share button{' '}
              <span className="install-banner__share-icon" aria-label="Share icon">
                &#x2B06;&#xFE0E;
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

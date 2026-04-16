import { Routes, Route, useLocation } from 'react-router-dom'
import LibraryPage from './pages/LibraryPage'
import ArchivePage from './pages/ArchivePage'
import SettingsPage from './pages/SettingsPage'
import ReaderPage from './pages/ReaderPage'
import BottomNav from './components/BottomNav'
import OfflineStatusToast from './components/OfflineStatusToast'
import UpdateToast from './components/UpdateToast'
import InstallNudgeBanner from './components/InstallNudgeBanner'
import PerfOverlay from './components/PerfOverlay'
import { A11yAnnouncerProvider } from './components/A11yAnnouncer'
import { useTheme } from './hooks/useTheme'
import { isNative } from './lib/platform'

/** Pages where the bottom nav should be shown */
const NAV_PATHS = ['/', '/archive', '/settings']

export default function App() {
  useTheme();
  const location = useLocation();
  const showNav = NAV_PATHS.includes(location.pathname);
  // Web-only UI: no service worker to update on native; install banner
  // makes no sense inside an App Store / Play Store build; and the
  // offline-status toast is meaningless when the app is packaged natively.
  const showWebOnlyUi = !isNative();

  return (
    <A11yAnnouncerProvider>
      <a href="#main-content" className="skip-link">Skip to content</a>
      {showWebOnlyUi && (
        <>
          <OfflineStatusToast />
          <UpdateToast />
          <InstallNudgeBanner />
        </>
      )}
      <PerfOverlay />
      <div className={`app-shell${showNav ? ' app-shell--with-nav' : ''}`}>
        <Routes>
          <Route path="/" element={<LibraryPage />} />
          <Route path="/archive" element={<ArchivePage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/read/:pubId" element={<ReaderPage />} />
        </Routes>
      </div>
      {showNav && <BottomNav />}
    </A11yAnnouncerProvider>
  )
}

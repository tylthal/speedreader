import { lazy, Suspense } from 'react'
import { Routes, Route, useLocation } from 'react-router-dom'
import LibraryPage from './pages/LibraryPage'
import ArchivePage from './pages/ArchivePage'
import SettingsPage from './pages/SettingsPage'
import ReaderPage from './pages/ReaderPage'
import BottomNav from './components/BottomNav'
import UpdateToast from './components/UpdateToast'
import InstallNudgeBanner from './components/InstallNudgeBanner'
import { A11yAnnouncerProvider } from './components/A11yAnnouncer'
import { useTheme } from './hooks/useTheme'
import { isNative } from './lib/platform'

// Dev-only perf HUD. The lazy() call is gated by import.meta.env.DEV so the
// bundler constant-folds the entire branch to `null` in production builds and
// tree-shakes the PerfOverlay module (and its web-vitals / long-task / TTFC
// dependencies) out of the bundle entirely. Keeping the dynamic import inside
// the DEV guard is load-bearing — a static import would pin the module into
// the graph regardless of the runtime gate.
const PerfOverlay = import.meta.env.DEV
  ? lazy(() => import('./components/PerfOverlay'))
  : null

/** Pages where the bottom nav should be shown */
const NAV_PATHS = ['/', '/archive', '/settings']

export default function App() {
  useTheme();
  const location = useLocation();
  const showNav = NAV_PATHS.includes(location.pathname);
  // Web-only UI: no service worker to update on native; install banner
  // makes no sense inside an App Store / Play Store build.
  const showWebOnlyUi = !isNative();

  return (
    <A11yAnnouncerProvider>
      <a href="#main-content" className="skip-link">Skip to content</a>
      {showWebOnlyUi && (
        <>
          <UpdateToast />
          <InstallNudgeBanner />
        </>
      )}
      {PerfOverlay && (
        <Suspense fallback={null}>
          <PerfOverlay />
        </Suspense>
      )}
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

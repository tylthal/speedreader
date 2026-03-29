import { Routes, Route } from 'react-router-dom'
import LibraryPage from './pages/LibraryPage'
import ReaderPage from './pages/ReaderPage'
import OfflineStatusToast from './components/OfflineStatusToast'
import InstallNudgeBanner from './components/InstallNudgeBanner'
import PerfOverlay from './components/PerfOverlay'
import ThemeToggle from './components/ThemeToggle'
import { A11yAnnouncerProvider } from './components/A11yAnnouncer'
import { useTheme } from './hooks/useTheme'

export default function App() {
  // Initialize theme on mount (applies data-theme attribute & meta tag)
  useTheme();

  return (
    <A11yAnnouncerProvider>
      <a href="#main-content" className="skip-link">Skip to content</a>
      <OfflineStatusToast />
      <InstallNudgeBanner />
      <PerfOverlay />
      <ThemeToggle />
      <Routes>
        <Route path="/" element={<LibraryPage />} />
        <Route path="/read/:pubId" element={<ReaderPage />} />
      </Routes>
    </A11yAnnouncerProvider>
  )
}

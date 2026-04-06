import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { Capacitor } from '@capacitor/core'
import App from './App'
import { initWebVitals } from './lib/performance'
import { startLongTaskObserver } from './lib/longTaskObserver'
import { initClient } from './api/client'
import './styles/global.css'
import './styles/components.css'

initWebVitals();
startLongTaskObserver();
initClient();

// On native, unregister service workers (native shell handles caching)
if (Capacitor.isNativePlatform() && navigator.serviceWorker) {
  navigator.serviceWorker.getRegistrations().then((regs) =>
    regs.forEach((r) => r.unregister())
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)

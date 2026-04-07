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

// Polyfill ReadableStream async iterator for WebKit browsers (Safari/iOS Chrome).
// pdfjs-dist uses `for await (const x of readableStream)` internally, which
// requires Symbol.asyncIterator on ReadableStream — only added to Safari 17.4+.
if (
  typeof ReadableStream !== 'undefined' &&
  !(ReadableStream.prototype as any)[Symbol.asyncIterator]
) {
  (ReadableStream.prototype as any)[Symbol.asyncIterator] = async function* () {
    const reader = this.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) return
        yield value
      }
    } finally {
      reader.releaseLock()
    }
  }
}

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

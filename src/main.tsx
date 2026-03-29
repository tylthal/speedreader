import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { initWebVitals } from './lib/performance'
import { startLongTaskObserver } from './lib/longTaskObserver'
import './styles/global.css'
import './styles/components.css'

initWebVitals();
startLongTaskObserver();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)

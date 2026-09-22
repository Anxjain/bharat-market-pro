import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import './index.css'
import App from './App'
import { AuthProvider } from './lib/auth'
import { WatchlistProvider } from './lib/watchlist'
import { ToastProvider } from './lib/toast'
import { ThemeProvider } from './lib/theme'
import { ErrorBoundary } from './components/ErrorBoundary'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary scope="app">
      <ThemeProvider>
        <HashRouter>
          <ToastProvider>
            <AuthProvider>
              <WatchlistProvider>
                <App />
              </WatchlistProvider>
            </AuthProvider>
          </ToastProvider>
        </HashRouter>
      </ThemeProvider>
    </ErrorBoundary>
  </StrictMode>,
)

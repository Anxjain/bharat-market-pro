import { Suspense, lazy } from 'react'
import { Routes, Route, useLocation } from 'react-router-dom'
import { Header } from './components/Header'
import { SplashScreen } from './components/SplashScreen'
import { IconRail } from './components/IconRail'
import { Dock } from './components/Dock'
import { ErrorBoundary } from './components/ErrorBoundary'
import { Dashboard } from './pages/Dashboard'
import { Watchlist } from './pages/Watchlist'
import { Companies } from './pages/Companies'
import { Company360 } from './pages/Company360'
import { News } from './pages/News'
import { Filings } from './pages/Filings'
import { RiskMonitor } from './pages/RiskMonitor'

// Heavy routes are code-split so recharts / the ULIP explorer / the guidance desk
// leave the entry bundle and load on demand.
const Insurance = lazy(() => import('./pages/Insurance').then((m) => ({ default: m.Insurance })))
const Chat = lazy(() => import('./pages/Chat').then((m) => ({ default: m.Chat })))
const Reports = lazy(() => import('./pages/Reports').then((m) => ({ default: m.Reports })))
const Guidance = lazy(() => import('./pages/Guidance').then((m) => ({ default: m.Guidance })))
const Portfolio = lazy(() => import('./pages/Portfolio').then((m) => ({ default: m.Portfolio })))

function RouteFallback() {
  return <p className="p-6 text-[13px] italic text-faint">Loading…</p>
}

export default function App() {
  const location = useLocation()

  return (
    // The whole app is one floating window on a gray canvas (full-bleed on mobile)
    <div className="flex h-screen items-stretch p-0 lg:p-4">
      <SplashScreen />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden border-surface/60 bg-panel lg:rounded-[26px] lg:border lg:shadow-[0_24px_80px_rgba(16,24,40,0.18)]">
        <Header />
        <div className="flex min-h-0 flex-1">
          <IconRail />
          {/* No remount key: navigating between params on the same route keeps the tree
              mounted (and the query cache warm). The entrance animation plays on first load. */}
          <main className="page-enter min-w-0 flex-1 overflow-y-auto p-3 lg:p-5">
            {/* Per-route boundary so one page's render crash never white-screens the app,
                and the user keeps the nav to recover. Keyed by path so it resets on nav. */}
            <ErrorBoundary resetKeys={[location.pathname]} scope="page">
              <Suspense fallback={<RouteFallback />}>
                <Routes>
                  <Route path="/" element={<Dashboard />} />
                  <Route path="/watchlist" element={<Watchlist />} />
                  <Route path="/companies" element={<Companies />} />
                  <Route path="/company/:symbol" element={<Company360 />} />
                  <Route path="/insurance" element={<Insurance />} />
                  <Route path="/news" element={<News />} />
                  <Route path="/filings" element={<Filings />} />
                  <Route path="/risk" element={<RiskMonitor />} />
                  <Route path="/chat" element={<Chat />} />
                  <Route path="/reports" element={<Reports />} />
                  {/* PRIVATE owner-only desks; the pages self-gate (server 404s for non-owners). */}
                  <Route path="/guidance" element={<Guidance />} />
                  <Route path="/portfolio" element={<Portfolio />} />
                </Routes>
              </Suspense>
            </ErrorBoundary>
          </main>
        </div>
        <Dock />
      </div>
    </div>
  )
}

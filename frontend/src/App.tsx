import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'

const Dashboard = lazy(() => import('./pages/Dashboard'))
const GlobalMacro = lazy(() => import('./pages/GlobalMacro'))
const StockPrediction = lazy(() => import('./pages/StockPrediction'))

function Sidebar() {
  const links = [
    { to: '/dashboard', label: '대시보드' },
    { to: '/macro', label: '글로벌 매크로' },
    { to: '/stocks', label: '종목 예측' },
  ]

  return (
    <aside className="flex h-full w-64 flex-col border-r border-slate-800 bg-slate-950/80 px-4 py-6 backdrop-blur">
      <div className="mb-8 px-2">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-blue-300">
          AlphaPulse
        </p>
        <h1 className="text-lg font-bold text-white">예측 대시보드</h1>
      </div>
      <nav className="space-y-2">
        {links.map((item) => (
          <a
            key={item.to}
            href={item.to}
            className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800 hover:text-white"
          >
            <span className="h-2 w-2 rounded-full bg-slate-600" />
            {item.label}
          </a>
        ))}
      </nav>
    </aside>
  )
}

function App() {
  return (
    <div className="flex min-h-screen bg-slate-950 text-slate-100">
      <Sidebar />
      <main className="flex-1 bg-gradient-to-b from-slate-950 via-slate-930 to-slate-900">
        <div className="mx-auto max-w-7xl px-6 py-8">
          <Suspense fallback={<div className="text-slate-400">불러오는 중...</div>}>
            <Routes>
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/macro" element={<GlobalMacro />} />
              <Route path="/stocks" element={<StockPrediction />} />
              <Route path="*" element={<Navigate to="/dashboard" replace />} />
            </Routes>
          </Suspense>
        </div>
      </main>
    </div>
  )
}

export default App

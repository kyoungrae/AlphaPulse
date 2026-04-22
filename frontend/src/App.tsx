import type { User } from 'firebase/auth'
import { onAuthStateChanged } from 'firebase/auth'
import { lazy, Suspense, useEffect, useState } from 'react'
import { Link, Navigate, Outlet, Route, Routes, useOutletContext } from 'react-router-dom'
import { UserMenu } from './components/UserMenu'
import { auth } from './firebase'

const Dashboard = lazy(() => import('./pages/Dashboard'))
const GlobalMacro = lazy(() => import('./pages/GlobalMacro'))
const StockPrediction = lazy(() => import('./pages/StockPrediction'))
const Login = lazy(() => import('./pages/Login'))

export type AuthOutletContext = { user: User }

function Sidebar() {
  const links = [
    { to: '/dashboard', label: '대시보드' },
    { to: '/macro', label: '글로벌 매크로' },
    { to: '/stocks', label: '종목 실시간 현황' },
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
          <Link
            key={item.to}
            to={item.to}
            className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800 hover:text-white"
          >
            <span className="h-2 w-2 rounded-full bg-slate-600" />
            {item.label}
          </Link>
        ))}
      </nav>
    </aside>
  )
}

function MainShell() {
  const { user } = useOutletContext<AuthOutletContext>()

  return (
    <div className="flex min-h-screen bg-slate-950 text-slate-100">
      <Sidebar />
      <div className="flex min-h-screen flex-1 flex-col bg-gradient-to-b from-slate-950 via-slate-930 to-slate-900">
        <header className="flex shrink-0 items-center justify-end gap-3 border-b border-slate-800/80 bg-slate-950/60 px-6 py-3 backdrop-blur">
          <UserMenu user={user} />
        </header>
        <main className="flex-1 overflow-auto">
          <div className="mx-auto max-w-7xl px-6 py-8">
            <Suspense fallback={<div className="text-slate-400">불러오는 중...</div>}>
              <Outlet />
            </Suspense>
          </div>
        </main>
      </div>
    </div>
  )
}

function ProtectedRoute() {
  const [user, setUser] = useState<User | null | undefined>(undefined)

  useEffect(() => onAuthStateChanged(auth, setUser), [])

  if (user === undefined) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950 text-slate-400">
        불러오는 중...
      </div>
    )
  }

  if (!user) {
    return <Navigate to="/login" replace />
  }

  return <Outlet context={{ user } satisfies AuthOutletContext} />
}

function App() {
  return (
    <Routes>
      <Route
        path="/login"
        element={
          <Suspense
            fallback={
              <div className="flex min-h-screen items-center justify-center bg-slate-950 text-slate-400">
                불러오는 중...
              </div>
            }
          >
            <Login />
          </Suspense>
        }
      />
      <Route element={<ProtectedRoute />}>
        <Route element={<MainShell />}>
          <Route path="dashboard" element={<Dashboard />} />
          <Route path="macro" element={<GlobalMacro />} />
          <Route path="stocks" element={<StockPrediction />} />
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Route>
      </Route>
    </Routes>
  )
}

export default App

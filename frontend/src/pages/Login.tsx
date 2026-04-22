import { FirebaseError } from 'firebase/app'
import {
  GoogleAuthProvider,
  getRedirectResult,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
} from 'firebase/auth'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { auth } from '../firebase'

const googleProvider = new GoogleAuthProvider()
googleProvider.setCustomParameters({ prompt: 'select_account' })

function GoogleGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden>
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  )
}

function authErrorMessage(err: unknown): string {
  if (err instanceof FirebaseError) {
    switch (err.code) {
      case 'auth/invalid-email':
        return '이메일 형식이 올바르지 않습니다.'
      case 'auth/user-disabled':
        return '비활성화된 계정입니다. 관리자에게 문의하세요.'
      case 'auth/user-not-found':
      case 'auth/wrong-password':
      case 'auth/invalid-credential':
        return '이메일 또는 비밀번호가 일치하지 않습니다.'
      case 'auth/too-many-requests':
        return '시도 횟수가 많습니다. 잠시 후 다시 시도하세요.'
      case 'auth/network-request-failed':
        return '네트워크 오류입니다. 연결을 확인하세요.'
      case 'auth/popup-closed-by-user':
        return '로그인 창이 닫혔습니다.'
      case 'auth/popup-blocked':
        return '팝업이 차단되었습니다. 브라우저에서 팝업을 허용해 주세요.'
      case 'auth/cancelled-popup-request':
        return '다른 로그인 창이 이미 열려 있습니다.'
      case 'auth/account-exists-with-different-credential':
        return '이 이메일은 다른 로그인 방식으로 이미 등록되어 있습니다.'
      case 'auth/unauthorized-domain':
        return '이 주소는 Firebase에 등록되지 않았습니다. Firebase Console → Authentication → Settings → Authorized domains에 현재 도메인(예: 127.0.0.1, localhost)을 추가하거나, 브라우저 주소를 localhost로 맞춰 보세요.'
      case 'auth/operation-not-allowed':
        return 'Google 로그인이 비활성화되어 있습니다. Firebase Console → Authentication → Sign-in method에서 Google을 사용하도록 설정하세요.'
      case 'auth/web-storage-unsupported':
        return '이 브라우저에서는 저장소를 사용할 수 없어 로그인할 수 없습니다. 쿠키·저장소 차단을 해제하거나 다른 브라우저를 이용하세요.'
      case 'auth/configuration-not-found':
        return 'Firebase Authentication이 이 프로젝트에서 아직 켜지지 않았거나 설정이 없습니다. Firebase Console → 빌드 → Authentication에서 「시작하기」로 서비스를 활성화하고, 사용할 로그인 방식(이메일·Google 등)을 켠 뒤 다시 시도하세요. Google Cloud에서 Identity Toolkit API가 꺼져 있으면 콘솔에서 API 사용 설정도 확인하세요.'
      default:
        if (import.meta.env.DEV && err instanceof FirebaseError) {
          return `로그인에 실패했습니다. (${err.code})`
        }
        return '로그인에 실패했습니다. 잠시 후 다시 시도하세요.'
    }
  }
  return '알 수 없는 오류가 발생했습니다.'
}

export default function Login() {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [googleSubmitting, setGoogleSubmitting] = useState(false)
  const [authReady, setAuthReady] = useState(false)
  const busy = submitting || googleSubmitting

  useEffect(() => {
    let cancelled = false
    getRedirectResult(auth)
      .then(() => {
        /* 성공 시 사용자는 onAuthStateChanged에서 처리 */
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(authErrorMessage(err))
      })

    const unsub = onAuthStateChanged(auth, (user) => {
      if (!cancelled) setAuthReady(true)
      if (user) navigate('/dashboard', { replace: true })
    })
    return () => {
      cancelled = true
      unsub()
    }
  }, [navigate])

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    const trimmed = email.trim()
    if (!trimmed || !password) {
      setError('이메일과 비밀번호를 입력하세요.')
      return
    }
    setSubmitting(true)
    try {
      await signInWithEmailAndPassword(auth, trimmed, password)
      navigate('/dashboard', { replace: true })
    } catch (err) {
      setError(authErrorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  const onGoogleSignIn = async () => {
    setError(null)
    setGoogleSubmitting(true)
    try {
      await signInWithPopup(auth, googleProvider)
      navigate('/dashboard', { replace: true })
    } catch (err) {
      const useRedirectFallback =
        err instanceof FirebaseError &&
        (err.code === 'auth/popup-blocked' || err.code === 'auth/cancelled-popup-request')
      if (useRedirectFallback) {
        try {
          await signInWithRedirect(auth, googleProvider)
          return
        } catch (redirectErr) {
          setError(authErrorMessage(redirectErr))
        }
      } else {
        setError(authErrorMessage(err))
      }
    } finally {
      setGoogleSubmitting(false)
    }
  }

  if (!authReady) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950 text-slate-400">
        불러오는 중...
      </div>
    )
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950 px-4 py-12 text-slate-100">
      <div className="mb-10 text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-blue-300">AlphaPulse</p>
        <h1 className="mt-2 text-2xl font-bold text-white">로그인</h1>
        <p className="mt-1 text-sm text-slate-400">
          Google 계정으로 가입·로그인하거나, 이메일과 비밀번호로 접속할 수 있습니다.
        </p>
      </div>

      <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900/80 p-8 shadow-lg backdrop-blur">
        <button
          type="button"
          onClick={onGoogleSignIn}
          disabled={busy}
          className="flex w-full items-center justify-center gap-3 rounded-lg border border-slate-600 bg-slate-950 py-2.5 text-sm font-semibold text-slate-100 shadow hover:border-slate-500 hover:bg-slate-900 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <GoogleGlyph className="h-5 w-5 shrink-0" />
          {googleSubmitting ? 'Google 연결 중…' : 'Google 계정으로 계속하기'}
        </button>

        <div className="relative my-6">
          <div className="absolute inset-0 flex items-center" aria-hidden>
            <div className="w-full border-t border-slate-700" />
          </div>
          <div className="relative flex justify-center text-xs uppercase tracking-[0.2em]">
            <span className="bg-slate-900/80 px-3 text-slate-500">또는 이메일</span>
          </div>
        </div>

        <form onSubmit={onSubmit} className="space-y-5">
          <div>
            <label htmlFor="login-email" className="mb-1.5 block text-xs font-medium uppercase tracking-[0.15em] text-blue-300">
              이메일
            </label>
            <input
              id="login-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-slate-100 outline-none focus:border-blue-400"
              placeholder="name@example.com"
              disabled={busy}
            />
          </div>
          <div>
            <label htmlFor="login-password" className="mb-1.5 block text-xs font-medium uppercase tracking-[0.15em] text-blue-300">
              비밀번호
            </label>
            <input
              id="login-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-slate-100 outline-none focus:border-blue-400"
              placeholder="••••••••"
              disabled={busy}
            />
          </div>

          {error && (
            <p className="rounded-lg border border-rose-900/50 bg-rose-950/30 px-3 py-2 text-sm text-rose-300" role="alert">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg bg-blue-600 py-2.5 text-sm font-semibold text-white shadow hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? '확인 중…' : '로그인'}
          </button>
        </form>

        <p className="mt-6 text-center text-xs text-slate-500">
        </p>
      </div>
    </div>
  )
}

import { FirebaseError } from 'firebase/app'
import type { User } from 'firebase/auth'
import { EmailAuthProvider, linkWithCredential, signOut } from 'firebase/auth'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { auth } from '../firebase'

function UserCircleIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  )
}

function hasPasswordProvider(user: User): boolean {
  return user.providerData.some((p) => p.providerId === 'password')
}

function linkPasswordErrorMessage(err: unknown): string {
  if (err instanceof FirebaseError) {
    switch (err.code) {
      case 'auth/weak-password':
        return '비밀번호가 너무 짧습니다. 6자 이상으로 설정하세요.'
      case 'auth/email-already-in-use':
        return '이 이메일은 이미 다른 방식으로 가입된 계정이 있습니다. 해당 방식으로 로그인하거나 Firebase에서 계정을 정리해야 합니다.'
      case 'auth/credential-already-in-use':
        return '이 비밀번호 인증은 다른 계정에 연결되어 있습니다.'
      case 'auth/provider-already-linked':
        return '이미 이메일·비밀번호 로그인이 연결되어 있습니다.'
      case 'auth/requires-recent-login':
        return '보안을 위해 다시 로그인한 뒤 시도하세요. 로그아웃 후 Google로 다시 로그인해 주세요.'
      default:
        return '비밀번호 연결에 실패했습니다. 잠시 후 다시 시도하세요.'
    }
  }
  return '알 수 없는 오류가 발생했습니다.'
}

export function UserMenu({ user }: { user: User }) {
  const navigate = useNavigate()
  const email = user.email
  const [open, setOpen] = useState(false)
  const [linkModalOpen, setLinkModalOpen] = useState(false)
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [linkErr, setLinkErr] = useState<string | null>(null)
  const [linkBusy, setLinkBusy] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  const canLinkEmailPassword = Boolean(email) && !hasPasswordProvider(user)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const onLogout = async () => {
    setOpen(false)
    await signOut(auth)
    navigate('/login', { replace: true })
  }

  const openLinkModal = () => {
    setOpen(false)
    setLinkErr(null)
    setPw('')
    setPw2('')
    setLinkModalOpen(true)
  }

  const closeLinkModal = () => {
    if (linkBusy) return
    setLinkModalOpen(false)
    setLinkErr(null)
    setPw('')
    setPw2('')
  }

  const onSubmitLinkPassword = async (e: React.FormEvent) => {
    e.preventDefault()
    setLinkErr(null)
    if (!email) {
      setLinkErr('이메일 정보가 없어 비밀번호를 연결할 수 없습니다.')
      return
    }
    if (pw.length < 6) {
      setLinkErr('비밀번호는 6자 이상이어야 합니다.')
      return
    }
    if (pw !== pw2) {
      setLinkErr('비밀번호가 서로 일치하지 않습니다.')
      return
    }
    const current = auth.currentUser
    if (!current) {
      setLinkErr('로그인 정보가 없습니다. 다시 로그인해 주세요.')
      return
    }
    setLinkBusy(true)
    try {
      const credential = EmailAuthProvider.credential(email, pw)
      await linkWithCredential(current, credential)
      setLinkModalOpen(false)
      setPw('')
      setPw2('')
    } catch (err) {
      setLinkErr(linkPasswordErrorMessage(err))
    } finally {
      setLinkBusy(false)
    }
  }

  const label = email ?? '사용자'

  const linkPasswordModal =
    linkModalOpen && typeof document !== 'undefined'
      ? createPortal(
          <div
            className="fixed inset-0 z-[9999] overflow-y-auto overflow-x-hidden bg-black/60"
            role="dialog"
            aria-modal="true"
            aria-labelledby="link-pw-title"
            onClick={(e) => {
              if (e.target === e.currentTarget) closeLinkModal()
            }}
          >
            <div
              className="flex min-h-[100dvh] w-full items-center justify-center px-4 py-10 sm:py-12"
              onClick={(e) => {
                if (e.target === e.currentTarget) closeLinkModal()
              }}
            >
              <div
                className="w-full max-w-md max-h-[min(90dvh,calc(100dvh-6rem))] overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-xl sm:max-h-[min(85dvh,calc(100dvh-4rem))]"
                onClick={(e) => e.stopPropagation()}
              >
                <h2 id="link-pw-title" className="text-lg font-semibold text-white">
                  이메일 로그인 비밀번호 연결
                </h2>
                <p className="mt-2 text-sm text-slate-400">
                  Google로 가입한 계정에 비밀번호를 추가하면, 같은 이메일(
                  <span className="text-slate-200">{email}</span>)로 로그인 페이지에서 이메일·비밀번호 로그인도 사용할 수
                  있습니다.
                </p>
                <form onSubmit={onSubmitLinkPassword} className="mt-4 space-y-4">
                  <div>
                    <label htmlFor="link-pw" className="mb-1 block text-xs text-blue-300">
                      새 비밀번호
                    </label>
                    <input
                      id="link-pw"
                      type="password"
                      autoComplete="new-password"
                      value={pw}
                      onChange={(e) => setPw(e.target.value)}
                      className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-blue-400"
                      disabled={linkBusy}
                    />
                  </div>
                  <div>
                    <label htmlFor="link-pw2" className="mb-1 block text-xs text-blue-300">
                      비밀번호 확인
                    </label>
                    <input
                      id="link-pw2"
                      type="password"
                      autoComplete="new-password"
                      value={pw2}
                      onChange={(e) => setPw2(e.target.value)}
                      className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-blue-400"
                      disabled={linkBusy}
                    />
                  </div>
                  {linkErr ? (
                    <p className="text-sm text-rose-300" role="alert">
                      {linkErr}
                    </p>
                  ) : null}
                  <div className="flex justify-end gap-2 pt-2">
                    <button
                      type="button"
                      onClick={closeLinkModal}
                      className="rounded-lg px-4 py-2 text-sm text-slate-300 hover:bg-slate-800"
                      disabled={linkBusy}
                    >
                      취소
                    </button>
                    <button
                      type="submit"
                      className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-60"
                      disabled={linkBusy}
                    >
                      {linkBusy ? '처리 중…' : '연결하기'}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          </div>,
          document.body,
        )
      : null

  return (
    <>
      <div className="relative" ref={wrapRef}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex max-w-full items-center gap-2 rounded-lg border border-slate-700 bg-slate-900/80 px-3 py-2 text-left text-sm text-slate-100 shadow-sm hover:border-slate-600 hover:bg-slate-800/90"
          aria-expanded={open}
          aria-haspopup="menu"
        >
          <UserCircleIcon className="h-5 w-5 shrink-0 text-slate-300" />
          <span className="truncate" title={label}>
            {label}
          </span>
        </button>

        {open ? (
          <div
            className="absolute right-0 z-50 mt-2 min-w-[14rem] rounded-lg border border-slate-700 bg-slate-900 py-1 shadow-xl"
            role="menu"
          >
            {canLinkEmailPassword ? (
              <button
                type="button"
                role="menuitem"
                onClick={openLinkModal}
                className="w-full px-4 py-2.5 text-left text-sm text-slate-200 hover:bg-slate-800"
              >
                이메일 로그인용 비밀번호 설정
              </button>
            ) : null}
            <button
              type="button"
              role="menuitem"
              onClick={onLogout}
              className="w-full px-4 py-2.5 text-left text-sm text-slate-200 hover:bg-slate-800"
            >
              로그아웃
            </button>
          </div>
        ) : null}
      </div>

      {linkPasswordModal}
    </>
  )
}

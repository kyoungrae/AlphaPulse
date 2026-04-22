import { doc, getDoc, setDoc } from 'firebase/firestore'
import { db } from './firebase'

/** 대시보드 즐겨찾기와 동일 의미 */
export type WatchlistRow = {
  symbol: string
  market: 'us' | 'kr'
  name: string
}

const COLLECTION = 'users'
/** 스키마 버전 (마이그레이션용) */
const WLV = 1
/** 문서·비용 보호 상한 */
const MAX_ITEMS = 250

/**
 * Firestore 저장용 북마크 레코드 (필드명 최소화)
 * - `s` symbol, `m` market, `n` 표시 이름
 */
type WlCompact = { s: string; m: 'us' | 'kr'; n: string }

type UserBookmarksDoc = {
  wlv?: number
  wl?: WlCompact[]
}

export function encodeWatchlist(rows: WatchlistRow[]): WlCompact[] {
  const seen = new Set<string>()
  const out: WlCompact[] = []
  for (const r of rows) {
    if (out.length >= MAX_ITEMS) break
    const sym = r.symbol.trim()
    if (!sym) continue
    const mkt: 'us' | 'kr' = r.market === 'kr' ? 'kr' : 'us'
    const key = `${mkt}:${sym}`
    if (seen.has(key)) continue
    seen.add(key)
    const name = (r.name || sym).trim() || sym
    out.push({ s: sym, m: mkt, n: name })
  }
  return out
}

export function decodeWatchlist(data: unknown): WatchlistRow[] {
  if (!data || typeof data !== 'object') return []
  const wl = (data as UserBookmarksDoc).wl
  if (!Array.isArray(wl)) return []
  const out: WatchlistRow[] = []
  const seen = new Set<string>()
  for (const x of wl) {
    if (!x || typeof x !== 'object') continue
    const o = x as Record<string, unknown>
    const s = typeof o.s === 'string' ? o.s.trim() : ''
    const m = o.m === 'kr' ? 'kr' : o.m === 'us' ? 'us' : null
    const n = typeof o.n === 'string' ? o.n.trim() : ''
    if (!s || !m) continue
    const k = `${m}:${s}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push({ symbol: s, market: m, name: n || s })
  }
  return out
}

export function watchlistFingerprint(rows: WatchlistRow[]): string {
  return JSON.stringify(encodeWatchlist(rows))
}

/** 로그인 사용자 즐겨찾기 1회 읽기 (실시간 리스너 없음 → 읽기 최소화) */
export async function fetchUserWatchlist(uid: string): Promise<WatchlistRow[]> {
  const snap = await getDoc(doc(db, COLLECTION, uid))
  if (!snap.exists()) return []
  return decodeWatchlist(snap.data())
}

/** merge: 다른 사용자 필드가 있어도 `wl`/`wlv` 만 갱신 */
export async function persistUserWatchlist(uid: string, rows: WatchlistRow[]): Promise<void> {
  const wl = encodeWatchlist(rows)
  await setDoc(
    doc(db, COLLECTION, uid),
    { wlv: WLV, wl } satisfies UserBookmarksDoc,
    { merge: true },
  )
}

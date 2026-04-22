import { onAuthStateChanged } from 'firebase/auth'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { apiUrl } from '../apiBase'
import { auth } from '../firebase'
import {
  fetchUserWatchlist,
  persistUserWatchlist,
  watchlistFingerprint,
  type WatchlistRow,
} from '../userWatchlistFirestore'

/** 호가·현재가 폴링 주기(ms). 백엔드 `QUOTE_LIVE_CACHE_TTL_MS`(기본 0.8s)보다 길게 두는 것을 권장 */
const QUOTE_POLL_MS = 1000
/** 당일 분봉 폴링 — KIS 분봉은 페이지 연속 호출이 있어 1초보다 2초 쪽이 안전 */
const INTRADAY_POLL_MS = 2000
/** 종목 검색 등 — 프록시/응답 지연 시 무한 로딩 방지 */
const SYMBOLS_FETCH_TIMEOUT_MS = 25_000

type SymbolItem = {
  symbol: string
  name: string
  nameKr?: string
}

type SymbolResponse = {
  market?: 'us' | 'kr'
  total?: number
  items: SymbolItem[]
}

type IntradayResponse = {
  symbol: string
  timezone: string
  interval: string
  sessionDate: string | null
  points: { t: string; c: number }[]
  asOf: string
  note?: string
}

type QuoteLive = {
  symbol: string
  shortName: string | null
  longName: string | null
  fullExchangeName: string | null
  exchangeTimezoneName: string | null
  currency: string | null
  marketState: string | null
  regularMarketPrice: number | null
  regularMarketChange: number | null
  regularMarketChangePercent: number | null
  regularMarketPreviousClose: number | null
  regularMarketOpen: number | null
  regularMarketDayHigh: number | null
  regularMarketDayLow: number | null
  regularMarketVolume: number | null
  bid: number | null
  ask: number | null
  bidSize: number | null
  askSize: number | null
  asOf: string
}

/** 즐겨찾기 칩: 시장 정보 포함 (미국·한국 동시 표시용) — 대시보드와 동일 */
type FavoriteSymbolChip = SymbolItem & { wlMarket: 'us' | 'kr' }

type WatchlistEntry = WatchlistRow

const WATCHLIST_STORAGE_KEY = 'alphapulse_watchlist_v1'

function loadWatchlistFromStorage(): WatchlistEntry[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(WATCHLIST_STORAGE_KEY)
    if (!raw) return []
    const p = JSON.parse(raw) as unknown
    if (!Array.isArray(p)) return []
    const out: WatchlistEntry[] = []
    const seen = new Set<string>()
    for (const x of p) {
      if (!x || typeof x !== 'object') continue
      const o = x as Record<string, unknown>
      const sym = typeof o.symbol === 'string' ? o.symbol.trim() : ''
      const mkt = o.market === 'kr' ? 'kr' : o.market === 'us' ? 'us' : null
      if (!sym || !mkt) continue
      const dedupeKey = `${mkt}:${sym}`
      if (seen.has(dedupeKey)) continue
      seen.add(dedupeKey)
      const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim() : sym
      out.push({ symbol: sym, market: mkt, name })
    }
    return out
  } catch {
    return []
  }
}

function useFetch<T>(url: string, options?: { timeoutMs?: number }) {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const fetchGenRef = useRef(0)

  useEffect(() => {
    if (!url.trim()) {
      fetchGenRef.current += 1
      setData(null)
      setLoading(false)
      setError(null)
      return
    }

    const gen = ++fetchGenRef.current
    const ac = new AbortController()
    const timeoutMs = options?.timeoutMs ?? SYMBOLS_FETCH_TIMEOUT_MS
    let timedOut = false
    const timer =
      timeoutMs > 0
        ? window.setTimeout(() => {
            timedOut = true
            ac.abort()
          }, timeoutMs)
        : 0
    setLoading(true)
    setError(null)

    const clearTimer = () => {
      if (timer) window.clearTimeout(timer)
    }

    fetch(url, { signal: ac.signal })
      .then(async (res) => {
        const bodyText = await res.text()
        if (!res.ok) {
          throw new Error(`요청 실패: ${res.status} ${bodyText}`)
        }
        if (!bodyText.trim()) {
          throw new Error('빈 응답입니다. 잠시 후 다시 시도해 주세요.')
        }
        let json: T
        try {
          json = JSON.parse(bodyText) as T
        } catch (e) {
          const ctype = res.headers.get('content-type') ?? ''
          throw new Error(
            ctype.includes('json')
              ? `JSON 파싱 실패: ${(e as Error).message}`
              : `JSON이 아닌 응답입니다(${ctype || 'no content-type'}): ${bodyText.slice(0, 200)}`,
          )
        }
        if (fetchGenRef.current !== gen) return
        setData(json)
      })
      .catch((err: unknown) => {
        if (fetchGenRef.current !== gen) return
        const name = err && typeof err === 'object' && 'name' in err ? String((err as { name: string }).name) : ''
        if (name === 'AbortError') {
          if (timedOut) {
            setError('요청 시간이 초과되었습니다. 백엔드(포트 4001) 실행·네트워크를 확인해 주세요.')
          }
          return
        }
        const msg = err instanceof Error ? err.message : String(err)
        setError(msg)
      })
      .finally(() => {
        clearTimer()
        if (fetchGenRef.current === gen) {
          setLoading(false)
        }
      })

    return () => {
      clearTimer()
      ac.abort()
    }
  }, [url])

  return { data, loading, error }
}

function formatPrice(n: number | null, market: 'us' | 'kr') {
  if (n == null || !Number.isFinite(n)) return '—'
  if (market === 'kr') return `${Math.round(n).toLocaleString('ko-KR')}원`
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function formatVolume(n: number | null) {
  if (n == null || !Number.isFinite(n)) return '—'
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString('ko-KR')
}

function formatAsOfWithSeconds(iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Intl.DateTimeFormat('ko-KR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso))
}

/** 시세 폴링 중 — 기준 시각 줄 앞에만 표시 */
function QuoteRefreshSpinner() {
  return (
    <svg
      className="h-3.5 w-3.5 shrink-0 animate-spin text-slate-400"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
    </svg>
  )
}

/** API `symbol`과 선택 티커가 약간 달라도(6자리·접미사 등) 동일 종목으로 인정 */
function livePayloadSymbolMatchesSelection(apiSym: string | undefined, wantRaw: string): boolean {
  const w = wantRaw.trim().toUpperCase()
  const a = apiSym?.trim().toUpperCase() ?? ''
  if (!w || !a) return false
  if (a === w) return true
  const stripKr = (s: string) => s.replace(/\.(KS|KQ)$/i, '')
  const wBase = stripKr(w)
  const aBase = stripKr(a)
  if (/^\d{6}$/.test(wBase) && wBase === aBase) return true
  /** `^` 지수 티커 등 — `[A-Z0-9.-]`만 쓰면 `^`가 문자 클래스 밖의 앵커로 해석되어 ^KS200이 실패함 */
  if (wBase === aBase && /^[A-Z0-9.\^-]+$/i.test(wBase)) return true
  return false
}

/**
 * 응답 symbol이 비었거나, 요청·응답 티커 표기(6자리·.KS 등)만 다를 때는 정상 응답으로 인정
 */
function symbolMatchesWantOrUnknown(
  apiSym: string | undefined,
  want: string,
  mkt: 'us' | 'kr',
): boolean {
  const w = normalizeTickerForQuoteApi(want, mkt).toUpperCase()
  if (!w) return false
  const raw = apiSym?.trim() ?? ''
  if (!raw) return true
  const a = normalizeTickerForQuoteApi(raw, mkt).toUpperCase()
  if (a === w) return true
  return livePayloadSymbolMatchesSelection(raw, w)
}

function watchlistHasSelectionForDetail(
  rows: WatchlistEntry[],
  sel: string,
  mkt: 'us' | 'kr',
): boolean {
  const s = sel.trim()
  if (!s) return false
  return rows.some((w) => w.market === mkt && livePayloadSymbolMatchesSelection(w.symbol, s))
}

function findWatchlistRowForSelected(
  rows: WatchlistEntry[],
  sel: string,
  mkt: 'us' | 'kr',
): WatchlistEntry | undefined {
  const s = sel.trim()
  if (!s) return undefined
  return rows.find((w) => w.market === mkt && livePayloadSymbolMatchesSelection(w.symbol, s))
}

/** KIS 시세·분봉은 국내 6자리면 `.KS` 접미가 필요 — 즐겨찾기에 `005930`만 있어도 조회되게 */
function normalizeTickerForQuoteApi(sel: string, mkt: 'us' | 'kr'): string {
  const t = sel.trim().toUpperCase()
  if (mkt === 'kr' && /^\d{6}$/.test(t)) return `${t}.KS`
  return t
}

function mergeIntradayWithLiveQuote(
  points: { t: string; c: number }[],
  livePrice: number | null | undefined,
  liveAsOf: string | null | undefined,
): { t: string; c: number }[] {
  if (!points.length) return []
  if (livePrice == null || !Number.isFinite(livePrice) || !liveAsOf) return [...points]
  const out = points.map((p) => ({ ...p }))
  const last = out[out.length - 1]
  const lastMs = new Date(last.t).getTime()
  const qMs = new Date(liveAsOf).getTime()
  if (!Number.isFinite(lastMs) || !Number.isFinite(qMs)) return [...points]
  if (qMs > lastMs) {
    out.push({ t: liveAsOf, c: livePrice })
  } else {
    out[out.length - 1] = { t: last.t, c: livePrice }
  }
  return out
}

function marketStateLabel(state: string | null) {
  if (!state) return '—'
  const map: Record<string, string> = {
    REGULAR: '정규장',
    PRE: '장전',
    PREPRE: '장전(야간)',
    POST: '장후',
    POSTPOST: '장후(야간)',
    CLOSED: '마감',
  }
  return map[state] ?? state
}

export default function StockPrediction() {
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [market, setMarket] = useState<'us' | 'kr'>('us')
  /** 대시보드와 동일: true면 검색 API 대신 즐겨찾기 목록만 표시 */
  const [favoritesOnly, setFavoritesOnly] = useState(true)
  const [watchlist, setWatchlist] = useState<WatchlistEntry[]>(() => loadWatchlistFromStorage())
  const [selected, setSelected] = useState('')
  const [quote, setQuote] = useState<QuoteLive | null>(null)
  const [quoteLoading, setQuoteLoading] = useState(false)
  const [quoteError, setQuoteError] = useState<string | null>(null)
  const [intraday, setIntraday] = useState<IntradayResponse | null>(null)
  const [intradayLoading, setIntradayLoading] = useState(false)
  const [intradayError, setIntradayError] = useState<string | null>(null)
  /** 첫 로드·폴링 시 숫자 옆 로딩 표시(레이아웃 고정은 min-h·고정 차트 슬롯으로 유지) */
  const [quotePollBusy, setQuotePollBusy] = useState(false)

  const watchlistCloudHydratedRef = useRef(false)
  const lastCloudPersistJsonRef = useRef<string | null>(null)
  /** 폴링 응답이 종목 전환 이후에 도착해도 잘못 반영되지 않게 최신 정규화 티커와 비교 */
  const selectedRef = useRef('')
  selectedRef.current = normalizeTickerForQuoteApi(selected, market).toUpperCase()
  /** 종목 바꾼 직후 첫 요청만 로딩 표시 — 폴링마다 스피너가 깜빡이며 “안 불러와짐”처럼 보이는 것 방지 */
  const quoteFirstLoadSpinRef = useRef(true)
  const intradayFirstLoadSpinRef = useRef(true)

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 200)
    return () => clearTimeout(timer)
  }, [search])

  /** 미국 S&P 목록 캐시를 서버에서 미리 채워 두어, 검색 모드 전환 시 첫 응답이 빨라지게 함 */
  useEffect(() => {
    void fetch(apiUrl('/api/symbols?market=us&q=&limit=200')).catch(() => {})
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(watchlist))
    } catch {
      /* ignore quota */
    }
  }, [watchlist])

  useEffect(() => {
    return onAuthStateChanged(auth, async (user) => {
      if (!user) {
        lastCloudPersistJsonRef.current = null
        watchlistCloudHydratedRef.current = true
        return
      }
      watchlistCloudHydratedRef.current = false
      const uid = user.uid
      try {
        const cloud = await fetchUserWatchlist(uid)
        if (cloud.length > 0) {
          lastCloudPersistJsonRef.current = watchlistFingerprint(cloud)
          setWatchlist(cloud)
        } else {
          const local = loadWatchlistFromStorage()
          if (local.length > 0) {
            setWatchlist(local)
            await persistUserWatchlist(uid, local)
            lastCloudPersistJsonRef.current = watchlistFingerprint(local)
          } else {
            lastCloudPersistJsonRef.current = watchlistFingerprint([])
          }
        }
      } catch (err) {
        console.error('즐겨찾기 클라우드 로드 실패', err)
      } finally {
        watchlistCloudHydratedRef.current = true
      }
    })
  }, [])

  useEffect(() => {
    if (!watchlistCloudHydratedRef.current) return
    const uid = auth.currentUser?.uid
    if (!uid) return
    const fp = watchlistFingerprint(watchlist)
    if (lastCloudPersistJsonRef.current === fp) return
    const snapshot = watchlist
    const timer = window.setTimeout(() => {
      if (auth.currentUser?.uid !== uid) return
      persistUserWatchlist(uid, snapshot)
        .then(() => {
          lastCloudPersistJsonRef.current = fp
        })
        .catch((e) => {
          console.error('즐겨찾기 클라우드 저장 실패', e)
        })
    }, 700)
    return () => window.clearTimeout(timer)
  }, [watchlist])

  /** 즐겨찾기 모드: 목록이 있으면 첫 종목을 선택, 비면 선택 해제 */
  useEffect(() => {
    if (!favoritesOnly) return
    if (watchlist.length === 0) {
      if (selected !== '') setSelected('')
      return
    }
    const inList = watchlistHasSelectionForDetail(watchlist, selected, market)
    if (!inList) {
      const first = watchlist[0]
      setMarket(first.market)
      setSelected(first.symbol)
    }
  }, [favoritesOnly, watchlist, selected, market])

  /** 검색 모드: 선택이 비어 있으면 시장별 기본 티커 */
  useEffect(() => {
    if (favoritesOnly) return
    if (!selected.trim()) {
      setSelected(market === 'kr' ? '005930.KS' : 'AAPL')
    }
  }, [favoritesOnly, market, selected])

  const symbolsUrl = useMemo(() => {
    if (favoritesOnly) return ''
    return apiUrl(`/api/symbols?market=${market}&q=${encodeURIComponent(debouncedSearch.trim())}&limit=200`)
  }, [debouncedSearch, market, favoritesOnly])

  const {
    data: symbols,
    loading: symbolsLoading,
    error: symbolsError,
  } = useFetch<SymbolResponse>(symbolsUrl)

  const favoriteSymbolItems = useMemo((): FavoriteSymbolChip[] => {
    const q = debouncedSearch.trim().toLowerCase()
    let rows = watchlist
    if (q) {
      rows = rows.filter(
        (w) => w.symbol.toLowerCase().includes(q) || w.name.toLowerCase().includes(q),
      )
    }
    return rows.map((w) => ({
      symbol: w.symbol,
      name: w.name,
      nameKr: w.market === 'kr' ? w.name : undefined,
      wlMarket: w.market,
    }))
  }, [watchlist, debouncedSearch])

  const displaySymbolItems: SymbolItem[] | FavoriteSymbolChip[] = favoritesOnly
    ? favoriteSymbolItems
    : (symbols?.items ?? [])

  const detailSelectionReady = useMemo(() => {
    if (!selected.trim()) return false
    if (favoritesOnly) {
      if (watchlist.length === 0) return false
      return watchlistHasSelectionForDetail(watchlist, selected, market)
    }
    return true
  }, [favoritesOnly, watchlist, selected, market])

  useEffect(() => {
    quoteFirstLoadSpinRef.current = true
    intradayFirstLoadSpinRef.current = true
    setQuotePollBusy(false)
    setQuoteLoading(false)
    setIntradayLoading(false)
    setQuote(null)
    setQuoteError(null)
    setIntraday(null)
    setIntradayError(null)
  }, [selected, market])

  useEffect(() => {
    if (!detailSelectionReady || !selected.trim()) return
    const tickerForApi = normalizeTickerForQuoteApi(selected, market)
    const requestedKey = tickerForApi.toUpperCase()

    let cancelled = false
    let timerId: number | undefined
    let inFlightController: AbortController | null = null

    const pollQuote = async () => {
      if (cancelled) return
      const ac = new AbortController()
      inFlightController = ac
      let nextMs = QUOTE_POLL_MS
      const showSpin = quoteFirstLoadSpinRef.current
      setQuotePollBusy(true)
      if (showSpin) setQuoteLoading(true)
      setQuoteError(null)
      try {
        const res = await fetch(apiUrl(`/api/quote/${encodeURIComponent(tickerForApi)}`), { signal: ac.signal })
        const text = await res.text()
        if (!res.ok) throw new Error(text || `HTTP ${res.status}`)
        const data = JSON.parse(text) as QuoteLive
        if (selectedRef.current !== requestedKey || !symbolMatchesWantOrUnknown(data.symbol, requestedKey, market)) return
        setQuote(data)
        nextMs = data.marketState === 'CLOSED' ? 60_000 : QUOTE_POLL_MS
      } catch (e) {
        if (cancelled || (e instanceof Error && e.name === 'AbortError')) return
        if (selectedRef.current !== requestedKey) return
        setQuote(null)
        setQuoteError(e instanceof Error ? e.message : '시세 조회 실패')
      } finally {
        if (cancelled || selectedRef.current !== requestedKey) return
        setQuotePollBusy(false)
        setQuoteLoading(false)
        if (showSpin) quoteFirstLoadSpinRef.current = false
        timerId = window.setTimeout(() => {
          void pollQuote()
        }, nextMs)
      }
    }

    void pollQuote()
    return () => {
      cancelled = true
      if (timerId) window.clearTimeout(timerId)
      inFlightController?.abort()
    }
  }, [selected, market, detailSelectionReady])

  useEffect(() => {
    if (!detailSelectionReady || !selected.trim()) return
    const tickerForApi = normalizeTickerForQuoteApi(selected, market)
    const requestedKey = tickerForApi.toUpperCase()

    let cancelled = false
    let timerId: number | undefined
    let inFlightController: AbortController | null = null

    const pollIntraday = async () => {
      if (cancelled) return
      const ac = new AbortController()
      inFlightController = ac
      let nextMs = INTRADAY_POLL_MS
      const showSpin = intradayFirstLoadSpinRef.current
      if (showSpin) setIntradayLoading(true)
      setIntradayError(null)
      try {
        const res = await fetch(apiUrl(`/api/quote/${encodeURIComponent(tickerForApi)}/intraday`), { signal: ac.signal })
        const text = await res.text()
        if (!res.ok) throw new Error(text || `HTTP ${res.status}`)
        const data = JSON.parse(text) as IntradayResponse
        if (selectedRef.current !== requestedKey || !symbolMatchesWantOrUnknown(data.symbol, requestedKey, market)) return
        setIntraday(data)
        nextMs = quote?.marketState === 'CLOSED' ? 60_000 : INTRADAY_POLL_MS
      } catch (e) {
        if (cancelled || (e instanceof Error && e.name === 'AbortError')) return
        if (selectedRef.current !== requestedKey) return
        setIntraday(null)
        setIntradayError(e instanceof Error ? e.message : '분봉 조회 실패')
      } finally {
        if (cancelled || selectedRef.current !== requestedKey) return
        setIntradayLoading(false)
        if (showSpin) intradayFirstLoadSpinRef.current = false
        timerId = window.setTimeout(() => {
          void pollIntraday()
        }, nextMs)
      }
    }

    void pollIntraday()
    return () => {
      cancelled = true
      if (timerId) window.clearTimeout(timerId)
      inFlightController?.abort()
    }
  }, [selected, market, detailSelectionReady, quote?.marketState])

  const selectedSymbolInfo = useMemo(() => {
    const fromApi = (symbols?.items ?? []).find((item) => item.symbol === selected)
    if (fromApi) return fromApi
    const fromWl = findWatchlistRowForSelected(watchlist, selected, market)
    if (fromWl) {
      return {
        symbol: fromWl.symbol,
        name: fromWl.name,
        nameKr: market === 'kr' ? fromWl.name : undefined,
      } satisfies SymbolItem
    }
    return undefined
  }, [symbols, selected, watchlist, market])

  const selectedDisplayName = selectedSymbolInfo?.nameKr ?? selectedSymbolInfo?.name ?? selected

  const selectedIsFavorite = useMemo(
    () => watchlistHasSelectionForDetail(watchlist, selected, market),
    [watchlist, selected, market],
  )

  const toggleFavoriteForSelection = () => {
    if (!selected.trim()) return
    setWatchlist((prev) => {
      const idx = prev.findIndex((w) => w.symbol === selected && w.market === market)
      if (idx >= 0) {
        return prev.filter((_, i) => i !== idx)
      }
      const label = selectedSymbolInfo?.nameKr ?? selectedSymbolInfo?.name ?? selected
      return [...prev, { symbol: selected, market, name: label }]
    })
  }

  const spread =
    quote?.bid != null && quote?.ask != null && Number.isFinite(quote.bid) && Number.isFinite(quote.ask)
      ? quote.ask - quote.bid
      : null

  const chgPct = quote?.regularMarketChangePercent

  const chartRows = useMemo(() => {
    const want = normalizeTickerForQuoteApi(selected, market).toUpperCase()
    if (!want) return []
    if (intraday && !symbolMatchesWantOrUnknown(intraday.symbol, want, market)) return []
    const base = intraday?.points ?? []
    const liveOk = quote && symbolMatchesWantOrUnknown(quote.symbol, want, market)
    const livePrice = liveOk ? quote.regularMarketPrice : undefined
    const liveAsOf = liveOk ? quote.asOf : undefined
    return mergeIntradayWithLiveQuote(base, livePrice, liveAsOf)
  }, [intraday, quote, selected, market])

  const chartDomain = useMemo(() => {
    const vals = chartRows.map((r) => r.c).filter((n) => Number.isFinite(n))
    if (!vals.length) return undefined
    const lo = Math.min(...vals)
    const hi = Math.max(...vals)
    const pad = hi > lo ? (hi - lo) * 0.06 : Math.abs(hi) * 0.001 || 0.01
    return [lo - pad, hi + pad] as [number, number]
  }, [chartRows])

  const chartStroke = chgPct != null && Number.isFinite(chgPct) && chgPct < 0 ? '#fb7185' : '#38bdf8'

  const chartInstanceId = useMemo(
    () => `${market}_${selected.replace(/[^a-zA-Z0-9]/g, '_') || 'sym'}`,
    [market, selected],
  )

  const showQuotePriceSkeleton =
    detailSelectionReady && !quote && !quoteError && (quoteLoading || quotePollBusy)

  return (
    <div className="space-y-4 text-slate-100">
      <div>
        <h2 className="text-2xl font-bold">종목 실시간 현황</h2>
        <p className="text-sm text-slate-400">
          종목을 고르면 호가·현재가는 약 1초마다, 당일 분봉 차트는 약 2초마다 갱신됩니다. 현재가가 반영되면서 곡선 끝이
          함께 움직입니다.
        </p>
      </div>

      <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-4 shadow-lg">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <label className="text-xs uppercase tracking-[0.2em] text-blue-300">종목 검색</label>
          <div className="flex flex-wrap items-center gap-1 rounded-full bg-slate-950/80 p-1">
            <button
              type="button"
              onClick={() => {
                setMarket('us')
                setFavoritesOnly(false)
                setSelected('AAPL')
                setDebouncedSearch(search)
              }}
              className={`rounded-full px-2 py-1 text-[11px] font-semibold ${
                market === 'us' && !favoritesOnly ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-slate-800'
              }`}
            >
              미국
            </button>
            <button
              type="button"
              onClick={() => {
                setMarket('kr')
                setFavoritesOnly(false)
                setSelected('005930.KS')
                setDebouncedSearch(search)
              }}
              className={`rounded-full px-2 py-1 text-[11px] font-semibold ${
                market === 'kr' && !favoritesOnly ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-slate-800'
              }`}
            >
              한국
            </button>
            <button
              type="button"
              onClick={() => {
                setFavoritesOnly((v) => {
                  const next = !v
                  if (next) {
                    setSearch('')
                    setDebouncedSearch('')
                  }
                  return next
                })
              }}
              className={`rounded-full px-2 py-1 text-[11px] font-semibold ${
                favoritesOnly ? 'bg-amber-500 text-slate-900' : 'text-amber-200/90 hover:bg-slate-800'
              }`}
              title="저장된 미국·한국 즐겨찾기 전체 표시"
            >
              ★ 즐겨찾기
            </button>
          </div>
        </div>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={
            market === 'kr'
              ? '종목코드 또는 기업명 (예: 005930.KS, 삼성전자)'
              : '티커 또는 기업명 (예: AAPL, Microsoft)'
          }
          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-blue-400"
        />
        <div
          className={`mt-2 flex flex-wrap gap-2 overflow-y-auto pr-1 ${favoritesOnly ? 'max-h-64' : 'max-h-36'}`}
        >
          {displaySymbolItems.map((item, chipIdx) => {
            const rowMarket = 'wlMarket' in item ? item.wlMarket : market
            const inWatchlist = watchlist.some(
              (w) => w.market === rowMarket && livePayloadSymbolMatchesSelection(w.symbol, item.symbol),
            )
            return (
              <button
                key={
                  'wlMarket' in item ? `fav-${item.wlMarket}-${item.symbol}-${chipIdx}` : item.symbol
                }
                type="button"
                onClick={() => {
                  if ('wlMarket' in item) {
                    const m = item.wlMarket
                    setMarket(m === 'kr' ? 'kr' : 'us')
                    setSelected(item.symbol)
                  } else {
                    setSelected(item.symbol)
                  }
                }}
                title={item.symbol}
                className={`inline-flex max-w-full items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold ${
                  selected === item.symbol && market === rowMarket
                    ? 'bg-blue-600 text-white'
                    : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                }`}
              >
                {inWatchlist && (
                  <span className="shrink-0 text-[10px] text-amber-300" aria-hidden>
                    ★
                  </span>
                )}
                {'wlMarket' in item && (
                  <span className="shrink-0 rounded bg-slate-700/90 px-1 py-0 text-[9px] font-medium text-slate-300">
                    {item.wlMarket === 'us' ? '미국' : '한국'}
                  </span>
                )}
                <span className="truncate">{item.nameKr ?? item.name}</span>
              </button>
            )
          })}
          {!favoritesOnly && symbolsLoading && (
            <span className="text-xs text-slate-500">목록 불러오는 중...</span>
          )}
          {!favoritesOnly && symbolsError && <span className="text-xs text-rose-400">오류: {symbolsError}</span>}
          {favoritesOnly && watchlist.length === 0 && (
            <span className="text-xs text-slate-500">
              즐겨찾기가 없습니다. 미국/한국에서 종목을 고른 뒤 아래 ★로 추가하세요.
            </span>
          )}
          {favoritesOnly && watchlist.length > 0 && favoriteSymbolItems.length === 0 && (
            <span className="text-xs text-slate-500">검색어와 일치하는 즐겨찾기가 없습니다.</span>
          )}
        </div>
        <p className="mt-2 text-[11px] text-slate-500">
          {favoritesOnly
            ? `즐겨찾기 ${favoriteSymbolItems.length}개 표시`
            : `목록 크기: ${symbols?.total ?? 0}개`}
        </p>
      </div>

      <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-4 shadow-lg">
        <div className="mb-4 flex min-h-[5.5rem] flex-nowrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h3 className="text-lg font-semibold leading-snug text-white">
              {detailSelectionReady ? selectedDisplayName : '종목을 선택해 주세요'}
            </h3>
            <p className="mt-0.5 text-xs leading-snug text-slate-500">
              {detailSelectionReady
                ? selected
                : favoritesOnly && watchlist.length === 0
                  ? '즐겨찾기에 종목을 추가하거나 위 칩에서 선택하세요.'
                  : '즐겨찾기 칩을 눌러 종목을 고르세요.'}
            </p>
            <p
              className={`mt-1 min-h-[2.25rem] text-xs leading-snug text-slate-400 ${
                !detailSelectionReady || !quote?.shortName ? 'invisible' : ''
              }`}
              aria-hidden={!quote?.shortName}
            >
              {detailSelectionReady ? quote?.shortName ?? '\u00a0' : '\u00a0'}
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-2">
            <button
              type="button"
              onClick={toggleFavoriteForSelection}
              disabled={!selected.trim() || !detailSelectionReady}
              className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                selectedIsFavorite
                  ? 'border-amber-500/60 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25'
                  : 'border-slate-600 bg-slate-800/80 text-slate-300 hover:border-amber-600/50 hover:text-amber-200'
              }`}
              title={selectedIsFavorite ? '즐겨찾기에서 제거' : '즐겨찾기에 추가'}
            >
              {selectedIsFavorite ? '★ 즐겨찾기 해제' : '☆ 즐겨찾기 추가'}
            </button>
            <div className="flex min-h-[2.75rem] flex-col items-end justify-end text-right text-xs text-slate-500">
              {detailSelectionReady ? (
                <>
                  <span
                    className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-bold ${
                      quote?.marketState === 'CLOSED'
                        ? 'border-rose-900/50 bg-rose-950/20 text-rose-400'
                        : 'border-emerald-900/40 bg-emerald-950/20 text-emerald-400'
                    }`}
                  >
                    <span
                      className={`h-1 w-1 rounded-full ${
                        quote?.marketState === 'CLOSED' ? 'bg-rose-500' : 'animate-pulse bg-emerald-500'
                      }`}
                    />
                    {quote?.marketState === 'CLOSED' ? '장 마감됨' : '실시간 연결됨'}
                  </span>
                  <p
                    className="mt-1 flex min-h-[1.25rem] items-center justify-end gap-1.5 tabular-nums"
                    {...(quotePollBusy && !quote?.asOf ? { role: 'status', 'aria-live': 'polite' as const } : {})}
                  >
                    {quotePollBusy && !quote?.asOf && <QuoteRefreshSpinner />}
                    <span className={!quote?.asOf && !quotePollBusy ? 'invisible' : ''}>
                      {quote?.asOf
                        ? `기준: ${formatAsOfWithSeconds(quote.asOf)}`
                        : quotePollBusy
                          ? '시세 불러오는 중'
                          : '\u00a0'}
                    </span>
                  </p>
                </>
              ) : (
                <p className="mt-1 min-h-[1.25rem]" aria-hidden>
                  {'\u00a0'}
                </p>
              )}
            </div>
          </div>
        </div>

        <div className="min-h-[1.5rem]">
          {detailSelectionReady && quoteError && (
            <p className="mb-3 text-sm leading-snug text-rose-400">{quoteError}</p>
          )}
        </div>

        {!detailSelectionReady && (
          <p className="mb-3 rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2 text-sm text-slate-400">
            표시할 종목이 없습니다. 위에서 즐겨찾기를 추가하거나 칩으로 종목을 선택하세요.
          </p>
        )}

        {detailSelectionReady && (
          <div className="mt-0 space-y-4">
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="rounded-xl border border-rose-900/40 bg-rose-950/20 p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-rose-300">매도 호가 (Ask)</p>
                <p className="mt-2 min-h-[2rem] text-2xl font-bold tabular-nums text-white">
                  {quote ? (
                    formatPrice(quote.ask, market)
                  ) : showQuotePriceSkeleton ? (
                    <span
                      className="inline-block h-8 w-[7rem] max-w-full animate-pulse rounded-md bg-slate-700/70 align-middle"
                      aria-hidden
                    />
                  ) : (
                    '—'
                  )}
                </p>
                <p className="mt-1 text-xs text-slate-400">
                  물량:{' '}
                  {quote?.askSize != null ? quote.askSize.toLocaleString('ko-KR') : showQuotePriceSkeleton ? '…' : '—'}
                </p>
              </div>
              <div className="rounded-xl border border-emerald-900/40 bg-emerald-950/20 p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-emerald-300">매수 호가 (Bid)</p>
                <p className="mt-2 min-h-[2rem] text-2xl font-bold tabular-nums text-white">
                  {quote ? (
                    formatPrice(quote.bid, market)
                  ) : showQuotePriceSkeleton ? (
                    <span
                      className="inline-block h-8 w-[7rem] max-w-full animate-pulse rounded-md bg-slate-700/70 align-middle"
                      aria-hidden
                    />
                  ) : (
                    '—'
                  )}
                </p>
                <p className="mt-1 text-xs text-slate-400">
                  물량:{' '}
                  {quote?.bidSize != null ? quote.bidSize.toLocaleString('ko-KR') : showQuotePriceSkeleton ? '…' : '—'}
                </p>
              </div>
            </div>

            <div className="grid gap-3 rounded-xl border border-slate-800 bg-slate-950/50 p-4 text-sm text-slate-300 md:grid-cols-2">
              <div>
                <p className="text-xs text-slate-500">현재가 (정규장)</p>
                <p className="mt-1 min-h-[1.75rem] text-xl font-semibold tabular-nums text-white">
                  {quote ? (
                    formatPrice(quote.regularMarketPrice, market)
                  ) : showQuotePriceSkeleton ? (
                    <span
                      className="inline-block h-7 w-[8.5rem] max-w-full animate-pulse rounded-md bg-slate-700/70 align-middle"
                      aria-hidden
                    />
                  ) : (
                    '—'
                  )}
                </p>
                <p className="mt-1 min-h-[2.5rem] text-xs leading-snug">
                  {quote && chgPct != null && Number.isFinite(chgPct) ? (
                    <span className={chgPct >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                      {chgPct >= 0 ? '+' : ''}
                      {chgPct.toFixed(2)}%
                    </span>
                  ) : (
                    <span className="text-slate-500">변동률 —</span>
                  )}
                  {quote && quote.regularMarketChange != null && Number.isFinite(quote.regularMarketChange) ? (
                    <span className="ml-2 block text-slate-400 sm:inline">
                      (
                      {quote.regularMarketChange >= 0 ? '+' : ''}
                      {market === 'kr'
                        ? `${Math.round(quote.regularMarketChange).toLocaleString('ko-KR')}원`
                        : `$${quote.regularMarketChange.toLocaleString('en-US', { maximumFractionDigits: 2 })}`}
                      )
                    </span>
                  ) : (
                    <span className="invisible ml-2 block text-slate-400 sm:inline">(0)</span>
                  )}
                </p>
              </div>
              <div>
                <p className="text-xs text-slate-500">스프레드 (Ask − Bid)</p>
                <p className="mt-1 min-h-[1.75rem] text-xl font-semibold tabular-nums text-white">
                  {quote && spread != null && Number.isFinite(spread)
                    ? formatPrice(spread, market)
                    : showQuotePriceSkeleton
                      ? (
                          <span
                            className="inline-block h-7 w-[6.5rem] max-w-full animate-pulse rounded-md bg-slate-700/70 align-middle"
                            aria-hidden
                          />
                        )
                      : '—'}
                </p>
              </div>
              <div>
                <p className="text-xs text-slate-500">시가 · 고가 · 저가</p>
                <p className="mt-1 min-h-[1.25rem] tabular-nums">
                  {quote ? (
                    <>
                      {formatPrice(quote.regularMarketOpen, market)} ·{' '}
                      {formatPrice(quote.regularMarketDayHigh, market)} ·{' '}
                      {formatPrice(quote.regularMarketDayLow, market)}
                    </>
                  ) : showQuotePriceSkeleton ? (
                    <span
                      className="inline-block h-4 w-full max-w-[14rem] animate-pulse rounded-md bg-slate-700/70 align-middle"
                      aria-hidden
                    />
                  ) : (
                    '—'
                  )}
                </p>
              </div>
              <div>
                <p className="text-xs text-slate-500">거래량 · 장 상태</p>
                <p className="mt-1 min-h-[1.25rem]">
                  {quote ? (
                    <>
                      {formatVolume(quote.regularMarketVolume)} · {marketStateLabel(quote.marketState)}
                    </>
                  ) : showQuotePriceSkeleton ? (
                    <span
                      className="inline-block h-4 w-[10rem] max-w-full animate-pulse rounded-md bg-slate-700/70 align-middle"
                      aria-hidden
                    />
                  ) : (
                    '—'
                  )}
                </p>
                <p className="mt-0.5 min-h-[2rem] text-[11px] leading-snug text-slate-500">
                  {quote?.fullExchangeName || quote?.exchangeTimezoneName ? (
                    <>
                      {quote.fullExchangeName ?? ''}
                      {quote.exchangeTimezoneName ? ` · ${quote.exchangeTimezoneName}` : ''}
                    </>
                  ) : (
                    <span className="invisible">—</span>
                  )}
                </p>
              </div>
            </div>
          </div>
        )}

        <div className="mt-3 min-h-[2.75rem]">
          {detailSelectionReady && quote && quote.bid == null && quote.ask == null && (
            <p className="text-xs leading-snug text-amber-200/90">
              이 종목은 호가 단위 데이터가 제공되지 않습니다. 현재가·거래량만 참고하세요.
            </p>
          )}
        </div>

        <div className="mt-6 border-t border-slate-800 pt-4">
          {!detailSelectionReady ? (
            <p className="py-6 text-center text-sm text-slate-500">
              종목을 선택하면 당일 분봉 차트가 표시됩니다.
            </p>
          ) : (
            <>
              <div className="mb-2 flex min-h-[3.25rem] flex-nowrap items-end justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">당일 분봉 (1분)</p>
                  <p className="mt-0.5 min-h-[2.25rem] text-[11px] leading-snug text-slate-500">
                    {intraday?.sessionDate ? (
                      <>
                        세션 기준일 {intraday.sessionDate}
                        {intraday.timezone ? ` · ${intraday.timezone}` : ''}
                      </>
                    ) : (
                      <span className="invisible">세션 기준일 —</span>
                    )}
                  </p>
                  <p className="mt-0.5 text-[11px] leading-snug text-slate-500">
                    <span className="text-sky-400">파랑</span> 상승/보합 · <span className="text-rose-400">빨강</span> 하락
                  </p>
                </div>
                <div className="w-auto shrink-0 text-right text-[11px] text-slate-500">
                  <span className="block min-h-[1.125rem] whitespace-nowrap">
                    {detailSelectionReady && (quote?.asOf || intraday?.asOf) ? (
                      <span>기준: {formatAsOfWithSeconds(quote?.asOf ?? intraday?.asOf)}</span>
                    ) : (
                      <span className="invisible">차트</span>
                    )}
                  </span>
                </div>
              </div>
              <div className="min-h-[1.5rem]">
                {intradayError && <p className="mb-2 text-sm leading-snug text-rose-400">{intradayError}</p>}
              </div>
              <div className="relative h-64 w-full shrink-0 overflow-hidden rounded-lg border border-slate-800/40 bg-slate-950/30">
              {!intradayLoading && !intradayError && chartRows.length === 0 && (
                <div className="absolute inset-0 flex items-center justify-center px-2 py-6">
                  <p className="text-center text-sm leading-relaxed text-slate-500">
                    {intraday?.note ??
                      '표시할 분봉이 없습니다. 장 마감 후이거나 데이터 제공이 제한된 종목일 수 있습니다.'}
                  </p>
                </div>
              )}
              {chartRows.length > 0 && (
                <div className="absolute inset-0 h-full w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart key={chartInstanceId} data={chartRows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                      <defs>
                        <linearGradient id={`livePriceFill-${chartInstanceId}`} x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor={chartStroke} stopOpacity={0.35} />
                          <stop offset="100%" stopColor={chartStroke} stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                      <XAxis
                        dataKey="t"
                        tick={{ fill: '#64748b', fontSize: 10 }}
                        tickMargin={6}
                        minTickGap={28}
                        tickFormatter={(v) =>
                          new Intl.DateTimeFormat('ko-KR', {
                            timeZone: intraday?.timezone ?? undefined,
                            hour: '2-digit',
                            minute: '2-digit',
                            hourCycle: 'h23',
                          }).format(new Date(String(v)))
                        }
                      />
                      <YAxis
                        domain={chartDomain}
                        width={market === 'kr' ? 52 : 56}
                        tick={{ fill: '#64748b', fontSize: 10 }}
                        tickFormatter={(v) =>
                          market === 'kr'
                            ? `${Math.round(Number(v)).toLocaleString('ko-KR')}`
                            : `$${Number(v).toFixed(2)}`
                        }
                      />
                      <Tooltip
                        content={({ active, payload }) => {
                          if (!active || !payload?.length) return null
                          const row = payload[0].payload as { t: string; c: number }
                          const tLabel = new Intl.DateTimeFormat('ko-KR', {
                            timeZone: intraday?.timezone ?? undefined,
                            month: 'numeric',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit',
                            hourCycle: 'h23',
                          }).format(new Date(row.t))
                          return (
                            <div className="rounded-lg border border-slate-600 bg-slate-950/95 px-3 py-2 text-xs shadow-lg">
                              <p className="text-slate-400">{tLabel}</p>
                              <p className="mt-1 font-semibold tabular-nums text-white">
                                {formatPrice(row.c, market)}
                              </p>
                            </div>
                          )
                        }}
                      />
                      <Area
                        type="monotone"
                        dataKey="c"
                        stroke={chartStroke}
                        strokeWidth={1.5}
                        fill={`url(#livePriceFill-${chartInstanceId})`}
                        isAnimationActive={false}
                        dot={false}
                        activeDot={{ r: 3, fill: chartStroke }}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              )}
              {intradayLoading && chartRows.length === 0 && !intradayError && (
                <div className="absolute inset-0 flex items-center justify-center" aria-hidden>
                  <div className="h-[calc(100%-1rem)] w-[calc(100%-1rem)] max-w-lg animate-pulse rounded-xl bg-slate-800/40" />
                </div>
              )}
              </div>
            </>
          )}
        </div>
      </div>

      <p className="text-[11px] leading-relaxed text-slate-500">
        호가·체결·분봉은 한국투자증권 Open API로 조회한 값이며, HTS·MTS 실시간 창과 시각·가격이 다를 수 있습니다. 투자
        판단 및 주문은 반드시 본인 책임 하에 이용하시기 바랍니다.
      </p>
    </div>
  )
}

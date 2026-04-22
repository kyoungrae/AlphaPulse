import { useCallback, useEffect, useMemo, useState } from 'react'
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

/** 호가·현재가 폴링 주기(ms). 백엔드 `QUOTE_LIVE_CACHE_TTL_MS`(기본 0.8s)보다 길게 두는 것을 권장 */
const QUOTE_POLL_MS = 1000
const INTRADAY_POLL_MS = 20_000

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

function useFetch<T>(url: string) {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true
    setLoading(true)
    setError(null)
    fetch(url)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.text()
          throw new Error(`요청 실패: ${res.status} ${body}`)
        }
        return (await res.json()) as T
      })
      .then((json) => {
        if (mounted) setData(json)
      })
      .catch((err: Error) => {
        if (mounted) setError(err.message)
      })
      .finally(() => {
        if (mounted) setLoading(false)
      })
    return () => {
      mounted = false
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
  const [selected, setSelected] = useState('AAPL')
  const [quote, setQuote] = useState<QuoteLive | null>(null)
  const [quoteLoading, setQuoteLoading] = useState(false)
  const [quoteError, setQuoteError] = useState<string | null>(null)
  const [intraday, setIntraday] = useState<IntradayResponse | null>(null)
  const [intradayLoading, setIntradayLoading] = useState(false)
  const [intradayError, setIntradayError] = useState<string | null>(null)

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 200)
    return () => clearTimeout(timer)
  }, [search])

  useEffect(() => {
    setSelected(market === 'kr' ? '005930.KS' : 'AAPL')
  }, [market])

  const symbolsUrl = useMemo(
    () =>
      apiUrl(
        `/api/symbols?market=${market}&q=${encodeURIComponent(debouncedSearch.trim())}&limit=200`,
      ),
    [debouncedSearch, market],
  )
  const { data: symbols } = useFetch<SymbolResponse>(symbolsUrl)

  const fetchQuote = useCallback(async () => {
    if (!selected.trim()) return
    setQuoteLoading(true)
    setQuoteError(null)
    try {
      const res = await fetch(apiUrl(`/api/quote/${encodeURIComponent(selected)}`))
      const text = await res.text()
      if (!res.ok) {
        throw new Error(text || `HTTP ${res.status}`)
      }
      setQuote(JSON.parse(text) as QuoteLive)
    } catch (e) {
      setQuote(null)
      setQuoteError(e instanceof Error ? e.message : '시세 조회 실패')
    } finally {
      setQuoteLoading(false)
    }
  }, [selected])

  useEffect(() => {
    void fetchQuote()
    const id = window.setInterval(() => void fetchQuote(), QUOTE_POLL_MS)
    return () => window.clearInterval(id)
  }, [fetchQuote])

  const fetchIntraday = useCallback(async () => {
    if (!selected.trim()) return
    setIntradayLoading(true)
    setIntradayError(null)
    try {
      const res = await fetch(apiUrl(`/api/quote/${encodeURIComponent(selected)}/intraday`))
      const text = await res.text()
      if (!res.ok) {
        throw new Error(text || `HTTP ${res.status}`)
      }
      setIntraday(JSON.parse(text) as IntradayResponse)
    } catch (e) {
      setIntraday(null)
      setIntradayError(e instanceof Error ? e.message : '분봉 조회 실패')
    } finally {
      setIntradayLoading(false)
    }
  }, [selected])

  useEffect(() => {
    void fetchIntraday()
    const id = window.setInterval(() => void fetchIntraday(), INTRADAY_POLL_MS)
    return () => window.clearInterval(id)
  }, [fetchIntraday])

  const selectedSymbolInfo = useMemo(
    () => (symbols?.items ?? []).find((item) => item.symbol === selected),
    [symbols, selected],
  )
  const selectedDisplayName = selectedSymbolInfo?.nameKr ?? selectedSymbolInfo?.name ?? selected

  const spread =
    quote?.bid != null && quote?.ask != null && Number.isFinite(quote.bid) && Number.isFinite(quote.ask)
      ? quote.ask - quote.bid
      : null

  const chgPct = quote?.regularMarketChangePercent

  const chartRows = useMemo(() => {
    const base = intraday?.points ?? []
    return mergeIntradayWithLiveQuote(base, quote?.regularMarketPrice, quote?.asOf)
  }, [intraday?.points, quote?.regularMarketPrice, quote?.asOf])

  const chartDomain = useMemo(() => {
    const vals = chartRows.map((r) => r.c).filter((n) => Number.isFinite(n))
    if (!vals.length) return undefined
    const lo = Math.min(...vals)
    const hi = Math.max(...vals)
    const pad = hi > lo ? (hi - lo) * 0.06 : Math.abs(hi) * 0.001 || 0.01
    return [lo - pad, hi + pad] as [number, number]
  }, [chartRows])

  const chartStroke = chgPct != null && Number.isFinite(chgPct) && chgPct < 0 ? '#fb7185' : '#38bdf8'

  return (
    <div className="space-y-4 text-slate-100">
      <div>
        <h2 className="text-2xl font-bold">종목 실시간 현황</h2>
        <p className="text-sm text-slate-400">
          종목을 고르면 호가·현재가는 약 1초마다, 분봉 차트는 약 20초마다 갱신됩니다. 현재가가 반영되면서 곡선 끝이
          함께 움직입니다.
        </p>
      </div>

      <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-4 shadow-lg">
        <div className="mb-2 flex items-center justify-end">
          <div className="flex items-center gap-1 rounded-full bg-slate-950/80 p-1">
            <button
              type="button"
              onClick={() => setMarket('us')}
              className={`rounded-full px-2 py-1 text-[11px] font-semibold ${
                market === 'us' ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-slate-800'
              }`}
            >
              미국
            </button>
            <button
              type="button"
              onClick={() => setMarket('kr')}
              className={`rounded-full px-2 py-1 text-[11px] font-semibold ${
                market === 'kr' ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-slate-800'
              }`}
            >
              한국
            </button>
          </div>
        </div>
        <label className="mb-1 block text-xs uppercase tracking-[0.2em] text-blue-300">종목 검색</label>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={market === 'kr' ? '종목코드 또는 기업명' : '티커 또는 기업명'}
          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-blue-400"
        />
        <div className="mt-2 flex flex-wrap gap-2">
          {(symbols?.items ?? []).map((item) => (
            <button
              key={item.symbol}
              type="button"
              onClick={() => setSelected(item.symbol)}
              title={item.symbol}
              className={`rounded-full px-3 py-1 text-xs font-semibold ${
                item.symbol === selected
                  ? 'bg-blue-600 text-white'
                  : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
              }`}
            >
              {item.nameKr ?? item.name}
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-4 shadow-lg">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3 className="text-lg font-semibold text-white">{selectedDisplayName}</h3>
            <p className="text-xs text-slate-500">{selected}</p>
            {quote?.shortName && <p className="mt-0.5 text-xs text-slate-400">{quote.shortName}</p>}
          </div>
          <div className="text-right text-xs text-slate-500">
            {(quote?.asOf || quoteLoading) && (
              <p
                className="mt-1 flex items-center justify-end gap-1.5 tabular-nums text-slate-500"
                {...(quoteLoading ? { role: 'status', 'aria-live': 'polite' as const } : {})}
              >
                {quoteLoading && <QuoteRefreshSpinner />}
                {quote?.asOf ? (
                  <span>기준: {new Date(quote.asOf).toLocaleString('ko-KR')}</span>
                ) : (
                  <span>시세 불러오는 중</span>
                )}
              </p>
            )}
          </div>
        </div>

        {quoteError && <p className="mb-3 text-sm text-rose-400">{quoteError}</p>}

        {!quote && !quoteError && quoteLoading && (
          <div className="h-32 animate-pulse rounded-xl bg-slate-800/60" aria-hidden />
        )}

        {quote && (
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-xl border border-rose-900/40 bg-rose-950/20 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-rose-300">매도 호가 (Ask)</p>
              <p className="mt-2 text-2xl font-bold tabular-nums text-white">
                {formatPrice(quote.ask, market)}
              </p>
              <p className="mt-1 text-xs text-slate-400">
                물량: {quote.askSize != null ? quote.askSize.toLocaleString('ko-KR') : '—'}
              </p>
            </div>
            <div className="rounded-xl border border-emerald-900/40 bg-emerald-950/20 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-emerald-300">매수 호가 (Bid)</p>
              <p className="mt-2 text-2xl font-bold tabular-nums text-white">
                {formatPrice(quote.bid, market)}
              </p>
              <p className="mt-1 text-xs text-slate-400">
                물량: {quote.bidSize != null ? quote.bidSize.toLocaleString('ko-KR') : '—'}
              </p>
            </div>
          </div>
        )}

        {quote && (
          <div className="mt-4 grid gap-3 rounded-xl border border-slate-800 bg-slate-950/50 p-4 text-sm text-slate-300 md:grid-cols-2">
            <div>
              <p className="text-xs text-slate-500">현재가 (정규장)</p>
              <p className="mt-1 text-xl font-semibold tabular-nums text-white">
                {formatPrice(quote.regularMarketPrice, market)}
              </p>
              <p className="mt-1 text-xs">
                {chgPct != null && Number.isFinite(chgPct) ? (
                  <span className={chgPct >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                    {chgPct >= 0 ? '+' : ''}
                    {chgPct.toFixed(2)}%
                  </span>
                ) : (
                  <span className="text-slate-500">변동률 —</span>
                )}
                {quote.regularMarketChange != null && Number.isFinite(quote.regularMarketChange) && (
                  <span className="ml-2 text-slate-400">
                    (
                    {quote.regularMarketChange >= 0 ? '+' : ''}
                    {market === 'kr'
                      ? `${Math.round(quote.regularMarketChange).toLocaleString('ko-KR')}원`
                      : `$${quote.regularMarketChange.toLocaleString('en-US', { maximumFractionDigits: 2 })}`}
                    )
                  </span>
                )}
              </p>
            </div>
            <div>
              <p className="text-xs text-slate-500">스프레드 (Ask − Bid)</p>
              <p className="mt-1 text-xl font-semibold tabular-nums text-white">
                {spread != null && Number.isFinite(spread) ? formatPrice(spread, market) : '—'}
              </p>
            </div>
            <div>
              <p className="text-xs text-slate-500">시가 · 고가 · 저가</p>
              <p className="mt-1 tabular-nums">
                {formatPrice(quote.regularMarketOpen, market)} · {formatPrice(quote.regularMarketDayHigh, market)} ·{' '}
                {formatPrice(quote.regularMarketDayLow, market)}
              </p>
            </div>
            <div>
              <p className="text-xs text-slate-500">거래량 · 장 상태</p>
              <p className="mt-1">
                {formatVolume(quote.regularMarketVolume)} · {marketStateLabel(quote.marketState)}
              </p>
              <p className="mt-0.5 text-[11px] text-slate-500">
                {quote.fullExchangeName ?? ''}
                {quote.exchangeTimezoneName ? ` · ${quote.exchangeTimezoneName}` : ''}
              </p>
            </div>
          </div>
        )}

        {quote && quote.bid == null && quote.ask == null && (
          <p className="mt-3 text-xs text-amber-200/90">
            이 종목은 호가 단위 데이터가 제공되지 않습니다. 현재가·거래량만 참고하세요.
          </p>
        )}

        <div className="mt-6 border-t border-slate-800 pt-4">
          <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">당일 분봉 (1분)</p>
              {intraday?.sessionDate && (
                <p className="mt-0.5 text-[11px] text-slate-500">
                  세션 기준일 {intraday.sessionDate}
                  {intraday.timezone ? ` · ${intraday.timezone}` : ''}
                </p>
              )}
            </div>
            {intradayLoading && <span className="text-[11px] text-slate-500">차트 갱신 중…</span>}
          </div>
          {intradayError && <p className="mb-2 text-sm text-rose-400">{intradayError}</p>}
          {!intradayLoading && !intradayError && chartRows.length === 0 && (
            <p className="py-8 text-center text-sm text-slate-500">
              {intraday?.note ??
                '표시할 분봉이 없습니다. 장 마감 후이거나 데이터 제공이 제한된 종목일 수 있습니다.'}
            </p>
          )}
          {chartRows.length > 0 && (
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartRows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="livePriceFill" x1="0" y1="0" x2="0" y2="1">
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
                    fill="url(#livePriceFill)"
                    isAnimationActive={false}
                    dot={false}
                    activeDot={{ r: 3, fill: chartStroke }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
          {intradayLoading && chartRows.length === 0 && !intradayError && (
            <div className="h-64 animate-pulse rounded-xl bg-slate-800/50" aria-hidden />
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

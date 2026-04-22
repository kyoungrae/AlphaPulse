import { useCallback, useEffect, useMemo, useState } from 'react'
import { apiUrl } from '../apiBase'

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
    const id = window.setInterval(() => void fetchQuote(), 10_000)
    return () => window.clearInterval(id)
  }, [fetchQuote])

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

  return (
    <div className="space-y-4 text-slate-100">
      <div>
        <h2 className="text-2xl font-bold">종목 실시간 현황</h2>
        <p className="text-sm text-slate-400">
          종목을 고르면 최우선 매도·매수 호가와 현재가 등이 약 10초 간격으로 갱신됩니다.
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
            {quoteLoading && <span className="text-slate-400">갱신 중…</span>}
            {quote?.asOf && (
              <p className="mt-1 tabular-nums text-slate-500">
                기준: {new Date(quote.asOf).toLocaleString('ko-KR')}
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
      </div>

      <p className="text-[11px] leading-relaxed text-slate-500">
        호가·체결 정보는 제3자(야후 파이낸스) 지연 시세이며, 증권사 실시간 주문창과 다를 수 있습니다. 투자 판단 및 주문은 반드시 본인 책임 하에 이용하시기 바랍니다.
      </p>
    </div>
  )
}

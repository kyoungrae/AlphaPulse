import { useEffect, useMemo, useState } from 'react'
import {
  ComposedChart,
  Line,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  useXAxisScale,
  useYAxisScale,
} from 'recharts'

type CandlePoint = {
  date: string
  open: number
  high: number
  low: number
  close: number
}

type NewsItem = {
  title: string
  source?: string
  sentiment?: {
    label: string
    score: number
  }
}

type PredictResponse = {
  ticker: string
  probability_up: number
  direction: string
  last_date: string
  last_close: number
  cv_accuracy: number
  cv_precision: number
  model_trained_at: string
  reason_summary: string
  top_feature_importance: { feature: string; importance: number }[]
  data_years?: number
}

type SymbolItem = {
  symbol: string
  name: string
  nameKr?: string
}

type SymbolResponse = {
  market?: 'us' | 'kr'
  total: number
  items: SymbolItem[]
}

type HistoryItem = {
  ticker: string
  predictionDate: string
  predictedDirection: 'Up' | 'Down'
  probabilityUp: number
  probabilityDelta: number | null
  directionChanged: boolean
  actualDirection: 'Up' | 'Down' | null
  actualDate: string | null
  isCorrect: boolean | null
}

type HistoryResponse = {
  ticker: string
  items: HistoryItem[]
}

type FxResponse = {
  base: string
  quote: string
  rate: number
  asOf: string
}

type DirectionItem = {
  symbol: string
  direction: 'Up' | 'Down' | null
  probabilityUp: number | null
  source: 'cache' | 'none'
}

type DirectionsResponse = {
  items: DirectionItem[]
}

type StrategyMode = 'long_only' | 'long_short' | 'swing' | 'intraday'

type BacktestMetrics = {
  totalReturn: number
  cagr: number
  maxDrawdown: number
  sharpe: number
  winRate: number
  avgWinLossRatio: number | null
  tradeCount: number
}

type BacktestResult = {
  ticker: string
  strategy: StrategyMode
  metrics: BacktestMetrics
  latestSignal: {
    date: string
    action: 'buy' | 'sell' | 'short' | 'cover' | 'hold'
    probabilityUp: number
  } | null
}

type GuidanceResponse = {
  ticker: string
  market: 'us' | 'kr'
  strategy: StrategyMode
  backtestRange: { from: string; to: string }
  signal: {
    date: string
    action: 'buy' | 'sell' | 'short' | 'cover' | 'hold'
    probabilityUp: number
  } | null
  referenceBar: { date: string; open: number; close: number }
  actionSummary: string
  historical: {
    tradeCount: number
    avgWinNetReturn: number | null
    avgLossNetReturn: number | null
    medianHoldingDays: number | null
    medianHoldingDaysWinners: number | null
  }
  scenario: {
    notional: number
    currency: 'USD' | 'KRW'
    profitIfAvgWin: number | null
    lossIfAvgLoss: number | null
  }
  disclaimer: string[]
}

function directionToKorean(direction: string) {
  if (direction === 'Up') return '상승'
  if (direction === 'Down') return '하락'
  return direction
}

function signalActionToKorean(action: string) {
  const m: Record<string, string> = {
    buy: '매수 후보',
    sell: '매도 후보',
    short: '공매도 후보',
    cover: '공매도 청산 후보',
    hold: '관망',
  }
  return m[action] ?? action
}

type ChartRow = {
  date: string
  tooltipLabel: string
  open: number
  high: number
  low: number
  close: number
  sma20: number | null
  bbUpper: number | null
  bbLower: number | null
}

function CandlestickSeries({ data }: { data: ChartRow[] }) {
  const xScale = useXAxisScale(0)
  const yScale = useYAxisScale(0)
  if (!xScale || !yScale || data.length === 0) return null

  return (
    <g className="recharts-candlesticks" aria-hidden>
      {data.map((d, i) => {
        const xMid = xScale(d.date, { position: 'middle' })
        const xStart = xScale(d.date, { position: 'start' })
        const xEnd = xScale(d.date, { position: 'end' })
        if (xMid == null || xStart == null || xEnd == null) return null
        const band = Math.max(2, xEnd - xStart)
        const bodyW = Math.min(12, band * 0.65)
        const yo = yScale(d.open)
        const yc = yScale(d.close)
        const yh = yScale(d.high)
        const yl = yScale(d.low)
        if (yo == null || yc == null || yh == null || yl == null) return null
        const top = Math.min(yo, yc)
        const bottom = Math.max(yo, yc)
        const isUp = d.close >= d.open
        const stroke = isUp ? '#34d399' : '#fb7185'
        const fill = isUp ? '#059669' : '#e11d48'
        return (
          <g key={`${d.date}-${i}`}>
            <line x1={xMid} x2={xMid} y1={yh} y2={yl} stroke={stroke} strokeWidth={1} />
            <rect
              x={xMid - bodyW / 2}
              y={top}
              width={bodyW}
              height={Math.max(1, bottom - top)}
              fill={fill}
              stroke={stroke}
              strokeWidth={1}
            />
          </g>
        )
      })}
    </g>
  )
}

function StockChartTooltip({
  active,
  payload,
  priceCurrency,
}: {
  active?: boolean
  payload?: ReadonlyArray<{ payload?: ChartRow }>
  priceCurrency: DisplayCurrency
}) {
  if (!active || !payload?.length) return null
  const row = payload[0].payload
  if (!row) return null
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs shadow-lg" style={{ color: '#e5e7eb' }}>
      <p className="font-medium text-slate-100">{row.tooltipLabel}</p>
      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
        <span className="text-slate-500">시가</span>
        <span className="text-right tabular-nums">{formatMoney(row.open, priceCurrency)}</span>
        <span className="text-slate-500">고가</span>
        <span className="text-right tabular-nums">{formatMoney(row.high, priceCurrency)}</span>
        <span className="text-slate-500">저가</span>
        <span className="text-right tabular-nums">{formatMoney(row.low, priceCurrency)}</span>
        <span className="text-slate-500">종가</span>
        <span className="text-right tabular-nums">{formatMoney(row.close, priceCurrency)}</span>
        {row.sma20 != null && (
          <>
            <span className="text-slate-500">SMA20</span>
            <span className="text-right tabular-nums">{formatMoney(row.sma20, priceCurrency)}</span>
          </>
        )}
        {row.bbUpper != null && row.bbLower != null && (
          <>
            <span className="text-slate-500">볼린저</span>
            <span className="text-right tabular-nums text-[10px] leading-tight">
              {formatMoney(row.bbUpper, priceCurrency)} ~ {formatMoney(row.bbLower, priceCurrency)}
            </span>
          </>
        )}
      </div>
    </div>
  )
}

type NativeCurrency = 'usd' | 'krw'
type DisplayCurrency = 'usd' | 'krw'

function convertPrice(
  value: number,
  from: NativeCurrency,
  to: DisplayCurrency,
  usdKrwRate: number | undefined,
): number {
  if (from === to) return value
  if (!usdKrwRate || usdKrwRate <= 0) return value
  if (from === 'usd' && to === 'krw') return value * usdKrwRate
  return value / usdKrwRate
}

function formatMoney(amount: number, currency: DisplayCurrency) {
  if (currency === 'krw') {
    return `₩${Math.round(amount).toLocaleString('ko-KR')}`
  }
  return `$${amount.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`
}

function MetricTooltip({
  label,
  tip,
}: {
  label: string
  tip: string
}) {
  return (
    <span className="group relative inline-flex items-center gap-1">
      <span>{label}</span>
      <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-slate-800 text-[10px] text-slate-300">
        ?
      </span>
      <span className="pointer-events-none absolute left-0 top-5 z-20 hidden w-64 rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] leading-relaxed text-slate-200 group-hover:block">
        {tip}
      </span>
    </span>
  )
}

function useFetch<T>(url: string) {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!url) {
      setData(null)
      setLoading(false)
      setError(null)
      return
    }
    let mounted = true
    setLoading(true)
    fetch(url)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.text()
          throw new Error(`요청 실패: ${res.status} ${body}`)
        }
        const ctype = res.headers.get('content-type') ?? ''
        if (ctype.includes('application/json')) {
          const json = (await res.json()) as T
          if (mounted) setData(json)
        } else {
          const text = await res.text()
          throw new Error(`JSON이 아닌 응답입니다: ${text.slice(0, 200)}`)
        }
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

export default function Dashboard() {
  const [symbolQuery, setSymbolQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [market, setMarket] = useState<'us' | 'kr'>('us')
  const [selectedSymbol, setSelectedSymbol] = useState('AAPL')
  const [timeframe, setTimeframe] = useState<'year' | 'month' | 'day' | 'hour'>('month')
  const [priceCurrency, setPriceCurrency] = useState<DisplayCurrency>('usd')
  const [strategy, setStrategy] = useState<StrategyMode>('long_only')
  const [notionalInput, setNotionalInput] = useState('10000')

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(symbolQuery), 200)
    return () => clearTimeout(timer)
  }, [symbolQuery])

  const symbolsUrl = useMemo(() => {
    const q = encodeURIComponent(debouncedQuery.trim())
    return `/api/symbols?market=${market}&q=${q}&limit=40`
  }, [debouncedQuery, market])

  useEffect(() => {
    setSelectedSymbol(market === 'kr' ? '005930.KS' : 'AAPL')
  }, [market])

  useEffect(() => {
    setPriceCurrency(market === 'kr' ? 'krw' : 'usd')
  }, [market])

  useEffect(() => {
    setNotionalInput(market === 'kr' ? '10000000' : '10000')
  }, [market])

  const nativeCurrency: NativeCurrency = market === 'kr' ? 'krw' : 'usd'

  const defaultGuidanceNotional = market === 'kr' ? 10_000_000 : 10_000
  const guidanceNotional = useMemo(() => {
    const raw = notionalInput.replace(/,/g, '').trim()
    const n = Number(raw)
    return Number.isFinite(n) && n > 0 ? n : defaultGuidanceNotional
  }, [notionalInput, defaultGuidanceNotional])

  const guidanceUrl = useMemo(
    () =>
      `/api/guidance/${encodeURIComponent(selectedSymbol)}?market=${market}&strategy=${strategy}&notional=${guidanceNotional}`,
    [selectedSymbol, market, strategy, guidanceNotional],
  )

  const {
    data: guidance,
    loading: guidanceLoading,
    error: guidanceError,
  } = useFetch<GuidanceResponse>(guidanceUrl)

  const {
    data: symbols,
    loading: symbolsLoading,
    error: symbolsError,
  } = useFetch<SymbolResponse>(symbolsUrl)

  const {
    data: stock,
    loading: stockLoading,
    error: stockError,
  } = useFetch<CandlePoint[]>(
    `/api/stock/${encodeURIComponent(selectedSymbol)}?timeframe=${encodeURIComponent(timeframe)}`,
  )
  const {
    data: news,
    loading: newsLoading,
    error: newsError,
  } = useFetch<NewsItem[]>('/api/news')
  const {
    data: predict,
    loading: predictLoading,
    error: predictError,
  } = useFetch<PredictResponse>(`/api/predict/${encodeURIComponent(selectedSymbol)}`)
  const {
    data: history,
    loading: historyLoading,
    error: historyError,
  } = useFetch<HistoryResponse>(`/api/predictions/history/${encodeURIComponent(selectedSymbol)}?limit=10`)
  const {
    data: backtest,
    loading: backtestLoading,
    error: backtestError,
  } = useFetch<BacktestResult>(
    `/api/backtest/${encodeURIComponent(selectedSymbol)}?market=${market}&strategy=${strategy}`,
  )
  const { data: fxData } = useFetch<FxResponse>('/api/fx/usd-krw')
  const topSymbolsCsv = useMemo(
    () =>
      (symbols?.items ?? [])
        .slice(0, 40)
        .map((item) => item.symbol)
        .join(','),
    [symbols],
  )
  const directionsUrl = useMemo(() => {
    if (!topSymbolsCsv) return ''
    return `/api/predict/directions?symbols=${encodeURIComponent(topSymbolsCsv)}`
  }, [topSymbolsCsv])
  const { data: directions } = useFetch<DirectionsResponse>(directionsUrl)

  const chartData = useMemo((): ChartRow[] => {
    if (!stock || stock.length === 0) return []

    const rate = fxData?.rate
    const toDisplay = (v: number) => convertPrice(v, nativeCurrency, priceCurrency, rate)

    const closes = stock.map((s) => s.close)
    const result = stock.map((pt, idx) => {
      const dt = new Date(pt.date)
      let date = dt.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' })
      let tooltipLabel = dt.toLocaleString('ko-KR', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
      if (timeframe === 'year') {
        date = dt.toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit' })
        tooltipLabel = dt.toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' })
      } else if (timeframe === 'day') {
        date = dt.toLocaleDateString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit' })
        tooltipLabel = dt.toLocaleString('ko-KR', {
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        })
      } else if (timeframe === 'hour') {
        date = dt.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
        tooltipLabel = dt.toLocaleTimeString('ko-KR', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        })
      }
      const close = pt.close
      const open = pt.open
      const high = pt.high
      const low = pt.low
      let sma20: number | null = null
      let bbUpper: number | null = null
      let bbLower: number | null = null

      if (idx >= 19) {
        const window = closes.slice(idx - 19, idx + 1)
        const mean = window.reduce((a, b) => a + b, 0) / window.length
        const variance = window.reduce((a, b) => a + (b - mean) ** 2, 0) / window.length
        const std = Math.sqrt(variance)
        sma20 = mean
        bbUpper = mean + 2 * std
        bbLower = mean - 2 * std
      }

      return {
        date,
        tooltipLabel,
        open: toDisplay(open),
        high: toDisplay(high),
        low: toDisplay(low),
        close: toDisplay(close),
        sma20: sma20 != null ? toDisplay(sma20) : null,
        bbUpper: bbUpper != null ? toDisplay(bbUpper) : null,
        bbLower: bbLower != null ? toDisplay(bbLower) : null,
      }
    })
    return result
  }, [stock, timeframe, nativeCurrency, priceCurrency, fxData?.rate])

  const chartYDomain = useMemo((): [number, number] | undefined => {
    if (!chartData.length) return undefined
    const lows = chartData.map((d) => d.low)
    const highs = chartData.map((d) => d.high)
    const min = Math.min(...lows)
    const max = Math.max(...highs)
    const pad = Math.max((max - min) * 0.03, Math.abs(max) * 0.001 || 0.01)
    return [min - pad, max + pad]
  }, [chartData])

  const latestHistory = history?.items?.[0] ?? null
  const previousHistory = history?.items?.[1] ?? null
  const selectedSymbolInfo = useMemo(
    () => (symbols?.items ?? []).find((item) => item.symbol === selectedSymbol),
    [symbols, selectedSymbol],
  )
  const selectedDisplayName = selectedSymbolInfo?.nameKr ?? selectedSymbolInfo?.name ?? selectedSymbol
  const displayPredictClose = useMemo(() => {
    if (!predict) return null
    return convertPrice(predict.last_close, nativeCurrency, priceCurrency, fxData?.rate)
  }, [predict, nativeCurrency, priceCurrency, fxData?.rate])
  const directionMap = useMemo(
    () => new Map((directions?.items ?? []).map((item) => [item.symbol, item.direction])),
    [directions],
  )
  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-blue-300">대시보드</p>
        <h2 className="text-2xl font-bold text-white">S&amp;P500 종목 대시보드</h2>
        <p className="text-sm text-slate-400">전체 종목을 검색하고 선택한 종목만 상세 조회합니다.</p>
      </div>

      <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-4 shadow-lg">
        <div className="grid gap-3 lg:grid-cols-[2fr_1fr]">
          <div>
            <div className="mb-2 flex items-center justify-between">
              <label className="block text-xs uppercase tracking-[0.2em] text-blue-300">종목 검색</label>
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
            <input
              value={symbolQuery}
              onChange={(e) => setSymbolQuery(e.target.value)}
              placeholder={market === 'kr' ? '종목코드 또는 기업명 입력 (예: 005930.KS, 삼성전자)' : '티커 또는 기업명 입력 (예: AAPL, Microsoft)'}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-blue-400"
            />
            <div className="mt-2 flex max-h-36 flex-wrap gap-2 overflow-y-auto pr-1">
              {(symbols?.items ?? []).map((item) => (
                <button
                  key={item.symbol}
                  type="button"
                  onClick={() => setSelectedSymbol(item.symbol)}
                  data-direction={directionMap.get(item.symbol) ?? 'none'}
                  className={`rounded-full px-3 py-1 text-xs font-semibold ${
                    selectedSymbol === item.symbol
                      ? 'bg-blue-600 text-white'
                      : directionMap.get(item.symbol) === 'Up'
                        ? 'bg-emerald-900/50 text-emerald-300 hover:bg-emerald-800/60'
                        : directionMap.get(item.symbol) === 'Down'
                          ? 'bg-rose-900/50 text-rose-300 hover:bg-rose-800/60'
                          : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                  }`}
                  title={item.symbol}
                >
                  {item.nameKr ?? item.name}
                </button>
              ))}
              {symbolsLoading && <span className="text-xs text-slate-500">목록 불러오는 중...</span>}
              {symbolsError && <span className="text-xs text-rose-400">오류: {symbolsError}</span>}
            </div>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-sm text-slate-300">
            <p className="text-xs uppercase tracking-[0.2em] text-blue-300">현재 선택</p>
            <p className="mt-1 text-xl font-bold text-white">{selectedDisplayName}</p>
            <p className="mt-1 text-xs text-slate-500">{selectedSymbol}</p>
            <p className="mt-2 text-xs text-slate-400">
              목록 크기: {symbols?.total ?? 0}개 (상세 데이터는 선택 종목만 조회)
            </p>
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-4 shadow-lg">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-blue-300">수익 참고 안내</p>
            <p className="mt-1 text-sm font-semibold text-white">{selectedDisplayName} · 과거 백테스트 기준</p>
            <p className="mt-1 text-xs text-slate-400">
              전략별로 신호·백테스트 규칙이 다릅니다. 아래에서 전략을 바꾸면 안내가 함께 갱신됩니다(다음 거래일 시가 체결 가정).
            </p>
            <div className="mt-3 flex flex-wrap gap-1">
              {([
                { key: 'long_only', label: '롱' },
                { key: 'long_short', label: '롱/숏' },
                { key: 'swing', label: '스윙' },
                { key: 'intraday', label: '단타' },
              ] as const).map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setStrategy(item.key)}
                  className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                    strategy === item.key ? 'bg-blue-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
          {guidanceLoading && (
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-600 border-t-transparent" />
          )}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <label className="text-xs text-slate-400">
            시뮬레이션 금액 ({market === 'kr' ? '원' : 'USD'})
            <input
              type="text"
              inputMode="numeric"
              value={notionalInput}
              onChange={(e) => setNotionalInput(e.target.value.replace(/[^\d]/g, ''))}
              className="ml-2 inline-block w-36 rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-100 outline-none focus:border-blue-400"
            />
          </label>
          <MetricTooltip
            label="금액 안내"
            tip="과거 승리·패배 거래의 평균 순익률을 이 금액에 곱한 참고 손익입니다. 실제 거래는 시장 상황에 따라 크게 달라집니다."
          />
        </div>

        {guidanceError && (
          <p className="mt-3 text-xs text-rose-400">안내를 불러오지 못했습니다: {guidanceError}</p>
        )}

        {guidanceLoading && !guidance && (
          <div className="mt-4 h-36 rounded-xl bg-slate-800/60 animate-pulse" />
        )}

        {!guidanceLoading && guidance && (
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-sm text-slate-300">
              <p className="text-xs font-semibold text-slate-200">지금 신호가 의미하는 것</p>
              <p className="mt-2">
                신호 기준일: <span className="text-slate-100">{guidance.signal?.date ?? '—'}</span>
              </p>
              <p className="mt-1">
                전략 신호:{' '}
                <span className="font-medium text-amber-200">
                  {guidance.signal ? signalActionToKorean(guidance.signal.action) : '—'}
                </span>
                {' · '}
                모델 상승확률 {(guidance.signal ? guidance.signal.probabilityUp * 100 : 0).toFixed(1)}%
              </p>
              <p className="mt-2 text-xs leading-relaxed text-slate-400">{guidance.actionSummary}</p>
              <p className="mt-3 text-xs text-slate-500">
                직전 봉 종가(참고, {guidance.referenceBar.date}):{' '}
                <span className="tabular-nums text-slate-200">
                  {formatMoney(
                    convertPrice(guidance.referenceBar.close, nativeCurrency, priceCurrency, fxData?.rate),
                    priceCurrency,
                  )}
                </span>
                <span className="ml-2 text-slate-500">
                  시가{' '}
                  {formatMoney(
                    convertPrice(guidance.referenceBar.open, nativeCurrency, priceCurrency, fxData?.rate),
                    priceCurrency,
                  )}
                </span>
              </p>
            </div>

            <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-sm text-slate-300">
              <p className="text-xs font-semibold text-slate-200">과거 동일 전략 거래 요약</p>
              <p className="mt-2">
                구간: {guidance.backtestRange.from} ~ {guidance.backtestRange.to}
              </p>
              <p className="mt-1">완료 거래: {guidance.historical.tradeCount}건</p>
              <p className="mt-1">
                승리 거래 평균 순익률:{' '}
                {guidance.historical.avgWinNetReturn != null
                  ? `${(guidance.historical.avgWinNetReturn * 100).toFixed(2)}%`
                  : '—'}
              </p>
              <p className="mt-1">
                패배 거래 평균 순익률:{' '}
                {guidance.historical.avgLossNetReturn != null
                  ? `${(guidance.historical.avgLossNetReturn * 100).toFixed(2)}%`
                  : '—'}
              </p>
              <p className="mt-1">
                보유일(중앙값):{' '}
                {guidance.historical.medianHoldingDays != null
                  ? `${guidance.historical.medianHoldingDays.toFixed(1)}일`
                  : '—'}
                {guidance.historical.medianHoldingDaysWinners != null && (
                  <span className="text-slate-500">
                    {' '}
                    · 승리 거래 중앙값 {guidance.historical.medianHoldingDaysWinners.toFixed(1)}일
                  </span>
                )}
              </p>
            </div>

            <div className="lg:col-span-2 rounded-xl border border-emerald-900/40 bg-emerald-950/20 p-3 text-sm text-slate-200">
              <p className="text-xs font-semibold text-emerald-200/90">
                입력 금액 {formatMoney(convertPrice(guidanceNotional, nativeCurrency, priceCurrency, fxData?.rate), priceCurrency)} 기준 참고 손익
              </p>
              <p className="mt-2 flex flex-wrap gap-x-8 gap-y-2">
                <span>
                  평균 승리 시(과거 승자 순익률 × 금액):{' '}
                  <span className="font-semibold text-emerald-300">
                    {guidance.scenario.profitIfAvgWin != null
                      ? formatMoney(
                          convertPrice(guidance.scenario.profitIfAvgWin, nativeCurrency, priceCurrency, fxData?.rate),
                          priceCurrency,
                        )
                      : '—'}
                  </span>
                </span>
                <span>
                  평균 패배 시:{' '}
                  <span className="font-semibold text-rose-300">
                    {guidance.scenario.lossIfAvgLoss != null
                      ? formatMoney(
                          convertPrice(guidance.scenario.lossIfAvgLoss, nativeCurrency, priceCurrency, fxData?.rate),
                          priceCurrency,
                        )
                      : '—'}
                  </span>
                </span>
              </p>
            </div>
          </div>
        )}

        {guidance && (
          <ul className="mt-4 list-disc space-y-1 pl-4 text-[11px] text-slate-500">
            {guidance.disclaimer.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-4 shadow-lg">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-blue-300">AI 예측</p>
              <p className="text-sm font-semibold text-white">{selectedDisplayName} 예측</p>
            </div>
            {predictLoading && (
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-600 border-t-transparent" />
            )}
            {predictError && <span className="text-xs text-rose-400">오류</span>}
          </div>
          {predictLoading ? (
            <div className="mt-4 h-24 rounded-xl bg-slate-800/60 animate-pulse" />
          ) : predict ? (
            <div className="mt-4 space-y-2">
              <div className="flex items-center justify-between text-sm text-slate-300">
                <span>최신 날짜</span>
                <span>{predict.last_date}</span>
              </div>
              <div className="flex items-center justify-between gap-2 text-sm text-slate-300">
                <span>최신 종가</span>
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-0.5 rounded-full bg-slate-950/80 p-0.5">
                    <button
                      type="button"
                      onClick={() => setPriceCurrency('usd')}
                      className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                        priceCurrency === 'usd' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:bg-slate-800'
                      }`}
                      aria-pressed={priceCurrency === 'usd'}
                    >
                      $
                    </button>
                    <button
                      type="button"
                      onClick={() => setPriceCurrency('krw')}
                      className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                        priceCurrency === 'krw' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:bg-slate-800'
                      }`}
                      aria-pressed={priceCurrency === 'krw'}
                    >
                      ₩
                    </button>
                  </div>
                  <span className="tabular-nums font-medium text-slate-100">
                    {displayPredictClose != null ? formatMoney(displayPredictClose, priceCurrency) : '—'}
                  </span>
                </div>
              </div>
              {fxData?.rate && nativeCurrency !== priceCurrency && (
                <div className="text-right text-[11px] text-slate-500">
                  환율 기준: 1 USD = {fxData.rate.toLocaleString('ko-KR', { maximumFractionDigits: 2 })} KRW
                </div>
              )}
              <div className="flex items-center justify-between">
                <span className="text-slate-200">예상 방향</span>
                <span
                  className={`rounded-full px-3 py-1 text-sm font-semibold ${
                    predict.direction === 'Up' ? 'bg-emerald-900/60 text-emerald-300' : 'bg-rose-900/60 text-rose-300'
                  }`}
                >
                  {directionToKorean(predict.direction)}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-200">상승 확률</span>
                <span
                  className={`text-lg font-bold ${
                    predict.probability_up >= 0.5 ? 'text-emerald-400' : 'text-rose-400'
                  }`}
                >
                  {(predict.probability_up * 100).toFixed(1)}%
                </span>
              </div>
              <div className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-xs text-slate-300">
                <p className="mb-1 font-semibold text-slate-200">모델 검증 지표</p>
                <p>시계열 교차검증 정확도: {(predict.cv_accuracy * 100).toFixed(1)}%</p>
                <p>시계열 교차검증 정밀도: {(predict.cv_precision * 100).toFixed(1)}%</p>
                <p>학습 기반 데이터 기간: 최소 {predict.data_years ?? 10}년</p>
                <p className="mt-1 text-slate-400">모델 학습 시각: {predict.model_trained_at}</p>
              </div>
              <div className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-xs text-slate-300">
                <div className="mb-2 flex flex-wrap items-center gap-1">
                  {([
                    { key: 'long_only', label: '롱' },
                    { key: 'long_short', label: '롱/숏' },
                    { key: 'swing', label: '스윙' },
                    { key: 'intraday', label: '단타' },
                  ] as const).map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      onClick={() => setStrategy(item.key)}
                      className={`rounded-full px-2 py-0.5 ${
                        strategy === item.key
                          ? 'bg-blue-600 text-white'
                          : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                      }`}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
                {backtestLoading ? (
                  <p className="text-slate-400">전략 수익 예측 계산 중...</p>
                ) : backtestError ? (
                  <p className="text-rose-300">백테스트 오류: {backtestError}</p>
                ) : backtest ? (
                  <div className="space-y-1">
                    <p>
                      <MetricTooltip
                        label={`총수익률: ${(backtest.metrics.totalReturn * 100).toFixed(2)}%`}
                        tip="백테스트 전체 기간 누적 수익률입니다. 높을수록 좋지만, 기간이 길수록 CAGR도 같이 보세요."
                      />
                    </p>
                    <p>
                      <MetricTooltip
                        label={`CAGR: ${(backtest.metrics.cagr * 100).toFixed(2)}%`}
                        tip="연평균 복리 수익률입니다. 기간이 달라도 비교하기 쉬운 핵심 지표입니다."
                      />
                    </p>
                    <p>
                      <MetricTooltip
                        label={`최대낙폭(MDD): ${(backtest.metrics.maxDrawdown * 100).toFixed(2)}%`}
                        tip="고점 대비 최대 손실 폭입니다. 초보자는 수익보다 MDD를 먼저 체크하면 리스크 관리에 도움이 됩니다."
                      />
                    </p>
                    <p>
                      <MetricTooltip
                        label={`샤프지수: ${backtest.metrics.sharpe.toFixed(2)}`}
                        tip="변동성 대비 수익 효율입니다. 일반적으로 높을수록 좋고 1 이상이면 양호, 2 이상이면 우수로 해석합니다."
                      />
                    </p>
                    <p>
                      <MetricTooltip
                        label={`승률: ${(backtest.metrics.winRate * 100).toFixed(1)}%`}
                        tip="이긴 거래 비율입니다. 승률이 낮아도 손익비가 좋으면 전체 수익은 플러스가 될 수 있습니다."
                      />
                    </p>
                    <p>
                      <MetricTooltip
                        label={`신호: ${backtest.latestSignal?.action ?? 'hold'} / 확률 ${
                          backtest.latestSignal
                            ? `${(backtest.latestSignal.probabilityUp * 100).toFixed(1)}%`
                            : '-'
                        }`}
                        tip="buy/short는 진입 후보, sell/cover는 청산 후보, hold는 관망 의미입니다. 확률이 임계값을 넘는지 함께 확인하세요."
                      />
                    </p>
                  </div>
                ) : (
                  <p className="text-slate-400">전략 요약 데이터가 없습니다.</p>
                )}
              </div>
              <div className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-xs text-slate-300">
                <p className="mb-1 font-semibold text-slate-200">예측 근거(상위 중요도)</p>
                {predict.top_feature_importance?.map((item) => (
                  <div key={item.feature} className="flex items-center justify-between">
                    <span>{item.feature}</span>
                    <span>{(item.importance * 100).toFixed(1)}%</span>
                  </div>
                ))}
                <p className="mt-2 text-slate-400">{predict.reason_summary}</p>
              </div>
            </div>
          ) : (
            <div className="mt-4 text-sm text-slate-400">예측 데이터가 없습니다.</div>
          )}
        </div>

        <div className="lg:col-span-2 rounded-2xl border border-slate-800 bg-slate-900/80 p-4 shadow-lg">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <h3 className="text-lg font-semibold text-white">{selectedDisplayName} 종가 + 지표</h3>
              {stockLoading && <span className="text-xs text-slate-400">불러오는 중...</span>}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-0.5 rounded-full bg-slate-950/80 p-0.5">
                <button
                  type="button"
                  onClick={() => setPriceCurrency('usd')}
                  className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                    priceCurrency === 'usd' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:bg-slate-800'
                  }`}
                  aria-pressed={priceCurrency === 'usd'}
                  title="달러(USD)"
                >
                  $
                </button>
                <button
                  type="button"
                  onClick={() => setPriceCurrency('krw')}
                  className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                    priceCurrency === 'krw' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:bg-slate-800'
                  }`}
                  aria-pressed={priceCurrency === 'krw'}
                  title="원화(KRW)"
                >
                  ₩
                </button>
              </div>
              <div className="flex items-center gap-2 rounded-full bg-slate-950/60 px-2 py-1">
                {([
                  { key: 'year', label: '년' },
                  { key: 'month', label: '월' },
                  { key: 'day', label: '일' },
                  { key: 'hour', label: '시간' },
                ] as const).map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => setTimeframe(item.key)}
                    className={`rounded-full px-2 py-1 text-xs ${
                      timeframe === item.key
                        ? 'bg-blue-600 text-white'
                        : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          {stockError && (
            <p className="mt-2 text-xs text-rose-400">
              차트 데이터를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.
            </p>
          )}
          <div className="h-72">
            {stockLoading ? (
              <div className="flex h-full items-center justify-center text-slate-500">불러오는 중...</div>
            ) : stockError ? (
              <div className="flex h-full items-center justify-center text-slate-500">차트 데이터 없음</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                  <XAxis
                    dataKey="date"
                    tick={{ fill: '#cbd5f5', fontSize: 11 }}
                    interval="preserveStartEnd"
                    minTickGap={24}
                  />
                  <YAxis
                    tick={{ fill: '#cbd5f5', fontSize: 11 }}
                    domain={chartYDomain ?? ['auto', 'auto']}
                    tickFormatter={(value: number) =>
                      priceCurrency === 'krw'
                        ? Math.round(value).toLocaleString('ko-KR')
                        : value.toLocaleString('en-US', { maximumFractionDigits: 0 })
                    }
                  />
                  <Tooltip
                    content={(tooltipProps) => (
                      <StockChartTooltip {...tooltipProps} priceCurrency={priceCurrency} />
                    )}
                    cursor={{ strokeDasharray: '3 3' }}
                  />
                  <CandlestickSeries data={chartData} />
                  <Line type="monotone" dataKey="sma20" stroke="#f59e0b" strokeWidth={1.5} dot={false} connectNulls />
                  <Line type="monotone" dataKey="bbUpper" stroke="#a78bfa" strokeWidth={1.2} dot={false} connectNulls />
                  <Line type="monotone" dataKey="bbLower" stroke="#a78bfa" strokeWidth={1.2} dot={false} connectNulls />
                </ComposedChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
        <div className="w-full lg:col-span-3 rounded-2xl border border-slate-800 bg-slate-900/80 p-4 shadow-lg">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-white">{selectedDisplayName} 예측 이력 및 변동</h3>
            {historyLoading && <span className="text-xs text-slate-400">불러오는 중...</span>}
            {historyError && <span className="text-xs text-rose-400">오류: {historyError}</span>}
          </div>
          <div className="mt-3 grid gap-3 lg:grid-cols-3">
            <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
              <p className="text-xs uppercase tracking-[0.2em] text-blue-300">최근 예측</p>
              <p className="mt-2 text-sm text-slate-300">기준일: {latestHistory?.predictionDate ?? '-'}</p>
              <p className="mt-1 text-sm text-slate-300">
                방향: {latestHistory ? directionToKorean(latestHistory.predictedDirection) : '-'}
              </p>
              <p className="mt-1 text-sm text-slate-300">
                상승확률: {latestHistory ? `${(latestHistory.probabilityUp * 100).toFixed(1)}%` : '-'}
              </p>
            </div>
            <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
              <p className="text-xs uppercase tracking-[0.2em] text-blue-300">전일 대비 변동</p>
              <p className="mt-2 text-sm text-slate-300">
                확률 변화:{' '}
                {latestHistory?.probabilityDelta == null
                  ? '-'
                  : `${latestHistory.probabilityDelta > 0 ? '+' : ''}${(latestHistory.probabilityDelta * 100).toFixed(1)}%p`}
              </p>
              <p className="mt-1 text-sm text-slate-300">
                방향 전환: {latestHistory?.directionChanged ? '예' : '아니오'}
              </p>
              <p className="mt-1 text-sm text-slate-400">
                이전 기준일: {previousHistory?.predictionDate ?? '-'}
              </p>
            </div>
            <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
              <p className="text-xs uppercase tracking-[0.2em] text-blue-300">실측 비교</p>
              <p className="mt-2 text-sm text-slate-300">
                실측 방향: {latestHistory?.actualDirection ? directionToKorean(latestHistory.actualDirection) : '대기 중'}
              </p>
              <p className="mt-1 text-sm text-slate-300">
                결과: {latestHistory?.isCorrect == null ? '대기 중' : latestHistory.isCorrect ? '적중' : '미적중'}
              </p>
              <p className="mt-1 text-sm text-slate-400">실측일: {latestHistory?.actualDate ?? '-'}</p>
            </div>
          </div>
        </div>
        <div className="w-full lg:col-span-3 rounded-2xl border border-slate-800 bg-slate-900/80 p-4 shadow-lg">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-white">최신 뉴스</h3>
            {newsLoading && <span className="text-xs text-slate-400">불러오는 중...</span>}
            {newsError && <span className="text-xs text-rose-400">오류: {newsError}</span>}
          </div>
          <div className="mt-3 space-y-3">
            {newsLoading ? (
              <div className="flex items-center gap-2 text-slate-500">
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-slate-600 border-t-transparent" />
                뉴스 불러오는 중...
              </div>
            ) : (
              news?.map((item) => (
                <div
                  key={item.title}
                  className="rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2"
                >
                  <p className="text-sm font-semibold text-white">{item.title}</p>
                  <div className="mt-1 flex items-center justify-between text-xs text-slate-400">
                    <span>{item.source ?? '구글 뉴스'}</span>
                    {item.sentiment ? (
                      <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[11px] uppercase tracking-wide text-slate-200">
                        {item.sentiment.label} ({item.sentiment.score})
                      </span>
                    ) : (
                      <span className="text-slate-600">감성 분석 대기 중</span>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

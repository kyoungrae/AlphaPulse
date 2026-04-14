import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { apiUrl } from '../apiBase'
import {
  Bar,
  BarChart,
  Cell,
  ComposedChart,
  Layer,
  Line,
  ReferenceLine,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  usePlotArea,
  useXAxisScale,
  useYAxisScale,
} from 'recharts'

/**
 * 매물대(지지·저항) 텍스트 위치를 직접 조정하려면 아래 숫자만 바꾸면 됩니다.
 * - insetFromRightPx: 플롯 오른쪽 끝에서 안쪽으로 얼마나 띄울지(클수록 글자가 왼쪽으로 감)
 * - dx: 가로 미세 이동(px). 양수 → 오른쪽, 음수 → 왼쪽
 * - dySupport / dyResistance: 각 라벨만 세로로 밀기(양수 → 아래, 음수 → 위)
 */
const VBP_LABEL_LAYOUT = {
  insetFromRightPx: -85,
  dx: 0,
  dySupport: 0,
  dyResistance: 0,
} as const

/** 차트 휠 줌: 보이는 인덱스 구간 (항상 최신 봉 = 오른쪽 끝 고정) */
const CHART_ZOOM_MIN_BARS = 12
const CHART_ZOOM_STEP = 0.14

/** 줌 인: 창 너비만 줄이고 end 는 항상 fullLen-1(최신)에 맞춤 → 확대해도 오늘/최신 봉 유지 */
function zoomRangeIn(start: number, end: number, fullLen: number): { start: number; end: number } {
  const w = end - start + 1
  const nw = Math.max(CHART_ZOOM_MIN_BARS, Math.floor(w * (1 - CHART_ZOOM_STEP)))
  const ne = fullLen - 1
  let ns = ne - nw + 1
  if (ns < 0) ns = 0
  return { start: ns, end: ne }
}

/** 줌 아웃: 왼쪽으로만 넓히고 end 는 최신에 고정 */
function zoomRangeOut(start: number, end: number, fullLen: number): { start: number; end: number } | null {
  const w = end - start + 1
  if (w >= fullLen) return null
  const nw = Math.min(fullLen, Math.ceil(w * (1 + CHART_ZOOM_STEP)))
  const ne = fullLen - 1
  let ns = ne - nw + 1
  ns = Math.max(0, ns)
  if (ne - ns + 1 >= fullLen) return null
  return { start: ns, end: ne }
}

type CandlePoint = {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume?: number
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
  baseClose: number
  probabilityDelta: number | null
  directionChanged: boolean
  actualDirection: 'Up' | 'Down' | null
  actualDate: string | null
  actualClose: number | null
  isCorrect: boolean | null
}

type HistoryResponse = {
  ticker: string
  items: HistoryItem[]
  /** 백엔드가 Firestore 미연결 시 내려줌 — 이때 items 는 빈 배열이라 UI에서 안내 필요 */
  warning?: string
  detail?: string
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

type NewsFeatureDaily = {
  date: string
  news_sentiment_score: number
  news_volume: number
  event_keyword_count: number
  positive_count: number
  negative_count: number
  neutral_count: number
}

type NewsFeatureResponse = {
  ticker: string
  market: 'us' | 'kr'
  from: string
  to: string
  generatedAt: string
  keywords: string[]
  summary: {
    news_sentiment_score: number
    news_volume: number
    event_keyword_count: number
    positive_count: number
    negative_count: number
    neutral_count: number
  }
  daily: NewsFeatureDaily[]
  articles: Array<{
    title: string
    link?: string
    source: string
    publishedAt: string
    sentiment: { label: string; score: number }
  }>
}

type StrategyMode = 'long_only' | 'long_short' | 'swing' | 'intraday'

const FEATURE_INTERPRETER: Record<string, { label: string; logic: string }> = {
  oil_price: { label: '유가', logic: '에너지 비용 및 인플레이션 압력' },
  us10y_yield: { label: '미국채 10년물 금리', logic: '시장 할인율 및 자금 조달 비용' },
  vix_close: { label: 'VIX(공포지수)', logic: '시장 변동성 및 투자 심리 위축' },
  relative_momentum: { label: '시장 대비 상대 강도', logic: '지수 대비 종목의 자금 유입 세기' },
  obv_trend: { label: '거래량 추세(OBV)', logic: '스마트 머니의 매집 및 이탈 신호' },
  atr_pct: { label: '변동성 폭(ATR)', logic: '최근 가격 흔들림의 크기' },
  rsi_14: { label: 'RSI(과매수/과매도)', logic: '단기 가격 과열 또는 침체 상태' },
  macd_hist: { label: 'MACD 히스토그램', logic: '추세 반전 및 가속도' },
  vbp_node_strength: { label: '매물 밀집도', logic: '현 가격대에서의 거래 집중도' },
  usd_krw_exchange: { label: '원/달러 환율', logic: '외국인 수급 및 환차익/손실 영향' },
}

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
  startDate?: string
  endDate?: string
  metrics: BacktestMetrics
  latestSignal: {
    date: string
    action: 'buy' | 'sell' | 'short' | 'cover' | 'hold'
    probabilityUp: number
  } | null
}

function directionToKorean(direction: string) {
  if (direction === 'Up') return '상승'
  if (direction === 'Down') return '하락'
  return direction
}

function VbpLabelsOnPlotRight({
  support,
  resistance,
}: {
  support: number | null
  resistance: number | null
}) {
  const plot = usePlotArea()
  const yScale = useYAxisScale('price')
  if (!plot || !yScale) return null

  const xBase = plot.x + plot.width - VBP_LABEL_LAYOUT.insetFromRightPx + VBP_LABEL_LAYOUT.dx

  const rows: Array<{ key: string; y: number; text: string; fill: string }> = []
  if (support != null) {
    const py = yScale(support)
    if (py != null && Number.isFinite(py)) {
      rows.push({
        key: 'support',
        y: py + VBP_LABEL_LAYOUT.dySupport,
        text: '매물대 지지',
        fill: '#86efac',
      })
    }
  }
  if (resistance != null) {
    const py = yScale(resistance)
    if (py != null && Number.isFinite(py)) {
      rows.push({
        key: 'resistance',
        y: py + VBP_LABEL_LAYOUT.dyResistance,
        text: '매물대 저항',
        fill: '#fdba74',
      })
    }
  }
  if (rows.length === 0) return null

  return (
    <Layer className="pointer-events-none">
      {rows.map((r) => (
        <text
          key={r.key}
          x={xBase}
          y={r.y}
          textAnchor="end"
          dominantBaseline="middle"
          fill={r.fill}
          fontSize={10}
          fontWeight={600}
          style={{ paintOrder: 'stroke', stroke: 'rgb(15 23 42)', strokeWidth: 3 }}
        >
          {r.text}
        </text>
      ))}
    </Layer>
  )
}

type ChartRow = {
  /** X축·캔들 정렬용 고유 키(ISO 시각 문자열) */
  xKey: string
  tooltipLabel: string
  open: number
  high: number
  low: number
  close: number
  sma20: number | null
  bbUpper: number | null
  bbLower: number | null
  volume: number
  vbpSupport: number | null
  vbpResistance: number | null
  vbpNodeStrength: number | null
}

function formatFullAxisLabel(iso: string, timeframe: 'year' | 'month' | 'day' | 'hour') {
  const dt = new Date(iso)
  return dt.toLocaleString('ko-KR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    ...(timeframe === 'hour' ? { second: '2-digit' } : {}),
    hour12: false,
  })
}

/** 줌으로 보이는 구간이 짧을수록 시·분·초까지 촘촘히 표시 */
function formatAxisTickForZoom(
  iso: string,
  timeframe: 'year' | 'month' | 'day' | 'hour',
  spanMs: number,
  visibleBars: number,
) {
  const dt = new Date(iso)
  if (spanMs > 0 && spanMs <= 2 * 60 * 60 * 1000) {
    return dt.toLocaleString('ko-KR', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
  }
  if (spanMs > 0 && spanMs <= 36 * 60 * 60 * 1000) {
    return dt.toLocaleString('ko-KR', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
  }
  if (spanMs > 0 && spanMs <= 7 * 24 * 60 * 60 * 1000 && visibleBars < 100) {
    return dt.toLocaleString('ko-KR', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
  }
  return formatFullAxisLabel(iso, timeframe)
}

function CandlestickSeries({ data }: { data: ChartRow[] }) {
  const xScale = useXAxisScale(0)
  const yScale = useYAxisScale('price')
  if (!xScale || !yScale || data.length === 0) return null

  return (
    <g className="recharts-candlesticks" aria-hidden>
      {data.map((d, i) => {
        const xMid = xScale(d.xKey, { position: 'middle' })
        const xStart = xScale(d.xKey, { position: 'start' })
        const xEnd = xScale(d.xKey, { position: 'end' })
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
          <g key={`${d.xKey}-${i}`}>
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

function SHAPContributionChart({ data }: { data: Array<{ feature: string; importance: number }> }) {
  if (!data.length) {
    return <p className="text-[11px] text-slate-500">기여도 데이터가 없습니다.</p>
  }
  return (
    <div className="h-40 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 12, left: 12, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#334155" />
          <XAxis type="number" hide />
          <YAxis dataKey="feature" type="category" tick={{ fill: '#94a3b8', fontSize: 10 }} width={88} />
          <Bar dataKey="importance">
            {data.map((entry, index) => (
              <Cell key={`shap-cell-${index}`} fill={entry.importance >= 0 ? '#10b981' : '#f43f5e'} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
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
  const candleUp = row.close >= row.open
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs shadow-lg">
      <p className="font-medium text-slate-100">{row.tooltipLabel}</p>
      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
        <span className="font-medium text-sky-400">시가</span>
        <span className="text-right tabular-nums text-sky-200">{formatMoney(row.open, priceCurrency)}</span>
        <span className="font-medium text-emerald-400">고가</span>
        <span className="text-right tabular-nums text-emerald-200">{formatMoney(row.high, priceCurrency)}</span>
        <span className="font-medium text-rose-400">저가</span>
        <span className="text-right tabular-nums text-rose-200">{formatMoney(row.low, priceCurrency)}</span>
        <span className="font-medium text-amber-400">종가</span>
        <span
          className={`text-right tabular-nums font-medium ${
            candleUp ? 'text-emerald-300' : 'text-rose-300'
          }`}
        >
          {formatMoney(row.close, priceCurrency)}
        </span>
        {row.sma20 != null && (
          <>
            <span className="font-medium text-orange-400">SMA20</span>
            <span className="text-right tabular-nums text-orange-200">{formatMoney(row.sma20, priceCurrency)}</span>
          </>
        )}
        {row.bbUpper != null && row.bbLower != null && (
          <>
            <span className="font-medium text-violet-400">볼린저</span>
            <span className="text-right text-[10px] leading-tight tabular-nums">
              <span className="text-violet-200">{formatMoney(row.bbUpper, priceCurrency)}</span>
              <span className="text-slate-500"> ~ </span>
              <span className="text-indigo-200">{formatMoney(row.bbLower, priceCurrency)}</span>
            </span>
          </>
        )}
        {row.vbpSupport != null && row.vbpResistance != null && (
          <>
            <span className="font-medium text-slate-400">매물대 지지/저항</span>
            <span className="text-right text-[10px] leading-tight tabular-nums">
              <span className="text-emerald-300">{formatMoney(row.vbpSupport, priceCurrency)}</span>
              <span className="text-slate-500"> / </span>
              <span className="text-orange-300">{formatMoney(row.vbpResistance, priceCurrency)}</span>
            </span>
          </>
        )}
        {row.vbpNodeStrength != null && (
          <>
            <span className="font-medium text-cyan-400">매물 밀집도</span>
            <span className="text-right tabular-nums text-cyan-200">{(row.vbpNodeStrength * 100).toFixed(1)}%</span>
          </>
        )}
        {typeof row.volume === 'number' && row.volume > 0 && (
          <>
            <span className="font-medium text-slate-400">거래량</span>
            <span className="text-right tabular-nums text-slate-200">
              {Math.round(row.volume).toLocaleString('ko-KR')}
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
    setError(null)
    fetch(url)
      .then(async (res) => {
        const bodyText = await res.text()
        if (!res.ok) {
          throw new Error(`요청 실패: ${res.status} ${bodyText}`)
        }
        const ctype = res.headers.get('content-type') ?? ''
        if (ctype.includes('application/json')) {
          if (!bodyText.trim()) {
            throw new Error('빈 응답입니다. 잠시 후 다시 시도해 주세요.')
          }
          let json: T
          try {
            json = JSON.parse(bodyText) as T
          } catch (err) {
            throw new Error(`JSON 파싱 실패: ${(err as Error).message}`)
          }
          if (mounted) setData(json)
        } else {
          throw new Error(`JSON이 아닌 응답입니다: ${bodyText.slice(0, 200)}`)
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
  const [yearRange, setYearRange] = useState<1 | 3 | 5 | 10 | 20>(1)
  const [priceCurrency, setPriceCurrency] = useState<DisplayCurrency>('usd')
  const [strategy, setStrategy] = useState<StrategyMode>('long_only')
  const [chartShowCandles, setChartShowCandles] = useState(true)
  const [chartShowLines, setChartShowLines] = useState(true)
  const [chartShowBars, setChartShowBars] = useState(true)
  /** null 이면 전체 구간, 아니면 chartData 인덱스 [start, end] 만 표시 (휠 줌) */
  const [chartZoomRange, setChartZoomRange] = useState<{ start: number; end: number } | null>(null)
  const chartWheelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(symbolQuery), 200)
    return () => clearTimeout(timer)
  }, [symbolQuery])

  const symbolsUrl = useMemo(() => {
    const q = encodeURIComponent(debouncedQuery.trim())
    return apiUrl(`/api/symbols?market=${market}&q=${q}&limit=40`)
  }, [debouncedQuery, market])

  useEffect(() => {
    setSelectedSymbol(market === 'kr' ? '005930.KS' : 'AAPL')
  }, [market])

  useEffect(() => {
    setPriceCurrency(market === 'kr' ? 'krw' : 'usd')
  }, [market])

  const nativeCurrency: NativeCurrency = market === 'kr' ? 'krw' : 'usd'

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
    apiUrl(
      `/api/stock/${encodeURIComponent(selectedSymbol)}?timeframe=${encodeURIComponent(timeframe)}&years=${yearRange}`,
    ),
  )
  const {
    data: news,
    loading: newsLoading,
    error: newsError,
  } = useFetch<NewsItem[]>(apiUrl('/api/news'))
  const {
    data: predict,
    loading: predictLoading,
    error: predictError,
  } = useFetch<PredictResponse>(apiUrl(`/api/predict/${encodeURIComponent(selectedSymbol)}`))
  const {
    data: history,
    loading: historyLoading,
    error: historyError,
  } = useFetch<HistoryResponse>(
    apiUrl(`/api/predictions/history/${encodeURIComponent(selectedSymbol)}?limit=10`),
  )
  const {
    data: backtest,
    loading: backtestLoading,
    error: backtestError,
  } = useFetch<BacktestResult>(
    apiUrl(`/api/backtest/${encodeURIComponent(selectedSymbol)}?market=${market}&strategy=${strategy}`),
  )
  const {
    data: newsFeatures,
    loading: newsFeaturesLoading,
    error: newsFeaturesError,
  } = useFetch<NewsFeatureResponse>(
    apiUrl(`/api/features/news/${encodeURIComponent(selectedSymbol)}?market=${market}&limit=100`),
  )
  const { data: fxData } = useFetch<FxResponse>(apiUrl('/api/fx/usd-krw'))
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
    return apiUrl(`/api/predict/directions?symbols=${encodeURIComponent(topSymbolsCsv)}`)
  }, [topSymbolsCsv])
  const { data: directions } = useFetch<DirectionsResponse>(directionsUrl)

  const chartData = useMemo((): ChartRow[] => {
    if (!stock || stock.length === 0) return []

    const rate = fxData?.rate
    const toDisplay = (v: number) => convertPrice(v, nativeCurrency, priceCurrency, rate)

    const closes = stock.map((s) => s.close)
    const result = stock.map((pt, idx) => {
      const iso = typeof pt.date === 'string' ? pt.date : new Date(pt.date).toISOString()
      const tooltipLabel = formatFullAxisLabel(iso, timeframe)
      const close = pt.close
      const open = pt.open
      const high = pt.high
      const low = pt.low
      let sma20: number | null = null
      let bbUpper: number | null = null
      let bbLower: number | null = null
      let vbpSupport: number | null = null
      let vbpResistance: number | null = null
      let vbpNodeStrength: number | null = null

      if (idx >= 19) {
        const window = closes.slice(idx - 19, idx + 1)
        const mean = window.reduce((a, b) => a + b, 0) / window.length
        const variance = window.reduce((a, b) => a + (b - mean) ** 2, 0) / window.length
        const std = Math.sqrt(variance)
        sma20 = mean
        bbUpper = mean + 2 * std
        bbLower = mean - 2 * std
      }

      {
        const lookback = 180
        const binCount = 24
        const start = Math.max(0, idx - lookback + 1)
        const windowPrices = stock.slice(start, idx + 1).map((item) => toDisplay(item.close))
        const windowVolumes = stock.slice(start, idx + 1).map((item) => Number(item.volume ?? 0))
        const pMin = Math.min(...windowPrices)
        const pMax = Math.max(...windowPrices)
        const current = toDisplay(pt.close)
        if (!Number.isFinite(pMin) || !Number.isFinite(pMax)) {
          vbpSupport = current
          vbpResistance = current
          vbpNodeStrength = 0
        } else if (pMax <= pMin) {
          vbpSupport = current
          vbpResistance = current
          vbpNodeStrength = 1
        } else {
          const step = (pMax - pMin) / binCount
          const hist = Array.from({ length: binCount }, () => 0)
          for (let j = 0; j < windowPrices.length; j += 1) {
            const p = windowPrices[j]
            const v = windowVolumes[j]
            const hIdx = Math.min(binCount - 1, Math.max(0, Math.floor((p - pMin) / Math.max(step, 1e-9))))
            hist[hIdx] += v
          }
          const currentIdx = Math.min(binCount - 1, Math.max(0, Math.floor((current - pMin) / Math.max(step, 1e-9))))
          const supportIdx = Array.from({ length: currentIdx + 1 }, (_, j) => j).reduce(
            (best, cur) => (hist[cur] > hist[best] ? cur : best),
            0,
          )
          const resistanceIdx = Array.from({ length: binCount - currentIdx }, (_, j) => j + currentIdx).reduce(
            (best, cur) => (hist[cur] > hist[best] ? cur : best),
            currentIdx,
          )
          const toBinPrice = (hIdx: number) => pMin + step * (hIdx + 0.5)
          vbpSupport = toBinPrice(supportIdx)
          vbpResistance = toBinPrice(resistanceIdx)
          const totalVol = hist.reduce((a, b) => a + b, 0)
          vbpNodeStrength = totalVol > 0 ? hist[currentIdx] / totalVol : 0
        }
      }

      return {
        xKey: iso,
        tooltipLabel,
        open: toDisplay(open),
        high: toDisplay(high),
        low: toDisplay(low),
        close: toDisplay(close),
        sma20: sma20 != null ? toDisplay(sma20) : null,
        bbUpper: bbUpper != null ? toDisplay(bbUpper) : null,
        bbLower: bbLower != null ? toDisplay(bbLower) : null,
        volume: Number(pt.volume ?? 0),
        vbpSupport,
        vbpResistance,
        vbpNodeStrength,
      }
    })
    return result
  }, [stock, timeframe, nativeCurrency, priceCurrency, fxData?.rate])

  const displayChartData = useMemo((): ChartRow[] => {
    if (!chartData.length) return []
    if (!chartZoomRange) return chartData
    const { start, end } = chartZoomRange
    if (start < 0 || end >= chartData.length || start > end) return chartData
    return chartData.slice(start, end + 1)
  }, [chartData, chartZoomRange])

  const chartVisibleSpanMs = useMemo(() => {
    if (displayChartData.length < 2) return 0
    const t0 = new Date(displayChartData[0].xKey).getTime()
    const t1 = new Date(displayChartData[displayChartData.length - 1].xKey).getTime()
    return Math.abs(t1 - t0)
  }, [displayChartData])

  const chartYDomain = useMemo((): [number, number] | undefined => {
    if (!displayChartData.length) return undefined
    const lows = displayChartData.map((d) => d.low)
    const highs = displayChartData.map((d) => d.high)
    const min = Math.min(...lows)
    const max = Math.max(...highs)
    const pad = Math.max((max - min) * 0.03, Math.abs(max) * 0.001 || 0.01)
    return [min - pad, max + pad]
  }, [displayChartData])

  const vbpLevels = useMemo(() => {
    if (!displayChartData.length) return { support: null as number | null, resistance: null as number | null }
    const latest = displayChartData[displayChartData.length - 1]
    return { support: latest.vbpSupport, resistance: latest.vbpResistance }
  }, [displayChartData])

  useEffect(() => {
    setChartZoomRange(null)
  }, [selectedSymbol, timeframe, yearRange, stock?.length])

  /** 휠/더블클릭은 플롯 영역(.recharts-surface)에만 걸어 축·범례 영역과 분리 */
  useLayoutEffect(() => {
    const container = chartWheelRef.current
    if (!container) return undefined

    let surfaceEl: SVGElement | null = null

    const onWheel = (e: WheelEvent) => {
      if (!chartData.length || chartData.length <= CHART_ZOOM_MIN_BARS) return
      e.preventDefault()
      e.stopPropagation()
      const len = chartData.length
      setChartZoomRange((prev) => {
        const s = prev?.start ?? 0
        const ed = prev?.end ?? len - 1
        if (e.deltaY < 0) {
          const next = zoomRangeIn(s, ed, len)
          return next.start === s && next.end === ed ? prev : next
        }
        const out = zoomRangeOut(s, ed, len)
        return out === null ? null : out
      })
    }

    const onDblClick = (e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setChartZoomRange(null)
    }

    const detach = () => {
      if (!surfaceEl) return
      surfaceEl.removeEventListener('wheel', onWheel)
      surfaceEl.removeEventListener('dblclick', onDblClick)
      surfaceEl = null
    }

    const attach = () => {
      const next = container.querySelector<SVGElement>('.recharts-surface')
      if (!next || next === surfaceEl) return
      detach()
      surfaceEl = next
      surfaceEl.addEventListener('wheel', onWheel, { passive: false })
      surfaceEl.addEventListener('dblclick', onDblClick)
    }

    attach()
    let cancelled = false
    const raf = requestAnimationFrame(() => {
      if (cancelled) return
      attach()
      requestAnimationFrame(() => {
        if (cancelled) return
        attach()
      })
    })

    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      detach()
    }
  }, [chartData, displayChartData.length, chartZoomRange, chartShowCandles, chartShowLines, chartShowBars])

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
  const aiBriefing = useMemo(() => {
    if (predictLoading || backtestLoading) {
      return (
        <div className="rounded-2xl border border-blue-900/40 bg-blue-950/20 p-4 shadow-lg">
          <div className="h-16 animate-pulse rounded-xl bg-slate-800/60" />
        </div>
      )
    }
    if (!predict || !backtest) return null

    const isUp = predict.direction === 'Up'
    const upProb = predict.probability_up * 100
    const directionProb = isUp ? upProb : 100 - upProb
    const prob = directionProb.toFixed(1)
    const action = backtest.latestSignal?.action ?? 'hold'
    const topFeature = predict.top_feature_importance?.[0]?.feature ?? '시장 지표'
    const topFeatureLabel = FEATURE_INTERPRETER[topFeature]?.label ?? topFeature
    const detailedAnalysis = (predict.top_feature_importance ?? []).slice(0, 3).map((item, idx) => {
      const info = FEATURE_INTERPRETER[item.feature] ?? { label: item.feature, logic: '시장 변동 요인' }
      const isPositiveImpact = item.importance > 0
      const impactDir = isPositiveImpact ? '상승 요인' : '하락 요인'
      const colorClass = isPositiveImpact ? 'text-emerald-400' : 'text-rose-400'

      return (
        <div key={`${item.feature}-${idx}`} className="flex flex-col gap-1 rounded-lg border border-slate-800 bg-slate-900/40 p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="font-bold text-slate-100">
              {idx + 1}. {info.label}
            </span>
            <span className={`rounded-full bg-slate-800 px-2 py-0.5 text-[10px] ${colorClass}`}>
              {impactDir} (기여도: {Math.abs(item.importance).toFixed(4)})
            </span>
          </div>
          <p className="text-xs leading-relaxed text-slate-400">
            {info.logic} 관점에서 현재 {isPositiveImpact ? '긍정적인' : '부정적인'} 신호가 감지되어 최종 예측을{' '}
            <span className={colorClass}>{isPositiveImpact ? '상승' : '하락'}</span> 방향으로 당기고 있습니다.
          </p>
        </div>
      )
    })

    return (
      <div className="rounded-2xl border border-blue-800/50 bg-blue-900/10 p-5 shadow-lg backdrop-blur-sm">
        <h3 className="flex items-center gap-2 text-sm font-bold text-blue-300">
          <span className="relative flex h-3 w-3">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-75" />
            <span className="relative inline-flex h-3 w-3 rounded-full bg-blue-500" />
          </span>
          AI 퀀트 매니저 상세 분석 리포트
        </h3>
        <p className="mt-2 text-sm text-slate-200">
          AI 모델 기준 내일 <span className="font-semibold text-white">{selectedDisplayName}</span>은(는)
          <span className={isUp ? ' font-bold text-emerald-400' : ' font-bold text-rose-400'}>
            {isUp ? ' 상승' : ' 하락'} 확률 {prob}%
          </span>
          로 해석됩니다. 핵심 요인은 <strong>[{topFeatureLabel}]</strong>입니다.
        </p>

        <div className="mb-4 mt-3 grid gap-3 md:grid-cols-3">
          {detailedAnalysis.length ? detailedAnalysis : <p className="text-xs text-slate-500">해석 가능한 요인이 없습니다.</p>}
        </div>

        <div className="border-t border-slate-800/50 pt-4 text-xs text-slate-300">
          <strong className="text-blue-300">투자 의견:</strong>{' '}
          {action === 'buy'
            ? '상승 모멘텀 신호가 확인되어 분할 매수 전략이 유효해 보입니다.'
            : action === 'short'
              ? '매도 압력이 강한 구간으로 신규 매수보다는 보수적 대응이 유리합니다.'
              : action === 'sell' || action === 'cover'
                ? '기존 포지션은 청산 우선 전략으로 리스크를 줄이는 접근이 적절합니다.'
                : '방향성이 엇갈리는 구간이므로 지지/저항 확인 후 관망 전략을 권장합니다.'}
          {!isUp && vbpLevels.support != null && (
            <span>
              {' '}
              하방 기준선은 {formatMoney(vbpLevels.support, priceCurrency)}이며 이탈 시 손절 기준으로 활용하세요.
            </span>
          )}
          {isUp && vbpLevels.resistance != null && (
            <span>
              {' '}
              상방 1차 목표는 {formatMoney(vbpLevels.resistance, priceCurrency)} 부근입니다.
            </span>
          )}
        </div>
      </div>
    )
  }, [
    predict,
    predictLoading,
    backtest,
    backtestLoading,
    vbpLevels,
    priceCurrency,
    selectedDisplayName,
  ])
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

      {aiBriefing}

      <div className="grid gap-6 lg:grid-cols-3">
      <div className="w-full lg:col-span-3 rounded-2xl border border-slate-800 bg-slate-900/80 p-5 shadow-lg">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-lg font-bold text-white">{selectedDisplayName} 예측 VS 실측 결과</h3>
            <div className="flex items-center gap-2">
              {historyLoading && <span className="text-xs text-slate-400">불러오는 중...</span>}
              {historyError && <span className="text-xs text-rose-400">오류: {historyError}</span>}
            </div>
          </div>
          {history?.warning && (
            <div className="mb-4 rounded-lg border border-amber-800/60 bg-amber-950/30 px-4 py-3 text-sm text-amber-100">
              <p className="font-medium">{history.warning}</p>
              {history.detail && <p className="mt-1 text-xs text-amber-200/90">{history.detail}</p>}
              <p className="mt-2 text-xs text-amber-200/70">
                백엔드(.env의 GOOGLE_APPLICATION_CREDENTIALS)로 Firestore에 붙은 뒤 백엔드를 재시작했는지 확인하세요.
              </p>
            </div>
          )}

          <div className="mb-5 flex flex-col items-start gap-4 md:flex-row md:items-center">
            <div className="flex-shrink-0 rounded-xl border border-blue-800/50 bg-blue-900/30 px-5 py-3">
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-blue-300">
                최근 적중률 (결과 확정 기준)
              </p>
              <p className="text-3xl font-black text-white">
                {history?.items && history.items.filter((h) => h.isCorrect != null).length > 0
                  ? `${(
                      (history.items.filter((h) => h.isCorrect).length /
                        history.items.filter((h) => h.isCorrect != null).length) *
                      100
                    ).toFixed(1)}%`
                  : '-'}
              </p>
            </div>
            <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3 text-[11px] leading-relaxed text-slate-400">
              <p>
                <strong>해석 가이드</strong>
              </p>
              <p>• 예측은 모델이 다음 날 시가를 기준으로 종가 상승/하락을 맞추는지 평가합니다.</p>
              <p>
                • 최근 예측이 실측(실제 종가)과 일치하면{' '}
                <span className="font-bold text-emerald-400">적중</span>으로 기록됩니다.
              </p>
              <p>• 백테스트 엔진과 독립적으로, 매일 생성되는 실제 AI의 성적표입니다.</p>
            </div>
          </div>

          <div className="overflow-x-auto rounded-lg border border-slate-700">
            <table className="w-full text-left text-sm whitespace-nowrap text-slate-300">
              <thead className="border-b border-slate-700 bg-slate-800/80 text-[11px] uppercase tracking-wider text-slate-400">
                <tr>
                  <th className="px-4 py-3 font-semibold">예측 기준일</th>
                  <th className="px-4 py-3 font-semibold">기준일 종가</th>
                  <th className="px-4 py-3 font-semibold">AI 예상 방향</th>
                  <th className="px-4 py-3 font-semibold">상승 확률</th>
                  <th className="px-4 py-3 font-semibold">확률 변동 (전일대비)</th>
                  <th className="border-l border-slate-700 px-4 py-3 font-semibold">실측일</th>
                  <th className="px-4 py-3 font-semibold">실측 종가</th>
                  <th className="px-4 py-3 font-semibold">실제 종가 방향</th>
                  <th className="px-4 py-3 text-center font-semibold">결과</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 bg-slate-950/30">
                {history?.items?.map((item) => (
                  <tr key={item.predictionDate} className="transition-colors hover:bg-slate-800/40">
                    <td className="px-4 py-3 text-slate-200">{item.predictionDate}</td>
                    <td className="px-4 py-3 font-medium tabular-nums text-slate-200">
                      {formatMoney(convertPrice(item.baseClose, nativeCurrency, priceCurrency, fxData?.rate), priceCurrency)}
                    </td>
                    <td className="px-4 py-3 font-medium">
                      <span
                        className={item.predictedDirection === 'Up' ? 'text-emerald-400' : 'text-rose-400'}
                      >
                        {item.predictedDirection === 'Up' ? '▲ 상승' : '▼ 하락'}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-semibold tabular-nums">{(item.probabilityUp * 100).toFixed(1)}%</td>
                    <td className="px-4 py-3 text-xs tabular-nums">
                      {item.probabilityDelta == null ? (
                        <span className="text-slate-500">-</span>
                      ) : item.probabilityDelta > 0 ? (
                        <span className="text-emerald-400">+{(item.probabilityDelta * 100).toFixed(1)}%p</span>
                      ) : item.probabilityDelta < 0 ? (
                        <span className="text-rose-400">{(item.probabilityDelta * 100).toFixed(1)}%p</span>
                      ) : (
                        <span className="text-slate-400">0.0%p</span>
                      )}
                    </td>
                    <td className="border-l border-slate-700 px-4 py-3 text-slate-400">
                      {item.actualDate ?? '대기 중'}
                    </td>
                    <td className="px-4 py-3 font-medium tabular-nums text-slate-200">
                      {item.actualClose == null
                        ? '-'
                        : formatMoney(convertPrice(item.actualClose, nativeCurrency, priceCurrency, fxData?.rate), priceCurrency)}
                    </td>
                    <td className="px-4 py-3 font-medium">
                      {item.actualDirection ? (
                        <span
                          className={item.actualDirection === 'Up' ? 'text-emerald-400' : 'text-rose-400'}
                        >
                          {item.actualDirection === 'Up' ? '▲ 상승' : '▼ 하락'}
                        </span>
                      ) : (
                        <span className="text-slate-500">-</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-center">
                      {item.isCorrect == null ? (
                        <span className="rounded bg-slate-800 px-2 py-1 text-[10px] text-slate-400">결과 대기</span>
                      ) : item.isCorrect ? (
                        <span className="rounded border border-emerald-800/50 bg-emerald-900/60 px-2 py-1 text-[11px] font-bold text-emerald-400">
                          적중
                        </span>
                      ) : (
                        <span className="rounded border border-rose-800/50 bg-rose-900/60 px-2 py-1 text-[11px] font-bold text-rose-400">
                          빗나감
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
                {(!history?.items || history.items.length === 0) && (
                  <tr>
                    <td colSpan={9} className="px-4 py-8 text-center text-slate-500">
                      저장된 예측 이력이 없습니다. 일일 배치가 실행되면 여기에 누적됩니다.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
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
              {timeframe === 'year' && (
                <div className="flex items-center gap-0.5 rounded-full bg-slate-950/80 p-0.5">
                  {([
                    { key: 1, label: '1Y' },
                    { key: 3, label: '3Y' },
                    { key: 5, label: '5Y' },
                    { key: 10, label: '10Y' },
                    { key: 20, label: 'MAX' },
                  ] as const).map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      onClick={() => setYearRange(item.key)}
                      className={`rounded-full px-2 py-1 text-xs ${
                        yearRange === item.key
                          ? 'bg-blue-600 text-white'
                          : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                      }`}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          {(vbpLevels.support != null || vbpLevels.resistance != null) && (
            <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-slate-300">
              {vbpLevels.support != null && (
                <MetricTooltip
                  label={`매물대 지지: ${formatMoney(vbpLevels.support, priceCurrency)}`}
                  tip="최근 가격-거래량 분포에서 거래가 많이 누적된 하단 구간입니다. 현재가가 이 값에 가까우면 지지 여부를 확인하세요."
                />
              )}
              {vbpLevels.resistance != null && (
                <MetricTooltip
                  label={`매물대 저항: ${formatMoney(vbpLevels.resistance, priceCurrency)}`}
                  tip="최근 가격-거래량 분포에서 거래가 많이 누적된 상단 구간입니다. 현재가가 이 값에 가까우면 매도 압력 가능성을 점검하세요."
                />
              )}
            </div>
          )}
          {stockError && (
            <p className="mt-2 text-xs text-rose-400">
              차트 데이터를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.
            </p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-slate-800/80 pt-3 text-xs text-slate-300">
            <span className="text-slate-500">표시:</span>
            <label className="inline-flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={chartShowCandles}
                onChange={(e) => setChartShowCandles(e.target.checked)}
                className="rounded border-slate-600 bg-slate-900 text-blue-500 focus:ring-blue-500"
              />
              <span>캔들</span>
            </label>
            <label className="inline-flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={chartShowLines}
                onChange={(e) => setChartShowLines(e.target.checked)}
                className="rounded border-slate-600 bg-slate-900 text-blue-500 focus:ring-blue-500"
              />
              <span>선형 (종가·지표)</span>
            </label>
            <label className="inline-flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={chartShowBars}
                onChange={(e) => setChartShowBars(e.target.checked)}
                className="rounded border-slate-600 bg-slate-900 text-blue-500 focus:ring-blue-500"
              />
              <span>막대 (거래량)</span>
            </label>
            <span
              className="min-w-0 flex-1 text-slate-500"
              title="플롯에서 휠 시 최신 봉(오른쪽) 기준으로 확대·축소됩니다. 더블클릭으로 전체 구간"
            >
              플롯에서 휠: 확대/축소(최신 고정) · 더블클릭: 전체
            </span>
            <div className="inline-flex h-[22px] w-[158px] flex-shrink-0 items-center justify-end">
              {chartZoomRange && chartData.length > 0 ? (
                <span className="rounded-full bg-blue-900/50 px-2 py-0.5 text-[10px] text-blue-200 tabular-nums">
                  확대 중 · {displayChartData.length}/{chartData.length}봉
                </span>
              ) : (
                <span className="invisible px-2 py-0.5 text-[10px] tabular-nums" aria-hidden>
                  확대 중 · 000/000봉
                </span>
              )}
            </div>
          </div>
          <div
            ref={chartWheelRef}
            className="chart-zoom-host h-80 overflow-hidden rounded-lg outline-none"
            role="presentation"
            title="그리드·캔들 영역에서 휠로 확대·축소, 더블클릭으로 전체"
          >
            {stockLoading ? (
              <div className="flex h-full items-center justify-center text-slate-500">불러오는 중...</div>
            ) : stockError ? (
              <div className="flex h-full items-center justify-center text-slate-500">차트 데이터 없음</div>
            ) : !chartData.length ? (
              <div className="flex h-full items-center justify-center text-slate-500">표시할 데이터가 없습니다.</div>
            ) : !chartShowCandles && !chartShowLines && !chartShowBars ? (
              <div className="flex h-full items-center justify-center text-center text-sm text-slate-500">
                캔들·선형·막대 중 하나 이상 선택해 주세요.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={displayChartData} margin={{ top: 8, right: chartShowBars ? 48 : 8, bottom: 8, left: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                  <XAxis
                    dataKey="xKey"
                    tick={{ fill: '#cbd5f5', fontSize: 10 }}
                    interval="preserveStartEnd"
                    minTickGap={chartZoomRange ? 4 : 8}
                    angle={displayChartData.length > 24 ? -40 : 0}
                    textAnchor={displayChartData.length > 24 ? 'end' : 'middle'}
                    height={displayChartData.length > 24 ? 56 : 32}
                    tickFormatter={(v: string) =>
                      formatAxisTickForZoom(v, timeframe, chartVisibleSpanMs, displayChartData.length)
                    }
                  />
                  {(chartShowCandles || chartShowLines) && (
                    <YAxis
                      yAxisId="price"
                      tick={{ fill: '#cbd5f5', fontSize: 11 }}
                      domain={chartYDomain ?? ['auto', 'auto']}
                      tickFormatter={(value: number) =>
                        priceCurrency === 'krw'
                          ? Math.round(value).toLocaleString('ko-KR')
                          : value.toLocaleString('en-US', { maximumFractionDigits: 0 })
                      }
                      width={56}
                    />
                  )}
                  {chartShowBars && (
                    <YAxis
                      yAxisId="vol"
                      orientation="right"
                      tick={{ fill: '#64748b', fontSize: 10 }}
                      domain={[0, (dataMax: number) => (Number.isFinite(dataMax) && dataMax > 0 ? dataMax * 1.12 : 1)]}
                      tickFormatter={(v: number) =>
                        v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : v >= 1000 ? `${(v / 1000).toFixed(0)}k` : `${v}`
                      }
                      width={40}
                    />
                  )}
                  <Tooltip
                    content={(tooltipProps) => (
                      <StockChartTooltip {...tooltipProps} priceCurrency={priceCurrency} />
                    )}
                    cursor={{ strokeDasharray: '3 3' }}
                  />
                  {chartShowBars && (
                    <Bar
                      yAxisId="vol"
                      dataKey="volume"
                      barSize={displayChartData.length > 120 ? 2 : displayChartData.length > 40 ? 4 : 8}
                      radius={[1, 1, 0, 0]}
                      isAnimationActive={false}
                      fill="#475569"
                      fillOpacity={0.5}
                    >
                      {displayChartData.map((entry) => (
                        <Cell
                          key={`vol-${entry.xKey}`}
                          fill={entry.close >= entry.open ? 'rgba(52, 211, 153, 0.45)' : 'rgba(251, 113, 133, 0.45)'}
                        />
                      ))}
                    </Bar>
                  )}
                  {chartShowLines && (
                    <>
                      <Line
                        yAxisId="price"
                        type="monotone"
                        dataKey="close"
                        stroke={chartShowCandles ? 'rgba(148, 163, 184, 0.9)' : '#94a3b8'}
                        strokeWidth={chartShowCandles ? 1.2 : 1.8}
                        dot={false}
                        activeDot={{ r: 3, fill: '#e2e8f0' }}
                        isAnimationActive={false}
                      />
                      <Line
                        yAxisId="price"
                        type="monotone"
                        dataKey="sma20"
                        stroke="#f59e0b"
                        strokeWidth={1.5}
                        dot={false}
                        connectNulls
                        isAnimationActive={false}
                      />
                      <Line
                        yAxisId="price"
                        type="monotone"
                        dataKey="bbUpper"
                        stroke="#a78bfa"
                        strokeWidth={1.2}
                        dot={false}
                        connectNulls
                        isAnimationActive={false}
                      />
                      <Line
                        yAxisId="price"
                        type="monotone"
                        dataKey="bbLower"
                        stroke="#a78bfa"
                        strokeWidth={1.2}
                        dot={false}
                        connectNulls
                        isAnimationActive={false}
                      />
                    </>
                  )}
                  {chartShowCandles && !chartShowLines && (
                    <Line
                      yAxisId="price"
                      type="monotone"
                      dataKey="close"
                      stroke="transparent"
                      strokeWidth={0}
                      dot={false}
                      activeDot={false}
                      isAnimationActive={false}
                      legendType="none"
                    />
                  )}
                  {chartShowCandles && <CandlestickSeries data={displayChartData} />}
                  {(chartShowCandles || chartShowLines) && vbpLevels.support != null && (
                    <ReferenceLine
                      yAxisId="price"
                      y={vbpLevels.support}
                      stroke="#22c55e"
                      strokeDasharray="4 4"
                      strokeOpacity={0.8}
                    />
                  )}
                  {(chartShowCandles || chartShowLines) && vbpLevels.resistance != null && (
                    <ReferenceLine
                      yAxisId="price"
                      y={vbpLevels.resistance}
                      stroke="#f97316"
                      strokeDasharray="4 4"
                      strokeOpacity={0.8}
                    />
                  )}
                  {(chartShowCandles || chartShowLines) && (
                    <VbpLabelsOnPlotRight support={vbpLevels.support} resistance={vbpLevels.resistance} />
                  )}
                </ComposedChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
        <div className="lg:col-span-3 rounded-2xl border border-slate-800 bg-slate-900/80 p-4 shadow-lg">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-lg font-semibold text-white">{selectedDisplayName} 전략/근거 요약</h3>
            <p className="text-xs text-slate-500">백테스트 요약 + 예측 근거</p>
          </div>
          <div className="mt-1 grid grid-cols-1 gap-3 lg:grid-cols-2 lg:items-start">
            <div className="min-w-0 rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-xs text-slate-300">
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
                    {backtest.startDate && backtest.endDate && (
                      <p className="text-slate-500">
                        백테스트 구간: {backtest.startDate} ~ {backtest.endDate} (기본 약 10년)
                      </p>
                    )}
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
            <div className="min-w-0 rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-xs text-slate-300">
              <p className="mb-3 font-semibold text-slate-200">AI 심층 판단 근거 (SHAP 분석)</p>
              <SHAPContributionChart data={predict?.top_feature_importance ?? []} />
              <div className="mt-4 space-y-3">
                {predict?.top_feature_importance?.map((item) => (
                  <div key={item.feature} className="border-l-2 border-slate-700 pl-3">
                    <div className="flex items-center justify-between gap-2 text-[11px]">
                      <span className="truncate font-medium text-blue-300">
                        {FEATURE_INTERPRETER[item.feature]?.label ?? item.feature}
                      </span>
                      <span className={item.importance > 0 ? 'text-emerald-400' : 'text-rose-400'}>
                        {item.importance > 0 ? '상승 기여' : '하락 압박'}
                      </span>
                    </div>
                    <p className="mt-1 text-[10px] leading-normal text-slate-500">
                      {FEATURE_INTERPRETER[item.feature]?.logic ?? '시장 변동 요인'} 관점에서 모델 판단에 약{' '}
                      {Math.abs(item.importance * 10).toFixed(1)}% 가중치로 반영되었습니다.
                    </p>
                  </div>
                ))}
              </div>
              <p className="mt-2 text-slate-400">{predict?.reason_summary ?? '예측 데이터가 없습니다.'}</p>
            </div>
          </div>
        </div>
        
        <div className="w-full lg:col-span-3 rounded-2xl border border-slate-800 bg-slate-900/80 p-4 shadow-lg">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-white">{selectedDisplayName} 뉴스 기반 피처 요약</h3>
            {newsFeaturesLoading && <span className="text-xs text-slate-400">불러오는 중...</span>}
            {newsFeaturesError && <span className="text-xs text-rose-400">오류: {newsFeaturesError}</span>}
          </div>
          {newsFeaturesLoading ? (
            <div className="mt-3 h-20 animate-pulse rounded-xl bg-slate-800/60" />
          ) : newsFeatures ? (
            <>
              <div className="mt-3 grid gap-3 lg:grid-cols-4">
                <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                  <p className="text-xs uppercase tracking-[0.2em] text-blue-300">기간 평균 감성</p>
                  <p className="mt-2 text-lg font-semibold text-white">
                    {(newsFeatures.summary.news_sentiment_score * 100).toFixed(1)}
                  </p>
                  <p className="mt-1 text-[11px] text-slate-500">-100 ~ 100 (양수일수록 낙관)</p>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                  <p className="text-xs uppercase tracking-[0.2em] text-blue-300">기사 수</p>
                  <p className="mt-2 text-lg font-semibold text-white">{newsFeatures.summary.news_volume}</p>
                  <p className="mt-1 text-[11px] text-slate-500">{newsFeatures.from} ~ {newsFeatures.to}</p>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                  <p className="text-xs uppercase tracking-[0.2em] text-blue-300">이벤트 키워드</p>
                  <p className="mt-2 text-lg font-semibold text-white">{newsFeatures.summary.event_keyword_count}</p>
                  <p className="mt-1 text-[11px] text-slate-500">워드 출현 횟수 합계</p>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                  <p className="text-xs uppercase tracking-[0.2em] text-blue-300">감성 분포</p>
                  <p className="mt-2 text-sm text-slate-200">
                    긍정 {newsFeatures.summary.positive_count} / 부정 {newsFeatures.summary.negative_count} / 중립{' '}
                    {newsFeatures.summary.neutral_count}
                  </p>
                </div>
              </div>
              <div className="mt-3 rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                <p className="text-xs uppercase tracking-[0.2em] text-blue-300">일자별 피처</p>
                <div className="mt-2 max-h-44 overflow-y-auto">
                  <table className="w-full text-left text-xs text-slate-300">
                    <thead className="text-slate-500">
                      <tr>
                        <th className="py-1">날짜</th>
                        <th className="py-1">감성</th>
                        <th className="py-1">기사수</th>
                        <th className="py-1">키워드</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...newsFeatures.daily].slice(-10).reverse().map((row) => (
                        <tr key={row.date} className="border-t border-slate-800/70">
                          <td className="py-1.5">{row.date}</td>
                          <td className="py-1.5 tabular-nums">{(row.news_sentiment_score * 100).toFixed(1)}</td>
                          <td className="py-1.5 tabular-nums">{row.news_volume}</td>
                          <td className="py-1.5 tabular-nums">{row.event_keyword_count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <div className="mt-3 rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                <p className="text-xs uppercase tracking-[0.2em] text-blue-300">기사 (클릭 이동)</p>
                <div className="mt-2 max-h-56 space-y-2 overflow-y-auto">
                  {newsFeatures.articles?.length ? (
                    newsFeatures.articles.map((item) => (
                      <div key={`${item.publishedAt}-${item.title}`} className="rounded-lg border border-slate-800/70 bg-slate-900/40 px-2 py-1.5">
                        {item.link ? (
                          <a
                            href={item.link}
                            target="_blank"
                            rel="noreferrer"
                            className="text-sm text-blue-300 hover:underline"
                          >
                            {item.title}
                          </a>
                        ) : (
                          <p className="text-sm text-slate-200">{item.title}</p>
                        )}
                        <p className="mt-1 text-[11px] text-slate-500">
                          {item.source ?? '구글 뉴스'} · {item.publishedAt.slice(0, 10)} · {item.sentiment?.label ?? '중립'} (
                          {item.sentiment?.score ?? 0})
                        </p>
                      </div>
                    ))
                  ) : (
                    <p className="text-xs text-slate-500">표시할 기사 데이터가 없습니다.</p>
                  )}
                </div>
              </div>
            </>
          ) : (
            <p className="mt-3 text-sm text-slate-400">뉴스 기반 피처 데이터가 없습니다.</p>
          )}
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

import { useEffect, useMemo, useState } from 'react'
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

type HistoryItem = {
  predictionDate: string
  predictedDirection: 'Up' | 'Down'
  probabilityUp: number
  probabilityDelta: number | null
  actualDirection: 'Up' | 'Down' | null
  actualDate: string | null
  isCorrect: boolean | null
}

type HistoryResponse = {
  ticker: string
  items: HistoryItem[]
}

type StrategyMode = 'long_only' | 'long_short' | 'swing' | 'intraday'

type BacktestSummaryResponse = {
  ticker: string
  market: 'us' | 'kr'
  strategies: Array<{
    strategy: StrategyMode
    metrics: {
      totalReturn: number
      cagr: number
      maxDrawdown: number
      sharpe: number
      winRate: number
      avgWinLossRatio: number | null
      tradeCount: number
    }
    latestSignal: {
      date: string
      action: 'buy' | 'sell' | 'short' | 'cover' | 'hold'
      probabilityUp: number
    } | null
  }>
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

function formatNotionalInputDisplay(rawDigits: string, market: 'us' | 'kr'): string {
  const d = rawDigits.replace(/\D/g, '')
  if (!d) return ''
  const num = Number(d)
  if (!Number.isFinite(num)) return ''
  return market === 'kr' ? num.toLocaleString('ko-KR') : num.toLocaleString('en-US')
}

function formatWonKoreanReadout(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0원'
  const eok = Math.floor(n / 100_000_000)
  const man = Math.floor((n % 100_000_000) / 10_000)
  const won = Math.floor(n % 10_000)
  const parts: string[] = []
  if (eok > 0) parts.push(`${eok.toLocaleString('ko-KR')}억`)
  if (man > 0) parts.push(`${man.toLocaleString('ko-KR')}만`)
  if (won > 0) parts.push(`${won.toLocaleString('ko-KR')}`)
  return `${parts.join(' ')}원`
}

function formatMoneySimple(value: number, market: 'us' | 'kr') {
  if (market === 'kr') return `${Math.round(value).toLocaleString('ko-KR')}원`
  return `$${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
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

export default function StockPrediction() {
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [market, setMarket] = useState<'us' | 'kr'>('us')
  const [selected, setSelected] = useState('AAPL')
  const [strategy, setStrategy] = useState<StrategyMode>('long_only')
  const [notionalInput, setNotionalInput] = useState('10000')

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 200)
    return () => clearTimeout(timer)
  }, [search])

  const symbolsUrl = useMemo(
    () =>
      apiUrl(
        `/api/symbols?market=${market}&q=${encodeURIComponent(debouncedSearch.trim())}&limit=30`,
      ),
    [debouncedSearch, market],
  )
  const { data: symbols } = useFetch<SymbolResponse>(symbolsUrl)
  const {
    data: history,
    loading,
    error,
  } = useFetch<HistoryResponse>(
    apiUrl(`/api/predictions/history/${encodeURIComponent(selected)}?limit=30`),
  )
  const {
    data: summary,
    loading: summaryLoading,
    error: summaryError,
  } = useFetch<BacktestSummaryResponse>(
    apiUrl(`/api/backtest/summary/${encodeURIComponent(selected)}?market=${market}`),
  )
  const defaultGuidanceNotional = market === 'kr' ? 10_000_000 : 10_000
  const guidanceNotional = useMemo(() => {
    const raw = notionalInput.replace(/,/g, '').trim()
    const n = Number(raw)
    return Number.isFinite(n) && n > 0 ? n : defaultGuidanceNotional
  }, [notionalInput, defaultGuidanceNotional])
  const guidanceUrl = useMemo(
    () =>
      apiUrl(
        `/api/guidance/${encodeURIComponent(selected)}?market=${market}&strategy=${strategy}&notional=${guidanceNotional}`,
      ),
    [selected, market, strategy, guidanceNotional],
  )
  const {
    data: guidance,
    loading: guidanceLoading,
    error: guidanceError,
  } = useFetch<GuidanceResponse>(guidanceUrl)
  const selectedSymbolInfo = useMemo(
    () => (symbols?.items ?? []).find((item) => item.symbol === selected),
    [symbols, selected],
  )
  const selectedDisplayName = selectedSymbolInfo?.nameKr ?? selectedSymbolInfo?.name ?? selected

  useEffect(() => {
    setSelected(market === 'kr' ? '005930.KS' : 'AAPL')
    setNotionalInput(market === 'kr' ? '10000000' : '10000')
  }, [market])
  const selectedStrategySummary = useMemo(
    () => summary?.strategies?.find((item) => item.strategy === strategy) ?? null,
    [summary, strategy],
  )

  return (
    <div className="space-y-4 text-slate-100">
      <div>
        <h2 className="text-2xl font-bold">종목 예측 이력</h2>
        <p className="text-sm text-slate-400">예측 방향/확률과 다음 거래일 실측 결과를 비교합니다.</p>
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
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-blue-300">수익 참고 안내</p>
            <p className="mt-1 text-sm font-semibold text-white">{selectedDisplayName} · 과거 백테스트 기준</p>
            <p className="mt-1 text-xs text-slate-400">
              기본 백테스트 구간은 최근 10년 일봉이며, 전략/신호 규칙은 아래 선택값에 맞춰 갱신됩니다.
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
          {guidanceLoading && <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-600 border-t-transparent" />}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <label className="block text-xs text-slate-400">
            시뮬레이션 금액 ({market === 'kr' ? '원' : 'USD'})
            <input
              type="text"
              inputMode="numeric"
              value={formatNotionalInputDisplay(notionalInput, market)}
              onChange={(e) => setNotionalInput(e.target.value.replace(/\D/g, ''))}
              className="mt-1 w-44 rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-sm text-slate-100 outline-none focus:border-blue-400"
            />
            {market === 'kr' && notionalInput.replace(/\D/g, '') !== '' && (
              <p className="mt-1 text-[11px] text-slate-500">한글 금액: {formatWonKoreanReadout(guidanceNotional)}</p>
            )}
          </label>
        </div>

        {guidanceError && <p className="mt-3 text-xs text-rose-400">안내를 불러오지 못했습니다: {guidanceError}</p>}
        {guidanceLoading && !guidance && <div className="mt-3 h-20 animate-pulse rounded-xl bg-slate-800/60" />}
        {!guidanceLoading && guidance && (
          <div className="mt-3 grid gap-3 lg:grid-cols-3">
            <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-xs text-slate-300">
              <p className="text-slate-500">신호 기준일: <span className="text-slate-100">{guidance.signal?.date ?? '—'}</span></p>
              <p className="mt-1 text-sm font-semibold text-blue-300">
                {guidance.signal ? signalActionToKorean(guidance.signal.action) : '—'} · 모델 상승확률 {(guidance.signal ? guidance.signal.probabilityUp * 100 : 0).toFixed(1)}%
              </p>
              <p className="mt-2 text-xs leading-relaxed text-slate-400">{guidance.actionSummary}</p>
            </div>
            <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-xs text-slate-300">
              <p className="text-slate-500">구간: {guidance.backtestRange.from} ~ {guidance.backtestRange.to}</p>
              <p className="mt-1">완료 거래: {guidance.historical.tradeCount}건</p>
              <p className="mt-1">평균 승리: {guidance.historical.avgWinNetReturn != null ? `${(guidance.historical.avgWinNetReturn * 100).toFixed(2)}%` : '—'}</p>
              <p className="mt-1">평균 패배: {guidance.historical.avgLossNetReturn != null ? `${(guidance.historical.avgLossNetReturn * 100).toFixed(2)}%` : '—'}</p>
            </div>
            <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-xs text-slate-300">
              <p className="text-slate-500">입력 금액 {formatMoneySimple(guidanceNotional, market)} 기준 참고 손익</p>
              <p className="mt-2 text-emerald-300">
                평균 승리 시: {guidance.scenario.profitIfAvgWin != null ? formatMoneySimple(guidance.scenario.profitIfAvgWin, market) : '—'}
              </p>
              <p className="mt-1 text-rose-300">
                평균 패배 시: {guidance.scenario.lossIfAvgLoss != null ? formatMoneySimple(guidance.scenario.lossIfAvgLoss, market) : '—'}
              </p>
            </div>
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-4 shadow-lg">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-white">{selectedDisplayName} 최근 예측 기록</h3>
            <p className="text-xs text-slate-500">{selected}</p>
          </div>
          {loading && <span className="text-xs text-slate-400">불러오는 중...</span>}
        </div>
        <div className="mb-3 flex flex-wrap items-center gap-1">
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
              className={`rounded-full px-2 py-1 text-xs ${
                strategy === item.key
                  ? 'bg-blue-600 text-white'
                  : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
        <p className="mb-3 text-xs text-slate-500">
          전략별 백테스트 요약은 기본 최근 10년 일봉 구간을 사용합니다(AI 예측 학습 기간과 맞춤).
        </p>
        <div className="mb-3 rounded-lg border border-slate-800 bg-slate-950/60 p-3 text-xs text-slate-300">
          {summaryLoading ? (
            <p>전략 요약 계산 중...</p>
          ) : summaryError ? (
            <p className="text-rose-400">전략 요약 오류: {summaryError}</p>
          ) : selectedStrategySummary ? (
            <div className="grid gap-1 md:grid-cols-3">
              <p>
                <MetricTooltip
                  label={`총수익률: ${(selectedStrategySummary.metrics.totalReturn * 100).toFixed(2)}%`}
                  tip="백테스트 전체 기간 누적 수익률입니다."
                />
              </p>
              <p>
                <MetricTooltip
                  label={`CAGR: ${(selectedStrategySummary.metrics.cagr * 100).toFixed(2)}%`}
                  tip="연평균 복리 수익률로, 기간이 달라도 비교가 쉽습니다."
                />
              </p>
              <p>
                <MetricTooltip
                  label={`최대낙폭: ${(selectedStrategySummary.metrics.maxDrawdown * 100).toFixed(2)}%`}
                  tip="계좌가 가장 크게 빠진 구간입니다. 리스크 기준으로 꼭 확인하세요."
                />
              </p>
              <p>
                <MetricTooltip
                  label={`샤프: ${selectedStrategySummary.metrics.sharpe.toFixed(2)}`}
                  tip="변동성 대비 수익 효율입니다. 높을수록 좋습니다."
                />
              </p>
              <p>
                <MetricTooltip
                  label={`승률: ${(selectedStrategySummary.metrics.winRate * 100).toFixed(1)}%`}
                  tip="이긴 거래 비율입니다. 손익비와 함께 해석해야 정확합니다."
                />
              </p>
              <p>
                <MetricTooltip
                  label={`거래횟수: ${selectedStrategySummary.metrics.tradeCount}회`}
                  tip="거래 빈도입니다. 너무 많으면 수수료/슬리피지 영향이 커질 수 있습니다."
                />
              </p>
            </div>
          ) : (
            <p>전략 요약 데이터가 없습니다.</p>
          )}
        </div>
        {error ? (
          <p className="text-sm text-rose-400">{error}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-slate-300">
              <thead className="text-xs uppercase tracking-wide text-slate-400">
                <tr>
                  <th className="px-2 py-2">기준일</th>
                  <th className="px-2 py-2">예측 방향</th>
                  <th className="px-2 py-2">상승 확률</th>
                  <th className="px-2 py-2">전일 대비</th>
                  <th className="px-2 py-2">실측</th>
                  <th className="px-2 py-2">정확도</th>
                </tr>
              </thead>
              <tbody>
                {(history?.items ?? []).map((item) => (
                  <tr key={`${item.predictionDate}-${item.predictedDirection}`} className="border-t border-slate-800">
                    <td className="px-2 py-2">{item.predictionDate}</td>
                    <td className="px-2 py-2">{directionToKorean(item.predictedDirection)}</td>
                    <td className="px-2 py-2">{(item.probabilityUp * 100).toFixed(1)}%</td>
                    <td className="px-2 py-2">
                      {item.probabilityDelta == null
                        ? '-'
                        : `${item.probabilityDelta > 0 ? '+' : ''}${(item.probabilityDelta * 100).toFixed(1)}%p`}
                    </td>
                    <td className="px-2 py-2">
                      {item.actualDirection ? `${directionToKorean(item.actualDirection)} (${item.actualDate})` : '대기 중'}
                    </td>
                    <td className="px-2 py-2">
                      {item.isCorrect == null ? '-' : item.isCorrect ? '적중' : '미적중'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

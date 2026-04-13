import { useEffect, useMemo, useState } from 'react'

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

function directionToKorean(direction: string) {
  if (direction === 'Up') return '상승'
  if (direction === 'Down') return '하락'
  return direction
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

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 200)
    return () => clearTimeout(timer)
  }, [search])

  const symbolsUrl = useMemo(
    () => `/api/symbols?market=${market}&q=${encodeURIComponent(debouncedSearch.trim())}&limit=30`,
    [debouncedSearch, market],
  )
  const { data: symbols } = useFetch<SymbolResponse>(symbolsUrl)
  const {
    data: history,
    loading,
    error,
  } = useFetch<HistoryResponse>(`/api/predictions/history/${encodeURIComponent(selected)}?limit=30`)
  const {
    data: summary,
    loading: summaryLoading,
    error: summaryError,
  } = useFetch<BacktestSummaryResponse>(`/api/backtest/summary/${encodeURIComponent(selected)}?market=${market}`)
  const selectedSymbolInfo = useMemo(
    () => (symbols?.items ?? []).find((item) => item.symbol === selected),
    [symbols, selected],
  )
  const selectedDisplayName = selectedSymbolInfo?.nameKr ?? selectedSymbolInfo?.name ?? selected

  useEffect(() => {
    setSelected(market === 'kr' ? '005930.KS' : 'AAPL')
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
        <div className="mb-3 rounded-lg border border-slate-800 bg-slate-950/60 p-3 text-xs text-slate-300">
          {summaryLoading ? (
            <p>전략 요약 계산 중...</p>
          ) : summaryError ? (
            <p className="text-rose-400">전략 요약 오류: {summaryError}</p>
          ) : selectedStrategySummary ? (
            <div className="grid gap-1 md:grid-cols-3">
              <p>총수익률: {(selectedStrategySummary.metrics.totalReturn * 100).toFixed(2)}%</p>
              <p>CAGR: {(selectedStrategySummary.metrics.cagr * 100).toFixed(2)}%</p>
              <p>최대낙폭: {(selectedStrategySummary.metrics.maxDrawdown * 100).toFixed(2)}%</p>
              <p>샤프: {selectedStrategySummary.metrics.sharpe.toFixed(2)}</p>
              <p>승률: {(selectedStrategySummary.metrics.winRate * 100).toFixed(1)}%</p>
              <p>거래횟수: {selectedStrategySummary.metrics.tradeCount}회</p>
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

import { useEffect, useMemo, useState } from 'react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

type CandlePoint = {
  date: string
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
  const {
    data: stock,
    loading: stockLoading,
    error: stockError,
  } = useFetch<CandlePoint[]>('/api/stock/AAPL')
  const {
    data: news,
    loading: newsLoading,
    error: newsError,
  } = useFetch<NewsItem[]>('/api/news')
  const {
    data: predict,
    loading: predictLoading,
    error: predictError,
  } = useFetch<PredictResponse>('/api/predict/AAPL')

  const chartData = useMemo(() => {
    return (
      stock?.map((pt) => ({
        date: new Date(pt.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        close: pt.close,
      })) ?? []
    )
  }, [stock])

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-blue-300">대시보드</p>
        <h2 className="text-2xl font-bold text-white">AAPL 주가 및 최신 뉴스</h2>
        <p className="text-sm text-slate-400">
          {/* 백엔드 `/api/stock/AAPL`과 `/api/news` 응답을 시각화합니다. */}
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-4 shadow-lg">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-blue-300">AI 예측</p>
              {/* <h3 className="text-lg font-semibold text-white">/api/predict/AAPL</h3> */}
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
              <div className="flex items-center justify-between text-sm text-slate-300">
                <span>최신 종가</span>
                <span>${predict.last_close}</span>
              </div>
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
            </div>
          ) : (
            <div className="mt-4 text-sm text-slate-400">예측 데이터가 없습니다.</div>
          )}
        </div>

        <div className="lg:col-span-2 rounded-2xl border border-slate-800 bg-slate-900/80 p-4 shadow-lg">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-white">AAPL 최근 1개월 종가</h3>
            {stockLoading && <span className="text-xs text-slate-400">불러오는 중...</span>}
            {stockError && <span className="text-xs text-rose-400">오류: {stockError}</span>}
          </div>
          <div className="h-72">
            {stockLoading ? (
              <div className="flex h-full items-center justify-center text-slate-500">불러오는 중...</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData}>
                  <defs>
                    <linearGradient id="closeGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#38bdf8" stopOpacity={0.5} />
                      <stop offset="95%" stopColor="#38bdf8" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                  <XAxis dataKey="date" tick={{ fill: '#cbd5f5', fontSize: 12 }} />
                  <YAxis tick={{ fill: '#cbd5f5', fontSize: 12 }} />
                  <Tooltip
                    contentStyle={{
                      background: '#0f172a',
                      border: '1px solid #1f2937',
                      color: '#e5e7eb',
                    }}
                  />
                  <Area
                    type="monotone"
                    dataKey="close"
                    stroke="#38bdf8"
                    strokeWidth={2}
                    fillOpacity={1}
                    fill="url(#closeGradient)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-4 shadow-lg">
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

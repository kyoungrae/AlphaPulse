import { useEffect, useState } from 'react'
import { apiUrl } from '../apiBase'

type FearGreed = {
  value: number
  classification: string
  timestamp: string
}

type CalendarItem = {
  date: string
  event: string
  impact: string
}

type SectorItem = {
  name: string
  symbol: string
  changePercent: number
}

export default function GlobalMacro() {
  const [fearGreed, setFearGreed] = useState<FearGreed | null>(null)
  const [calendar, setCalendar] = useState<CalendarItem[]>([])
  const [sectors, setSectors] = useState<SectorItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      fetch(apiUrl('/api/macro/fear-greed')).then((r) => r.json()),
      fetch(apiUrl('/api/macro/calendar')).then((r) => r.json()),
      fetch(apiUrl('/api/macro/sectors')).then((r) => r.json()),
    ])
      .then(([fg, cal, sec]) => {
        setFearGreed(fg)
        setCalendar(cal)
        setSectors(sec)
      })
      .finally(() => setLoading(false))
  }, [])

  return (
    <div className="space-y-6 text-slate-100">
      <div>
        <h2 className="text-2xl font-bold">글로벌 매크로</h2>
        <p className="text-slate-400">시장 심리, 경제 일정, 섹터 흐름을 한눈에 확인합니다.</p>
      </div>

      {loading ? (
        <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4 text-slate-400">
          불러오는 중...
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4">
            <h3 className="mb-3 text-lg font-semibold">공포/탐욕 지수</h3>
            {fearGreed ? (
              <>
                <p className="text-3xl font-bold">{fearGreed.value}</p>
                <p className="text-sm text-slate-300">{fearGreed.classification}</p>
              </>
            ) : (
              <p className="text-slate-400">데이터 없음</p>
            )}
          </div>

          <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4 lg:col-span-2">
            <h3 className="mb-3 text-lg font-semibold">오늘의 경제 일정</h3>
            <div className="space-y-2">
              {calendar.map((item) => (
                <div
                  key={`${item.date}-${item.event}`}
                  className="flex items-center justify-between rounded-lg bg-slate-950/70 px-3 py-2"
                >
                  <span className="text-sm">{item.event}</span>
                  <span className="text-xs text-slate-400">{item.impact}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4 lg:col-span-3">
            <h3 className="mb-3 text-lg font-semibold">섹터 히트맵(수익률)</h3>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
              {sectors.map((sector) => (
                <div
                  key={sector.symbol}
                  className={`rounded-lg border px-3 py-2 ${
                    sector.changePercent >= 0
                      ? 'border-emerald-700 bg-emerald-950/40'
                      : 'border-rose-700 bg-rose-950/40'
                  }`}
                >
                  <p className="text-sm font-semibold">{sector.name}</p>
                  <p className="text-xs text-slate-400">{sector.symbol}</p>
                  <p
                    className={`mt-1 text-sm font-bold ${
                      sector.changePercent >= 0 ? 'text-emerald-300' : 'text-rose-300'
                    }`}
                  >
                    {sector.changePercent >= 0 ? '+' : ''}
                    {sector.changePercent}%
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip as RechartsTooltip } from 'recharts'
import { apiUrl } from '../apiBase'

type HoldingRow = Record<string, unknown>

type TradeLog = {
  id: number
  time: string
  action: 'buy' | 'sell' | 'analyze' | 'buy_fail'
  symbol: string
  name: string
  qty: number
  price: number
  status: string
}

const PIE_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#64748b', '#06b6d4', '#f43f5e']

function parseNum(v: unknown): number {
  if (v == null) return 0
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0
  const s = String(v).replace(/,/g, '').trim()
  const n = Number(s)
  return Number.isFinite(n) ? n : 0
}

function holdingQty(h: HoldingRow): number {
  return parseNum(h.hldg_qty ?? h.hold_qty)
}

function logDateKst(iso: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(iso))
  } catch {
    return ''
  }
}

export default function Portfolio() {
  const [cash, setCash] = useState(0)
  const [holdings, setHoldings] = useState<HoldingRow[]>([])
  const [logs, setLogs] = useState<TradeLog[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [startDate, setStartDate] = useState(() => {
    const d = new Date()
    d.setDate(d.getDate() - 30)
    return d.toISOString().slice(0, 10)
  })
  const [endDate, setEndDate] = useState(() => new Date().toISOString().slice(0, 10))

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const statusRes = await fetch(apiUrl('/api/trading/status'))
      const statusData = (await statusRes.json()) as {
        balance?: { cash?: number; holdings?: HoldingRow[] }
        error?: string
      }
      if (!statusRes.ok) throw new Error(statusData.error || '잔고 조회 실패')
      setCash(Number(statusData.balance?.cash ?? 0))
      setHoldings(Array.isArray(statusData.balance?.holdings) ? statusData.balance!.holdings! : [])

      const logsRes = await fetch(apiUrl('/api/trading/logs'))
      if (logsRes.ok) {
        const logsData = (await logsRes.json()) as { logs?: TradeLog[] }
        setLogs(Array.isArray(logsData.logs) ? logsData.logs : [])
      } else {
        setLogs([])
      }
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : String(err))
      setCash(0)
      setHoldings([])
      setLogs([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchData()
  }, [fetchData])

  const holdingsWithQty = useMemo(() => holdings.filter((h) => holdingQty(h) > 0), [holdings])

  const totalStockValue = useMemo(
    () => holdingsWithQty.reduce((acc, h) => acc + parseNum(h.evlu_amt), 0),
    [holdingsWithQty],
  )

  const totalAsset = cash + totalStockValue

  const totalEvalPnl = useMemo(
    () => holdingsWithQty.reduce((acc, h) => acc + parseNum(h.evlu_pfls_amt), 0),
    [holdingsWithQty],
  )

  /** 주식 평가액 기준 대략적 수익률 (매입원가 ≈ 평가액 − 평가손익) */
  const totalStockCost = useMemo(
    () => holdingsWithQty.reduce((acc, h) => acc + (parseNum(h.evlu_amt) - parseNum(h.evlu_pfls_amt)), 0),
    [holdingsWithQty],
  )
  const portfolioPnlRate = totalStockCost > 0 ? (totalEvalPnl / totalStockCost) * 100 : 0

  const pieData = useMemo(() => {
    const rows = holdingsWithQty.map((h) => ({
      name: String(h.prdt_name ?? h.hts_kor_isnm ?? h.pdno ?? '종목'),
      value: parseNum(h.evlu_amt),
    }))
    if (cash > 0) rows.push({ name: '예수금(현금)', value: cash })
    return rows.sort((a, b) => b.value - a.value)
  }, [holdingsWithQty, cash])

  const filteredLogs = useMemo(() => {
    return logs.filter((log) => {
      if (log.action === 'analyze') return false
      const d = logDateKst(log.time)
      if (!d) return false
      return d >= startDate && d <= endDate
    })
  }, [logs, startDate, endDate])

  if (loading) {
    return (
      <div className="animate-pulse py-10 text-center text-slate-400">잔고 데이터를 불러오는 중입니다...</div>
    )
  }

  return (
    <div className="space-y-6 text-slate-100">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-blue-300">Portfolio</p>
        <h2 className="text-2xl font-bold text-white">잔고 현황</h2>
        <p className="text-sm text-slate-400">보유 자산 비중, 평가 손익, 기간별 봇 매매 로그를 한 화면에서 확인합니다.</p>
        {error && <p className="mt-2 text-xs text-rose-400">오류: {error}</p>}
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-5 shadow-lg">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">총 자산</p>
          <p className="mt-2 text-2xl font-bold text-white tabular-nums">{totalAsset.toLocaleString()}원</p>
          <p className="mt-1 text-[10px] text-slate-500">현금 + 주식 평가액 합</p>
        </div>
        <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-5 shadow-lg">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">예수금(현금)</p>
          <p className="mt-2 text-2xl font-bold text-blue-300 tabular-nums">{cash.toLocaleString()}원</p>
          <p className="mt-1 text-[10px] text-slate-500">주문 가능 현금</p>
        </div>
        <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-5 shadow-lg">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">주식 평가액</p>
          <p className="mt-2 text-2xl font-bold text-slate-100 tabular-nums">{totalStockValue.toLocaleString()}원</p>
          <p className="mt-1 text-[10px] text-slate-500">보유 종목 시가 평가 합</p>
        </div>
        <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-5 shadow-lg">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">평가 손익 / 수익률</p>
          <div className="mt-2 flex flex-wrap items-baseline gap-2">
            <p className={`text-2xl font-bold tabular-nums ${totalEvalPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
              {totalEvalPnl >= 0 ? '+' : ''}
              {totalEvalPnl.toLocaleString()}원
            </p>
            <p className={`text-sm font-semibold tabular-nums ${totalEvalPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
              ({portfolioPnlRate >= 0 ? '+' : ''}
              {portfolioPnlRate.toFixed(2)}%)
            </p>
          </div>
          <p className="mt-1 text-[10px] text-slate-500">보유 종목 미실현 기준 · 증권사 잔고 API 값</p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="flex min-h-[280px] flex-col rounded-2xl border border-slate-800 bg-slate-900/80 p-5 shadow-lg lg:col-span-1">
          <h3 className="mb-2 text-sm font-semibold text-white">포트폴리오 비중</h3>
          <p className="mb-3 text-[10px] leading-snug text-slate-500">현금과 보유 종목 평가액 비율(도넛)</p>
          <div className="relative min-h-[220px] flex-1 w-full">
            {pieData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={pieData}
                    cx="50%"
                    cy="50%"
                    innerRadius={52}
                    outerRadius={78}
                    paddingAngle={2}
                    dataKey="value"
                    stroke="none"
                  >
                    {pieData.map((_, index) => (
                      <Cell key={`cell-${index}`} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                    ))}
                  </Pie>
                  <RechartsTooltip
                    formatter={(value) => [`${Number(value ?? 0).toLocaleString()}원`, '금액']}
                    contentStyle={{
                      backgroundColor: '#0f172a',
                      borderColor: '#334155',
                      color: '#f8fafc',
                      fontSize: '12px',
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: '11px', color: '#cbd5e1' }} />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <div className="absolute inset-0 flex items-center justify-center text-xs text-slate-500">
                표시할 보유 자산이 없습니다.
              </div>
            )}
          </div>
        </div>

        <div className="overflow-x-auto rounded-2xl border border-slate-800 bg-slate-900/80 p-5 shadow-lg lg:col-span-2">
          <h3 className="mb-2 text-sm font-semibold text-white">보유 종목</h3>
          <p className="mb-4 text-[10px] text-slate-500">한국투자 잔고 API(output1) 기준</p>
          <table className="w-full whitespace-nowrap text-left text-xs">
            <thead className="border-b border-slate-700 text-slate-500">
              <tr>
                <th className="py-2 pr-4 font-normal">종목</th>
                <th className="py-2 pr-4 text-right font-normal">수량</th>
                <th className="py-2 pr-4 text-right font-normal">매입단가</th>
                <th className="py-2 pr-4 text-right font-normal">현재가</th>
                <th className="py-2 pr-4 text-right font-normal">평가금액</th>
                <th className="py-2 text-right font-normal">평가손익</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 text-slate-300">
              {holdingsWithQty.length > 0 ? (
                holdingsWithQty.map((h, i) => {
                  const pnl = parseNum(h.evlu_pfls_amt)
                  const pnlRt = parseNum(h.evlu_pfls_rt)
                  const name = String(h.prdt_name ?? h.hts_kor_isnm ?? h.pdno ?? '-')
                  const code = String(h.pdno ?? '')
                  return (
                    <tr key={`${code}-${i}`} className="hover:bg-slate-800/40">
                      <td className="py-3 pr-4">
                        <div className="font-semibold text-slate-200">{name}</div>
                        <div className="text-[10px] text-slate-500">{code}</div>
                      </td>
                      <td className="py-3 pr-4 text-right tabular-nums">{holdingQty(h).toLocaleString()}주</td>
                      <td className="py-3 pr-4 text-right tabular-nums text-slate-400">
                        {parseNum(h.pchs_avg_pric).toLocaleString()}원
                      </td>
                      <td className="py-3 pr-4 text-right tabular-nums font-semibold text-slate-200">
                        {parseNum(h.prpr ?? h.stck_prpr).toLocaleString()}원
                      </td>
                      <td className="py-3 pr-4 text-right tabular-nums">{parseNum(h.evlu_amt).toLocaleString()}원</td>
                      <td className={`py-3 text-right tabular-nums font-semibold ${pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                        {pnl >= 0 ? '+' : ''}
                        {pnl.toLocaleString()}원
                        <span className="mt-0.5 block text-[10px] font-medium opacity-90">
                          ({pnlRt >= 0 ? '+' : ''}
                          {pnlRt.toFixed(2)}%)
                        </span>
                      </td>
                    </tr>
                  )
                })
              ) : (
                <tr>
                  <td colSpan={6} className="py-10 text-center text-slate-500">
                    보유 중인 종목이 없습니다.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-5 shadow-lg">
        <div className="mb-4 flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
          <div>
            <h3 className="text-sm font-semibold text-white">기간별 매매 내역</h3>
            <p className="mt-1 text-[10px] text-slate-500">
              AlphaPulse 봇 로그 기준(한국 시간 날짜 필터). 증권사 전체 체결내역과 다를 수 있습니다.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-slate-300 outline-none focus:border-blue-500"
            />
            <span className="text-slate-500">~</span>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-slate-300 outline-none focus:border-blue-500"
            />
            <button
              type="button"
              onClick={() => void fetchData()}
              className="rounded border border-slate-600 px-2 py-1 text-slate-300 hover:bg-slate-800"
            >
              새로고침
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full whitespace-nowrap text-left text-xs">
            <thead className="border-b border-slate-700 text-slate-500">
              <tr>
                <th className="py-2 pr-4 font-normal">일시</th>
                <th className="py-2 pr-4 font-normal">구분</th>
                <th className="py-2 pr-4 font-normal">종목</th>
                <th className="py-2 pr-4 text-right font-normal">단가</th>
                <th className="py-2 pr-4 text-right font-normal">수량</th>
                <th className="py-2 pl-4 text-right font-normal">금액</th>
                <th className="py-2 pl-4 text-right font-normal">상태</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 text-slate-300">
              {filteredLogs.length > 0 ? (
                filteredLogs.map((log) => {
                  const isBuy = log.action === 'buy'
                  const isFail = log.action === 'buy_fail'
                  const totalAmount = log.price * log.qty
                  const label =
                    log.name.includes('(') && log.name.includes(')')
                      ? log.name.slice(0, log.name.lastIndexOf('(')).trim()
                      : log.name
                  return (
                    <tr key={log.id} className="hover:bg-slate-800/40">
                      <td className="py-3 pr-4 font-mono text-slate-400">
                        {new Date(log.time).toLocaleString('ko-KR', {
                          timeZone: 'Asia/Seoul',
                          month: '2-digit',
                          day: '2-digit',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </td>
                      <td className="py-3 pr-4">
                        <span
                          className={`rounded px-2 py-0.5 font-bold ${
                            isBuy
                              ? 'bg-emerald-500/10 text-emerald-400'
                              : isFail
                                ? 'bg-amber-500/10 text-amber-400'
                                : 'bg-rose-500/10 text-rose-400'
                          }`}
                        >
                          {isBuy ? '매수' : isFail ? '매수실패' : '매도'}
                        </span>
                      </td>
                      <td className="py-3 pr-4">
                        <span className="font-medium text-slate-200">{label}</span>
                        <span className="ml-1 text-[10px] text-slate-500">({log.symbol})</span>
                      </td>
                      <td className="py-3 pr-4 text-right tabular-nums">
                        {log.price > 0 ? `${log.price.toLocaleString()}원` : '-'}
                      </td>
                      <td className="py-3 pr-4 text-right tabular-nums">{log.qty > 0 ? `${log.qty}주` : '-'}</td>
                      <td
                        className={`py-3 pl-4 text-right font-semibold tabular-nums ${
                          isBuy ? 'text-blue-300' : isFail ? 'text-slate-500' : 'text-rose-300'
                        }`}
                      >
                        {totalAmount > 0 ? `${totalAmount.toLocaleString()}원` : '-'}
                      </td>
                      <td className="py-3 pl-4 text-right">
                        <span className="rounded bg-slate-800 px-2 py-0.5 text-[10px] text-slate-400">{log.status}</span>
                      </td>
                    </tr>
                  )
                })
              ) : (
                <tr>
                  <td colSpan={7} className="py-10 text-center text-slate-500">
                    선택한 기간에 해당하는 매매 로그가 없습니다.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

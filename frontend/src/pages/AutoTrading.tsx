import { type ChangeEvent, useEffect, useState } from 'react'
import { apiUrl } from '../apiBase'

function formatAmountWithKoreanUnit(amount: number): string {
  const n = Math.max(0, Math.floor(amount))
  if (n === 0) return '0원'
  const eok = Math.floor(n / 100_000_000)
  const man = Math.floor((n % 100_000_000) / 10_000)
  const rest = n % 10_000
  const parts: string[] = []
  if (eok > 0) parts.push(`${eok.toLocaleString('ko-KR')}억`)
  if (man > 0) parts.push(`${man.toLocaleString('ko-KR')}만`)
  if (rest > 0) parts.push(`${rest.toLocaleString('ko-KR')}`)
  return `${parts.join(' ')}원`
}

export default function AutoTrading() {
  const tradableSymbolOptions = [
    { symbol: '122630.KS', label: 'KODEX 레버리지 (122630.KS)' },
    { symbol: '252710.KS', label: 'TIGER 200선물인버스2X (252710.KS)' },
    { symbol: '360750.KS', label: 'TIGER 미국S&P500 (360750.KS)' },
    { symbol: '214980.KS', label: 'KODEX 미국S&P500선물인버스(H) (214980.KS)' },
    { symbol: '069500.KS', label: 'KODEX 200 (069500.KS)' },
    { symbol: '114800.KS', label: 'KODEX 인버스 (114800.KS)' },
    { symbol: '005930.KS', label: '삼성전자 (005930.KS)' },
  ]
  const [isActive, setIsActive] = useState(false)
  const [aiTicker, setAiTicker] = useState('^KS200')
  const [upSymbol, setUpSymbol] = useState('122630.KS')
  const [downSymbol, setDownSymbol] = useState('252710.KS')
  const [symbolsLocked, setSymbolsLocked] = useState(true)
  const [threshold, setThreshold] = useState(60)
  const [tradeAmount, setTradeAmount] = useState(1_000_000)

  const [accountInfo, setAccountInfo] = useState({
    totalAsset: 0,
    cash: 0,
    connected: false,
    loading: true,
    error: null as string | null,
  })
  const [configSaving, setConfigSaving] = useState(false)

  const aiTickerNameMap: Record<string, string> = {
    '^KS200': '코스피 200',
    '^KS11': '코스피',
    '^GSPC': 'S&P 500',
    '^IXIC': '나스닥 종합',
    '^DJI': '다우존스',
  }
  const aiTickerOptions = Object.entries(aiTickerNameMap).map(([value, label]) => ({ value, label }))
  const aiTickerLabel = aiTickerNameMap[aiTicker.trim().toUpperCase()] ?? '직접 입력 티커'

  const currentSignal = {
    date: '2026-04-22',
    direction: 'Up',
    probability: 73.2,
    recommendedAction: 'KODEX 레버리지 매수',
  }

  const tradeLogs = [
    {
      id: 1,
      time: '2026-04-21 09:01:12',
      action: '매수',
      symbol: '122630.KS',
      name: 'KODEX 레버리지',
      qty: 50,
      price: 18_450,
      status: '체결완료',
    },
    {
      id: 2,
      time: '2026-04-21 09:00:05',
      action: '매도',
      symbol: '252710.KS',
      name: 'TIGER 200선물인버스2X',
      qty: 210,
      price: 2_130,
      status: '체결완료',
    },
    {
      id: 3,
      time: '2026-04-20 15:25:00',
      action: '분석',
      symbol: 'KOSPI200',
      name: 'AI 예측',
      qty: 0,
      price: 0,
      status: '상승(68%) 예측',
    },
  ]

  useEffect(() => {
    let isMounted = true
    const fetchStatus = async () => {
      try {
        const res = await fetch(apiUrl('/api/trading/status'))
        const data = (await res.json()) as {
          config?: {
            isActive?: boolean
            aiTicker?: string
            upSymbol?: string
            downSymbol?: string
            symbolsLocked?: boolean
            threshold?: number
            tradeAmount?: number
          }
          balance?: { cash?: number }
          error?: string
        }
        if (!res.ok) throw new Error(data.error || '연결 실패')
        if (!isMounted) return
        const cash = Number(data.balance?.cash ?? 0)
        setAccountInfo({
          totalAsset: Number.isFinite(cash) ? cash : 0,
          cash: Number.isFinite(cash) ? cash : 0,
          connected: true,
          loading: false,
          error: null,
        })
        setIsActive(Boolean(data.config?.isActive))
        setAiTicker(data.config?.aiTicker ?? '^KS200')
        setUpSymbol(data.config?.upSymbol ?? '122630.KS')
        setDownSymbol(data.config?.downSymbol ?? '252710.KS')
        setSymbolsLocked(data.config?.symbolsLocked ?? true)
        setThreshold(Math.max(50, Math.min(99, Number(data.config?.threshold ?? 60))))
        setTradeAmount(Math.max(1, Number(data.config?.tradeAmount ?? 1_000_000)))
      } catch (err) {
        if (!isMounted) return
        setAccountInfo((prev) => ({
          ...prev,
          connected: false,
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        }))
      }
    }
    void fetchStatus()
    return () => {
      isMounted = false
    }
  }, [])

  const updateConfig = async (
    patch?: Partial<{
      isActive: boolean
      aiTicker: string
      upSymbol: string
      downSymbol: string
      symbolsLocked: boolean
      threshold: number
      tradeAmount: number
    }>,
  ) => {
    setConfigSaving(true)
    try {
      const payload = {
        isActive,
        aiTicker,
        upSymbol,
        downSymbol,
        symbolsLocked,
        threshold,
        tradeAmount,
        ...(patch ?? {}),
      }
      const res = await fetch(apiUrl('/api/trading/config'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const text = await res.text()
        throw new Error(text || '설정 저장 실패')
      }
    } catch (err) {
      setAccountInfo((prev) => ({ ...prev, error: err instanceof Error ? err.message : String(err) }))
      window.alert('설정을 저장하지 못했습니다. 서버 상태를 확인해주세요.')
    } finally {
      setConfigSaving(false)
    }
  }

  const handleToggleActive = () => {
    const nextState = !isActive
    setIsActive(nextState)
    void updateConfig({ isActive: nextState })
  }

  const handleThresholdChange = (e: ChangeEvent<HTMLInputElement>) => {
    const val = Number(e.target.value)
    setThreshold(val)
  }

  const handleTradeAmountChange = (e: ChangeEvent<HTMLInputElement>) => {
    const digits = e.target.value.replace(/[^\d]/g, '')
    const val = Number(digits)
    setTradeAmount(Number.isFinite(val) ? val : 0)
  }

  const handleToggleSymbolsLock = () => {
    const next = !symbolsLocked
    setSymbolsLocked(next)
    void updateConfig({
      symbolsLocked: next,
      aiTicker,
      upSymbol,
      downSymbol,
      threshold,
      tradeAmount,
    })
  }

  const handleManualRun = async () => {
    if (!window.confirm('현재 설정으로 매매 프로세스를 강제 실행하시겠습니까?\n(DRY_RUN 모드면 로그만 찍힙니다.)')) return
    try {
      const res = await fetch(apiUrl('/api/trading/run-now'), { method: 'POST' })
      const data = (await res.json()) as { message?: string; error?: string }
      if (!res.ok) throw new Error(data.error || '실행 실패')
      window.alert(data.message || '수동 실행이 시작되었습니다.')
    } catch (err) {
      window.alert(`실행 실패: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return (
    <div className="space-y-6 text-slate-100">
      {/* 헤더 영역 */}
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-blue-300">트레이딩 봇</p>
        <h2 className="text-2xl font-bold text-white">AI 자동 매매 설정</h2>
        <p className="text-sm text-slate-400">AI 예측 모델의 결과에 따라 레버리지/인버스 ETF를 자동으로 스위칭합니다.</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* 왼쪽 1단: 봇 상태 및 계좌 요약 */}
        <div className="space-y-6 lg:col-span-1">
          {/* 메인 스위치 카드 */}
          <div className="flex flex-col items-center justify-center rounded-2xl border border-slate-800 bg-slate-900/80 p-5 text-center shadow-lg">
            <p className="mb-4 text-sm font-semibold text-slate-300">자동 매매 시스템 상태</p>
            <button
              onClick={handleToggleActive}
              className={`relative inline-flex h-12 w-24 items-center rounded-full transition-colors duration-300 focus:outline-none ${
                isActive ? 'bg-blue-600' : 'bg-slate-700'
              }`}
            >
              <span
                className={`inline-block h-10 w-10 rounded-full bg-white transition-transform duration-300 ${
                  isActive ? 'translate-x-13' : 'translate-x-1'
                }`}
                style={{ transform: isActive ? 'translateX(3.2rem)' : 'translateX(0.25rem)' }}
              />
            </button>
            <p className={`mt-4 text-xl font-bold ${isActive ? 'text-blue-400' : 'text-slate-500'}`}>
              {isActive ? '운영 중 (ON)' : '중지됨 (OFF)'}
            </p>
            <p className="mt-2 text-xs text-slate-400">
              {isActive ? '매일 아침 9시 장 시작 시 AI 시그널에 따라 주문이 실행됩니다.' : '현재 자동으로 매매가 실행되지 않습니다.'}
            </p>
            <button
              type="button"
              onClick={handleManualRun}
              className="mt-4 rounded-lg border border-emerald-500/50 bg-emerald-600/20 px-4 py-2 text-sm font-semibold text-emerald-400 transition-colors hover:bg-emerald-600/40"
            >
              ▶ 수동 즉시 실행 (테스트용)
            </button>
            {configSaving && <p className="mt-1 text-[11px] text-slate-400">설정 저장 중...</p>}
          </div>

          {/* 계좌 연동 상태 */}
          <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-5 shadow-lg">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-white">한국투자증권 연동 상태</h3>
              <span className={`flex items-center gap-1.5 text-xs ${accountInfo.connected ? 'text-emerald-400' : 'text-rose-400'}`}>
                <span className="relative flex h-2 w-2">
                  {accountInfo.connected && (
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"></span>
                  )}
                  <span className={`relative inline-flex h-2 w-2 rounded-full ${accountInfo.connected ? 'bg-emerald-500' : 'bg-rose-500'}`}></span>
                </span>
                {accountInfo.loading ? '확인 중' : accountInfo.connected ? '연결됨' : '미연결'}
              </span>
            </div>
            <div className="space-y-3 text-sm">
              <div className="flex justify-between text-slate-300">
                <span>총 자산 (추정)</span>
                <span className="font-semibold text-white">{accountInfo.totalAsset.toLocaleString()}원</span>
              </div>
              <div className="flex justify-between text-slate-300">
                <span>매수 가능 예수금</span>
                <span className="font-semibold text-blue-300">{accountInfo.cash.toLocaleString()}원</span>
              </div>
            </div>
            {accountInfo.error && <p className="mt-3 text-xs text-rose-400">오류: {accountInfo.error}</p>}
          </div>
        </div>

        {/* 오른쪽 2단: 전략 설정 및 로그 */}
        <div className="space-y-6 lg:col-span-2">
          {/* 전략 설정 카드 */}
          <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-5 shadow-lg">
            <h3 className="mb-4 text-lg font-semibold text-white">매매 전략 파라미터</h3>
            <div className="mb-4 flex items-center justify-between rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2">
              <p className="text-xs text-slate-400">AI 예측 티커 / 상승·하락 매수 / 진입 확률 잠금</p>
              <button
                type="button"
                onClick={handleToggleSymbolsLock}
                className={`rounded px-2.5 py-1 text-[11px] font-semibold ${
                  symbolsLocked
                    ? 'border border-amber-500/50 bg-amber-500/15 text-amber-300'
                    : 'border border-slate-600 bg-slate-800 text-slate-300'
                }`}
              >
                {symbolsLocked ? '잠금됨' : '잠금 해제'}
              </button>
            </div>
            <div className="grid md:grid-cols-2" style={{ gap: '25px' }}>
              <div className="space-y-1">
                <label className="text-xs font-semibold text-slate-400">AI 예측 티커 (Yahoo)</label>
                <select
                  value={aiTicker}
                  disabled={symbolsLocked}
                  onChange={(e) => {
                    const val = e.target.value
                    setAiTicker(val)
                  }}
                  className={`w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-blue-500 ${
                    symbolsLocked ? 'cursor-not-allowed opacity-60' : ''
                  }`}
                >
                  {aiTickerOptions.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label} ({opt.value})
                    </option>
                  ))}
                </select>
                <p className="text-[10px] text-slate-500">현재 해석: {aiTickerLabel}</p>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-semibold text-slate-400">진입 기준 확률 (Threshold)</label>
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min="50"
                    max="90"
                    step="1"
                    value={threshold}
                    onChange={handleThresholdChange}
                    disabled={symbolsLocked}
                    className="flex-1 accent-blue-500"
                  />
                  <span className="w-14 text-right text-sm font-semibold tabular-nums text-blue-300">{threshold}%</span>
                </div>
                <p className="text-[10px] text-slate-500">AI 예측 확률이 이 수치 이상일 때만 매수(이하는 현금 관망)</p>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-semibold text-slate-400">회당 투자 금액</label>
                <input
                  type="text"
                  inputMode="numeric"
                  value={tradeAmount.toLocaleString('ko-KR')}
                  onChange={handleTradeAmountChange}
                  disabled={symbolsLocked}
                  className={`w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-blue-500 ${
                    symbolsLocked ? 'cursor-not-allowed opacity-60' : ''
                  }`}
                />
                <p className="text-[10px] text-slate-500">
                  {formatAmountWithKoreanUnit(tradeAmount)} · 예수금이 부족할 경우 전액 매수합니다.
                </p>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-semibold text-emerald-400">상승 시 매수 (UP)</label>
                <select
                  value={upSymbol}
                  disabled={symbolsLocked}
                  onChange={(e) => {
                    const val = e.target.value
                    setUpSymbol(val)
                  }}
                  className={`w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-blue-500 ${
                    symbolsLocked ? 'cursor-not-allowed opacity-60' : ''
                  }`}
                >
                  {tradableSymbolOptions.map((opt) => (
                    <option key={`up-${opt.symbol}`} value={opt.symbol}>
                      {opt.label}
                    </option>
                  ))}
                </select>
                <label className="mt-2 block text-xs font-semibold text-rose-400">하락 시 매수 (DOWN)</label>
                <select
                  value={downSymbol}
                  disabled={symbolsLocked}
                  onChange={(e) => {
                    const val = e.target.value
                    setDownSymbol(val)
                  }}
                  className={`w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-blue-500 ${
                    symbolsLocked ? 'cursor-not-allowed opacity-60' : ''
                  }`}
                >
                  {tradableSymbolOptions.map((opt) => (
                    <option key={`down-${opt.symbol}`} value={opt.symbol}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* 현재 시그널 요약 */}
          <div className="flex items-center justify-between rounded-2xl border border-blue-900/30 bg-blue-950/20 p-5 shadow-lg">
            <div>
              <p className="text-xs font-semibold text-blue-300">내일 장 시작 시 실행 예정 시그널</p>
              <p className="mt-1 text-sm text-slate-200">
                {currentSignal.date} 기준 {aiTickerLabel} ({aiTicker}){' '}
                <span className="font-bold text-emerald-400">
                  {currentSignal.direction === 'Up' ? '상승' : '하락'} 확률 {currentSignal.probability}%
                </span>
              </p>
            </div>
            <div className="text-right">
              <span className="rounded-lg border border-blue-500/30 bg-blue-600/20 px-3 py-1.5 text-sm font-bold text-blue-300">
                {currentSignal.recommendedAction}
              </span>
            </div>
          </div>

          {/* 실행 로그 테이블 */}
          <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-5 shadow-lg">
            <h3 className="mb-4 text-sm font-semibold text-white">최근 실행 로그</h3>
            <div className="overflow-x-auto">
              <table className="w-full whitespace-nowrap text-left text-xs text-slate-300">
                <thead className="border-b border-slate-700 text-slate-500">
                  <tr>
                    <th className="py-2 pr-4 font-normal">시간</th>
                    <th className="py-2 pr-4 font-normal">구분</th>
                    <th className="py-2 pr-4 font-normal">종목</th>
                    <th className="py-2 pr-4 text-right font-normal">단가/수량</th>
                    <th className="py-2 pl-4 text-right font-normal">상태</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {tradeLogs.map((log) => (
                    <tr key={log.id} className="hover:bg-slate-800/40">
                      <td className="py-2.5 pr-4 text-slate-400">{log.time}</td>
                      <td className="py-2.5 pr-4">
                        <span
                          className={`font-semibold ${
                            log.action === '매수' ? 'text-rose-400' : log.action === '매도' ? 'text-blue-400' : 'text-emerald-400'
                          }`}
                        >
                          {log.action}
                        </span>
                      </td>
                      <td className="py-2.5 pr-4">
                        {log.name} <span className="text-[10px] text-slate-500">({log.symbol})</span>
                      </td>
                      <td className="py-2.5 pr-4 text-right tabular-nums">
                        {log.price > 0 ? `${log.price.toLocaleString()}원 / ${log.qty}주` : '-'}
                      </td>
                      <td className="py-2.5 pl-4 text-right">
                        <span className="rounded bg-slate-800 px-2 py-1 text-[10px] text-slate-300">{log.status}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

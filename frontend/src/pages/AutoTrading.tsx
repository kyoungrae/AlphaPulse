import { type ChangeEvent, useEffect, useMemo, useState } from 'react'
import { apiUrl } from '../apiBase'

type Market = 'us' | 'kr'
type SymbolItem = { symbol: string; name: string; nameKr?: string }
type SymbolResponse = { market: Market; total: number; items: SymbolItem[] }
type WatchlistEntry = { symbol: string; market: Market; name?: string }
type TradingAction = 'buy' | 'sell' | 'analyze' | 'buy_fail'
type AutoTradeLog = {
  id: number
  time: string
  action: TradingAction
  symbol: string
  name: string
  qty: number
  price: number
  status: string
}

const WATCHLIST_STORAGE_KEY = 'alphapulse_watchlist_v1'

function loadWatchlistFromStorage(): WatchlistEntry[] {
  try {
    const raw = localStorage.getItem(WATCHLIST_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((r): WatchlistEntry | null => {
        const symbol = String(r?.symbol ?? '')
          .trim()
          .toUpperCase()
        const market: Market = r?.market === 'kr' ? 'kr' : 'us'
        const name = typeof r?.name === 'string' ? r.name : undefined
        if (!symbol) return null
        return { symbol, market, name }
      })
      .filter((v): v is WatchlistEntry => Boolean(v))
  } catch {
    return []
  }
}

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

function normalizeSymbol(value: string): string {
  return value.trim().toUpperCase()
}

export default function AutoTrading() {
  const fallbackTradableSymbolOptions = [
    { symbol: '122630.KS', label: 'KODEX 레버리지 (122630.KS)' },
    { symbol: '252710.KS', label: 'TIGER 200선물인버스2X (252710.KS)' },
    { symbol: '226490.KS', label: 'KODEX 코스피 (226490.KS)' },
    { symbol: '069500.KS', label: 'KODEX 200 (069500.KS)' },
    { symbol: '105190.KS', label: 'ACE 200 (105190.KS)' },
    { symbol: '114800.KS', label: 'KODEX 인버스 (114800.KS)' },
  ]
  const [isActive, setIsActive] = useState(false)
  const [isDryRun, setIsDryRun] = useState(true)
  const [aiTicker, setAiTicker] = useState('^KS200')
  const [upSymbol, setUpSymbol] = useState('122630.KS')
  const [downSymbol, setDownSymbol] = useState('252710.KS')
  const [symbolsLocked, setSymbolsLocked] = useState(true)
  const [threshold, setThreshold] = useState(60)
  const [tradeAmount, setTradeAmount] = useState(1_000_000)
  const [tradableSymbolOptions, setTradableSymbolOptions] = useState(fallbackTradableSymbolOptions)
  const [symbolPickerOpen, setSymbolPickerOpen] = useState(false)
  const [symbolPickerTarget, setSymbolPickerTarget] = useState<'up' | 'down'>('up')
  const [symbolPickerQuery, setSymbolPickerQuery] = useState('')
  const [symbolPickerMarket, setSymbolPickerMarket] = useState<Market>('kr')
  const [symbolPickerFavoritesOnly, setSymbolPickerFavoritesOnly] = useState(false)
  const [symbolPickerItems, setSymbolPickerItems] = useState<SymbolItem[]>([])
  const [symbolPickerLoading, setSymbolPickerLoading] = useState(false)
  const [symbolPickerError, setSymbolPickerError] = useState<string | null>(null)
  const [watchlist, setWatchlist] = useState<WatchlistEntry[]>(() => loadWatchlistFromStorage())

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

  const [tradeLogs, setTradeLogs] = useState<AutoTradeLog[]>([])

  useEffect(() => {
    let isMounted = true
    const fetchAllData = async () => {
      try {
        const statusRes = await fetch(apiUrl('/api/trading/status'))
        const statusData = (await statusRes.json()) as {
          config?: {
            isActive?: boolean
            isDryRun?: boolean
            aiTicker?: string
            upSymbol?: string
            downSymbol?: string
            symbolsLocked?: boolean
            threshold?: number
            tradeAmount?: number
          }
          logs?: AutoTradeLog[]
          balance?: { cash?: number }
          error?: string
        }
        if (!statusRes.ok) throw new Error(statusData.error || '연결 실패')
        if (!isMounted) return
        const cash = Number(statusData.balance?.cash ?? 0)
        setAccountInfo({
          totalAsset: Number.isFinite(cash) ? cash : 0,
          cash: Number.isFinite(cash) ? cash : 0,
          connected: true,
          loading: false,
          error: null,
        })
        setIsActive(Boolean(statusData.config?.isActive))
        setIsDryRun(statusData.config?.isDryRun !== false)
        setAiTicker(statusData.config?.aiTicker ?? '^KS200')
        setUpSymbol(normalizeSymbol(statusData.config?.upSymbol ?? '122630.KS'))
        setDownSymbol(normalizeSymbol(statusData.config?.downSymbol ?? '252710.KS'))
        setSymbolsLocked(statusData.config?.symbolsLocked ?? true)
        setThreshold(Math.max(50, Math.min(99, Number(statusData.config?.threshold ?? 60))))
        setTradeAmount(Math.max(1, Number(statusData.config?.tradeAmount ?? 1_000_000)))
        setTradeLogs(Array.isArray(statusData.logs) ? statusData.logs : [])

        const logsRes = await fetch(apiUrl('/api/trading/logs'))
        if (!isMounted) return
        if (logsRes.ok) {
          const logsData = (await logsRes.json()) as { logs?: AutoTradeLog[] }
          setTradeLogs(Array.isArray(logsData.logs) ? logsData.logs : [])
        }
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
    void fetchAllData()
    const timer = window.setInterval(() => {
      void fetchAllData()
    }, 30_000)
    return () => {
      isMounted = false
      window.clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const fetchEtfSymbols = async () => {
      try {
        const res = await fetch(apiUrl('/api/symbols/kr-etf?limit=2000'))
        const data = (await res.json()) as {
          items?: Array<{ symbol?: string; name?: string; nameKr?: string }>
          error?: string
        }
        if (!res.ok) throw new Error(data.error || 'ETF 목록 조회 실패')
        if (cancelled) return
        const items = (data.items ?? [])
          .map((item) => {
            const symbol = String(item.symbol ?? '').trim().toUpperCase()
            const name = String(item.nameKr ?? item.name ?? '').trim() || symbol
            return { symbol, label: `${name} (${symbol})` }
          })
          .filter((item) => item.symbol.length > 0)
        if (items.length > 0) {
          const merged = Array.from(
            new Map(
              [...fallbackTradableSymbolOptions, ...items].map((opt) => [opt.symbol.toUpperCase(), opt] as const),
            ).values(),
          )
          setTradableSymbolOptions(merged)
        }
      } catch {
        // fallback 목록 사용
      }
    }
    void fetchEtfSymbols()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!symbolPickerOpen) return
    if (symbolPickerFavoritesOnly) return
    const ac = new AbortController()
    const q = symbolPickerQuery.trim()
    const run = async () => {
      setSymbolPickerLoading(true)
      setSymbolPickerError(null)
      try {
        const res = await fetch(
          apiUrl(`/api/symbols?market=${symbolPickerMarket}&q=${encodeURIComponent(q)}&limit=200`),
          { signal: ac.signal },
        )
        const data = (await res.json()) as SymbolResponse & { error?: string }
        if (!res.ok) throw new Error(data.error || '종목 목록 조회 실패')
        setSymbolPickerItems(Array.isArray(data.items) ? data.items : [])
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return
        setSymbolPickerItems([])
        setSymbolPickerError(err instanceof Error ? err.message : String(err))
      } finally {
        setSymbolPickerLoading(false)
      }
    }
    void run()
    return () => ac.abort()
  }, [symbolPickerOpen, symbolPickerMarket, symbolPickerFavoritesOnly, symbolPickerQuery])

  useEffect(() => {
    if (!symbolPickerOpen) return
    const reload = () => setWatchlist(loadWatchlistFromStorage())
    reload()
    window.addEventListener('storage', reload)
    return () => window.removeEventListener('storage', reload)
  }, [symbolPickerOpen])

  const displayPickerItems = useMemo(() => {
    const q = symbolPickerQuery.trim().toLowerCase()
    if (symbolPickerFavoritesOnly) {
      const rows = watchlist.filter((w) => {
        if (!q) return true
        return w.symbol.toLowerCase().includes(q) || (w.name ?? '').toLowerCase().includes(q)
      })
      return rows.map((w) => ({
        symbol: w.symbol,
        label: `${w.name ?? w.symbol} (${w.symbol})`,
        market: w.market as Market,
      }))
    }
    return symbolPickerItems.map((item) => ({
      symbol: item.symbol,
      label: `${item.nameKr ?? item.name} (${item.symbol})`,
      market: symbolPickerMarket,
    }))
  }, [symbolPickerFavoritesOnly, watchlist, symbolPickerQuery, symbolPickerItems, symbolPickerMarket])

  const symbolLabelMap = useMemo(() => {
    const pairs: Array<[string, string]> = [
      ...tradableSymbolOptions.map((opt): [string, string] => [opt.symbol, opt.label]),
      ...displayPickerItems.map((i): [string, string] => [i.symbol, i.label]),
    ]
    return new Map<string, string>(pairs)
  }, [tradableSymbolOptions, displayPickerItems])
  const getSymbolDisplayLabel = (symbol: string): string => symbolLabelMap.get(normalizeSymbol(symbol)) ?? normalizeSymbol(symbol)
  const getSymbolDisplayName = (symbol: string, fallbackName?: string): string => {
    const label = getSymbolDisplayLabel(symbol)
    const idx = label.lastIndexOf(' (')
    if (idx > 0) return label.slice(0, idx)
    return fallbackName?.trim() || normalizeSymbol(symbol)
  }
  const upSymbolLabel = getSymbolDisplayLabel(upSymbol)
  const downSymbolLabel = getSymbolDisplayLabel(downSymbol)

  const updateConfig = async (
    patch?: Partial<{
      isActive: boolean
      isDryRun: boolean
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
        isDryRun,
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

  const handleToggleDryRun = () => {
    const nextDryRun = !isDryRun
    if (!nextDryRun && !window.confirm('주의: LIVE 모드에서는 실제 계좌에 주문이 실행됩니다. 계속하시겠습니까?')) return
    setIsDryRun(nextDryRun)
    void updateConfig({ isDryRun: nextDryRun })
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

  const openSymbolPicker = (target: 'up' | 'down') => {
    if (symbolsLocked) return
    setSymbolPickerTarget(target)
    setSymbolPickerQuery('')
    setSymbolPickerMarket('kr')
    setSymbolPickerFavoritesOnly(false)
    setSymbolPickerOpen(true)
  }

  const handlePickSymbol = (symbol: string) => {
    if (symbolPickerTarget === 'up') {
      setUpSymbol(normalizeSymbol(symbol))
    } else {
      setDownSymbol(normalizeSymbol(symbol))
    }
    setSymbolPickerOpen(false)
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
            <p className={`mb-2 text-[10px] font-bold uppercase tracking-wider ${isDryRun ? 'text-slate-400' : 'text-rose-400'}`}>
              {isDryRun ? 'DRY_RUN 모드' : 'LIVE 모드'}
            </p>
            <button
              type="button"
              onClick={handleToggleDryRun}
              className={`relative mb-4 inline-flex h-9 w-20 items-center rounded-full transition-all duration-300 ${
                isDryRun ? 'bg-slate-700' : 'bg-rose-600 shadow-[0_0_15px_rgba(225,29,72,0.4)]'
              }`}
              title={isDryRun ? '모의 매매 모드' : '실전 매매 모드'}
            >
              <span
                className={`inline-block h-7 w-7 rounded-full bg-white transition-transform duration-300 ${
                  isDryRun ? 'translate-x-1' : 'translate-x-12'
                }`}
              />
            </button>
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
              {isActive
                ? isDryRun
                  ? '현재 DRY_RUN 모드입니다. 주문은 전송되지 않고 로그만 기록됩니다.'
                  : '현재 LIVE 모드입니다. 실제 주문이 실행됩니다.'
                : '현재 자동으로 매매가 실행되지 않습니다.'}
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
                <button
                  type="button"
                  disabled={symbolsLocked}
                  onClick={() => openSymbolPicker('up')}
                  className={`w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-left text-sm text-slate-200 outline-none focus:border-blue-500 ${
                    symbolsLocked ? 'cursor-not-allowed opacity-60' : 'hover:border-blue-500/60'
                  }`}
                >
                  {upSymbolLabel}
                </button>
                <label className="mt-2 block text-xs font-semibold text-rose-400">하락 시 매수 (DOWN)</label>
                <button
                  type="button"
                  disabled={symbolsLocked}
                  onClick={() => openSymbolPicker('down')}
                  className={`w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-left text-sm text-slate-200 outline-none focus:border-blue-500 ${
                    symbolsLocked ? 'cursor-not-allowed opacity-60' : 'hover:border-blue-500/60'
                  }`}
                >
                  {downSymbolLabel}
                </button>
              </div>
            </div>
          </div>

          {/* 현재 시그널 요약 */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-blue-900/30 bg-blue-950/20 p-5 shadow-lg">
            <div>
              <p className="text-xs font-semibold text-blue-300">현재 설정 기준 자동매매 시그널</p>
              <p className="mt-1 text-sm text-slate-200">
                {aiTickerLabel} ({aiTicker}){' '}
                <span className="font-bold text-emerald-400">
                  상승 시 {upSymbolLabel} / 하락 시 {downSymbolLabel}
                </span>
              </p>
            </div>
            <div className="shrink-0 text-right">
              <span className="whitespace-nowrap rounded-lg border border-blue-500/30 bg-blue-600/20 px-3 py-1.5 text-sm font-bold text-blue-300">
                진입 임계치 {threshold}%
              </span>
            </div>
          </div>

          {/* 실행 로그 테이블 */}
          <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-5 shadow-lg">
            <h3 className="mb-4 text-sm font-semibold text-white">최근 실행 로그 (실시간)</h3>
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
                  {tradeLogs.length > 0 ? (
                    tradeLogs.map((log) => {
                      const actionLabel =
                        log.action === 'buy' ? '매수' : log.action === 'sell' ? '매도' : log.action === 'buy_fail' ? '매수실패' : '분석'
                      const actionClass =
                        log.action === 'buy'
                          ? 'text-emerald-400'
                          : log.action === 'sell'
                            ? 'text-rose-400'
                            : log.action === 'buy_fail'
                              ? 'text-amber-400'
                              : 'text-blue-400'
                      const statusClass = log.status.includes('DRY_RUN')
                        ? 'border border-blue-500/20 bg-blue-500/10 text-blue-400'
                        : log.status.includes('체결') || log.status.includes('완료')
                          ? 'border border-emerald-500/20 bg-emerald-500/10 text-emerald-400'
                          : 'bg-slate-800 text-slate-300'
                      return (
                        <tr key={log.id} className="hover:bg-slate-800/40">
                          <td className="py-2.5 pr-4 text-slate-400">{log.time}</td>
                          <td className="py-2.5 pr-4">
                            <span className={`font-semibold ${actionClass}`}>{actionLabel}</span>
                          </td>
                          <td className="py-2.5 pr-4">
                            {getSymbolDisplayName(log.symbol, log.name)}{' '}
                            <span className="text-[10px] text-slate-500">({normalizeSymbol(log.symbol)})</span>
                          </td>
                          <td className="py-2.5 pr-4 text-right tabular-nums">
                            {log.qty > 0 ? `${log.qty}주 / ${log.price.toLocaleString()}원` : '-'}
                          </td>
                          <td className="py-2.5 pl-4 text-right">
                            <span className={`rounded px-2 py-1 text-[10px] ${statusClass}`}>{log.status}</span>
                          </td>
                        </tr>
                      )
                    })
                  ) : (
                    <tr>
                      <td colSpan={5} className="py-10 text-center text-slate-500">
                        아직 실행된 내역이 없습니다. [수동 즉시 실행] 버튼을 눌러보세요.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      {symbolPickerOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 px-4"
          onClick={() => setSymbolPickerOpen(false)}
        >
          <div
            className="w-[66vw] max-w-3xl min-w-[520px] rounded-2xl border border-slate-800 bg-slate-900 p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <label className="block text-xs uppercase tracking-[0.2em] text-blue-300">
                종목 검색 · {symbolPickerTarget === 'up' ? '상승 시 매수' : '하락 시 매수'}
              </label>
              <div className="flex flex-wrap items-center gap-1 rounded-full bg-slate-950/80 p-1">
                <button
                  type="button"
                  onClick={() => {
                    setSymbolPickerMarket('us')
                    setSymbolPickerFavoritesOnly(false)
                  }}
                  className={`rounded-full px-2 py-1 text-[11px] font-semibold ${
                    symbolPickerMarket === 'us' && !symbolPickerFavoritesOnly
                      ? 'bg-blue-600 text-white'
                      : 'text-slate-300 hover:bg-slate-800'
                  }`}
                >
                  미국
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSymbolPickerMarket('kr')
                    setSymbolPickerFavoritesOnly(false)
                  }}
                  className={`rounded-full px-2 py-1 text-[11px] font-semibold ${
                    symbolPickerMarket === 'kr' && !symbolPickerFavoritesOnly
                      ? 'bg-blue-600 text-white'
                      : 'text-slate-300 hover:bg-slate-800'
                  }`}
                >
                  한국
                </button>
                <button
                  type="button"
                  onClick={() => setSymbolPickerFavoritesOnly((v) => !v)}
                  className={`rounded-full px-2 py-1 text-[11px] font-semibold ${
                    symbolPickerFavoritesOnly ? 'bg-amber-500 text-slate-900' : 'text-amber-200/90 hover:bg-slate-800'
                  }`}
                >
                  ★ 즐겨찾기
                </button>
              </div>
              <button
                type="button"
                onClick={() => setSymbolPickerOpen(false)}
                className="rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800"
              >
                닫기
              </button>
            </div>
            <input
              autoFocus
              value={symbolPickerQuery}
              onChange={(e) => setSymbolPickerQuery(e.target.value)}
              placeholder={
                symbolPickerFavoritesOnly
                  ? '즐겨찾기 검색 (티커/이름)'
                  : symbolPickerMarket === 'kr'
                    ? '종목코드 또는 기업명 입력 (예: 005930.KS, 삼성전자)'
                    : '티커 또는 기업명 입력 (예: AAPL, Microsoft)'
              }
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-blue-400"
            />
            <div className="mt-2 flex max-h-64 flex-wrap gap-2 overflow-y-auto pr-1">
              {displayPickerItems.map((item, idx) => {
                const selectedSymbol = symbolPickerTarget === 'up' ? upSymbol : downSymbol
                const isSelected = selectedSymbol === item.symbol
                const inWatchlist = watchlist.some((w) => w.symbol === item.symbol && w.market === item.market)
                return (
                  <button
                    key={`${item.symbol}-${idx}`}
                    type="button"
                    onClick={() => handlePickSymbol(item.symbol)}
                    className={`inline-flex max-w-full items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold ${
                      isSelected ? 'bg-blue-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                    }`}
                    title={item.symbol}
                  >
                    {inWatchlist && (
                      <span className="shrink-0 text-[10px] text-amber-300" aria-hidden>
                        ★
                      </span>
                    )}
                    {symbolPickerFavoritesOnly && (
                      <span className="shrink-0 rounded bg-slate-700/90 px-1 py-0 text-[9px] font-medium text-slate-300">
                        {item.market === 'us' ? '미국' : '한국'}
                      </span>
                    )}
                    <span className="truncate">{item.label}</span>
                  </button>
                )
              })}
              {!symbolPickerFavoritesOnly && symbolPickerLoading && (
                <span className="text-xs text-slate-500">목록 불러오는 중...</span>
              )}
              {!symbolPickerFavoritesOnly && symbolPickerError && (
                <span className="text-xs text-rose-400">오류: {symbolPickerError}</span>
              )}
              {symbolPickerFavoritesOnly && watchlist.length === 0 && (
                <span className="text-xs text-slate-500">대시보드에서 추가한 즐겨찾기가 없습니다.</span>
              )}
              {displayPickerItems.length === 0 && !symbolPickerLoading && !symbolPickerError && (
                <span className="text-xs text-slate-500">검색 결과가 없습니다.</span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

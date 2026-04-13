import { applyEntryPrice, applyExitPrice, CostConfig } from './costModel'

export type StrategyMode = 'long_only' | 'long_short' | 'swing' | 'intraday'
export type PositionSide = 'long' | 'short'
export type SignalAction = 'buy' | 'sell' | 'short' | 'cover' | 'hold'

export type CandlePoint = {
  date: string
  open: number
  close: number
}

export type ProbabilityPoint = {
  date: string
  probabilityUp: number
}

export type BacktestInput = {
  ticker: string
  strategy: StrategyMode
  candles: CandlePoint[]
  probabilities: ProbabilityPoint[]
  initialCapital: number
  cost: CostConfig
}

export type TradeLog = {
  side: PositionSide
  entryDate: string
  exitDate: string
  entryPrice: number
  exitPrice: number
  grossReturn: number
  netReturn: number
  pnl: number
  holdingDays: number
}

export type BacktestMetrics = {
  totalReturn: number
  cagr: number
  maxDrawdown: number
  sharpe: number
  winRate: number
  avgWinLossRatio: number | null
  tradeCount: number
}

export type BacktestResult = {
  ticker: string
  strategy: StrategyMode
  startDate: string
  endDate: string
  initialCapital: number
  finalCapital: number
  metrics: BacktestMetrics
  equityCurve: Array<{ date: string; equity: number; drawdown: number }>
  trades: TradeLog[]
  latestSignal: {
    date: string
    action: SignalAction
    probabilityUp: number
  } | null
  /** 백테스트에 사용된 가장 최근 일봉(시가·종가). 다음 시가 체결 가정 안내에 활용 */
  referenceBar: {
    date: string
    open: number
    close: number
  }
}

type StrategyThresholds = {
  buyThreshold: number
  sellThreshold: number
  shortThreshold: number
  coverThreshold: number
  minHoldBars: number
}

const STRATEGY_RULES: Record<StrategyMode, StrategyThresholds> = {
  long_only: {
    buyThreshold: 0.58,
    sellThreshold: 0.48,
    shortThreshold: 0,
    coverThreshold: 1,
    minHoldBars: 1,
  },
  long_short: {
    buyThreshold: 0.57,
    sellThreshold: 0.5,
    shortThreshold: 0.43,
    coverThreshold: 0.5,
    minHoldBars: 1,
  },
  swing: {
    buyThreshold: 0.62,
    sellThreshold: 0.46,
    shortThreshold: 0.38,
    coverThreshold: 0.54,
    minHoldBars: 3,
  },
  intraday: {
    buyThreshold: 0.54,
    sellThreshold: 0.5,
    shortThreshold: 0.46,
    coverThreshold: 0.5,
    minHoldBars: 1,
  },
}

function signalFor(
  strategy: StrategyMode,
  probabilityUp: number,
  currentSide: PositionSide | null,
  holdBars: number,
): SignalAction {
  const rules = STRATEGY_RULES[strategy]
  if (currentSide === 'long') {
    if (holdBars < rules.minHoldBars) return 'hold'
    if (probabilityUp <= rules.sellThreshold) return 'sell'
    return 'hold'
  }
  if (currentSide === 'short') {
    if (holdBars < rules.minHoldBars) return 'hold'
    if (probabilityUp >= rules.coverThreshold) return 'cover'
    return 'hold'
  }

  if (probabilityUp >= rules.buyThreshold) return 'buy'
  if (strategy !== 'long_only' && probabilityUp <= rules.shortThreshold) return 'short'
  return 'hold'
}

function calcMaxDrawdown(equityCurve: Array<{ equity: number }>) {
  let peak = Number.NEGATIVE_INFINITY
  let maxDd = 0
  for (const point of equityCurve) {
    peak = Math.max(peak, point.equity)
    if (peak <= 0) continue
    const dd = (point.equity - peak) / peak
    if (dd < maxDd) maxDd = dd
  }
  return Math.abs(maxDd)
}

function calcSharpe(returns: number[]) {
  if (returns.length < 2) return 0
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1)
  const std = Math.sqrt(variance)
  if (std === 0) return 0
  return (mean / std) * Math.sqrt(252)
}

export function runBacktest(input: BacktestInput): BacktestResult {
  const byDateProb = new Map(input.probabilities.map((p) => [p.date, p.probabilityUp]))
  const candles = input.candles
    .filter((c) => byDateProb.has(c.date))
    .sort((a, b) => a.date.localeCompare(b.date))
  if (candles.length < 3) {
    throw new Error('백테스트를 위한 데이터가 충분하지 않습니다.')
  }

  let capital = input.initialCapital
  let currentSide: PositionSide | null = null
  let entryPrice = 0
  let entryDate = ''
  let holdBars = 0
  const trades: TradeLog[] = []
  const equityCurve: Array<{ date: string; equity: number; drawdown: number }> = []
  const dailyReturns: number[] = []
  let latestSignal: BacktestResult['latestSignal'] = null

  for (let i = 0; i < candles.length - 1; i += 1) {
    const today = candles[i]
    const next = candles[i + 1]
    const probabilityUp = byDateProb.get(today.date) ?? 0.5
    const action = signalFor(input.strategy, probabilityUp, currentSide, holdBars)
    latestSignal = { date: today.date, action, probabilityUp }
    const isExtremeVolatility = probabilityUp > 0.8 || probabilityUp < 0.2
    const longPenalty = isExtremeVolatility ? 1.005 : 1.0
    const shortPenalty = isExtremeVolatility ? 0.995 : 1.0

    if (action === 'buy' && currentSide === null) {
      const adjustedOpen = next.open * longPenalty
      const entry = applyEntryPrice(adjustedOpen, input.cost)
      entryPrice = entry.effectivePrice
      entryDate = next.date
      currentSide = 'long'
      holdBars = 0
    } else if (action === 'short' && currentSide === null) {
      const adjustedOpen = next.open * shortPenalty
      const entry = applyEntryPrice(adjustedOpen, input.cost)
      entryPrice = entry.effectivePrice
      entryDate = next.date
      currentSide = 'short'
      holdBars = 0
    } else if (action === 'sell' && currentSide === 'long') {
      const adjustedOpen = next.open * shortPenalty
      const exit = applyExitPrice(adjustedOpen, input.cost)
      const grossReturn = next.open / entryPrice - 1
      const netReturn = exit.effectivePrice / entryPrice - 1
      const pnl = capital * netReturn
      capital += pnl
      trades.push({
        side: 'long',
        entryDate,
        exitDate: next.date,
        entryPrice,
        exitPrice: exit.effectivePrice,
        grossReturn,
        netReturn,
        pnl,
        holdingDays: Math.max(1, holdBars),
      })
      dailyReturns.push(netReturn)
      currentSide = null
      holdBars = 0
    } else if (action === 'cover' && currentSide === 'short') {
      const adjustedOpen = next.open * longPenalty
      const exit = applyExitPrice(adjustedOpen, input.cost)
      const grossReturn = entryPrice / next.open - 1
      const netReturn = entryPrice / exit.effectivePrice - 1
      const pnl = capital * netReturn
      capital += pnl
      trades.push({
        side: 'short',
        entryDate,
        exitDate: next.date,
        entryPrice,
        exitPrice: exit.effectivePrice,
        grossReturn,
        netReturn,
        pnl,
        holdingDays: Math.max(1, holdBars),
      })
      dailyReturns.push(netReturn)
      currentSide = null
      holdBars = 0
    }

    holdBars += 1
    equityCurve.push({ date: today.date, equity: capital, drawdown: 0 })
  }

  const startDate = candles[0].date
  const endDate = candles[candles.length - 1].date
  const totalReturn = capital / input.initialCapital - 1
  const years = Math.max(1 / 365, (new Date(endDate).getTime() - new Date(startDate).getTime()) / (365 * 24 * 3600 * 1000))
  const cagr = Math.pow(capital / input.initialCapital, 1 / years) - 1
  const maxDrawdown = calcMaxDrawdown(equityCurve)
  const sharpe = calcSharpe(dailyReturns)
  const wins = trades.filter((t) => t.pnl > 0)
  const losses = trades.filter((t) => t.pnl < 0)
  const avgWin = wins.length > 0 ? wins.reduce((a, b) => a + b.pnl, 0) / wins.length : 0
  const avgLossAbs = losses.length > 0 ? Math.abs(losses.reduce((a, b) => a + b.pnl, 0) / losses.length) : 0
  const avgWinLossRatio = avgLossAbs > 0 ? avgWin / avgLossAbs : null

  let peak = Number.NEGATIVE_INFINITY
  for (const point of equityCurve) {
    peak = Math.max(peak, point.equity)
    point.drawdown = peak > 0 ? (point.equity - peak) / peak : 0
  }

  const lastCandle = candles[candles.length - 1]

  return {
    ticker: input.ticker,
    strategy: input.strategy,
    startDate,
    endDate,
    initialCapital: input.initialCapital,
    finalCapital: capital,
    metrics: {
      totalReturn,
      cagr,
      maxDrawdown,
      sharpe,
      winRate: trades.length > 0 ? wins.length / trades.length : 0,
      avgWinLossRatio,
      tradeCount: trades.length,
    },
    equityCurve,
    trades,
    latestSignal,
    referenceBar: {
      date: lastCandle.date,
      open: lastCandle.open,
      close: lastCandle.close,
    },
  }
}

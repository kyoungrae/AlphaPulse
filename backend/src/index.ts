import cors from 'cors'
import dotenv from 'dotenv'
import admin from 'firebase-admin'
import express, { Request, Response } from 'express'
import OpenAI from 'openai'
import Parser from 'rss-parser'
import YahooFinance from 'yahoo-finance2'
import { z } from 'zod'
import { resolveCostConfig, type Market } from './services/costModel'
import {
  runBacktest,
  type BacktestResult,
  type CandlePoint,
  type ProbabilityPoint,
  type StrategyMode,
} from './services/backtest'

dotenv.config()

const app = express()
const port = process.env.PORT || 4000
const predictBase = process.env.PREDICT_URL || 'http://localhost:8001'
const yahooFinance = new YahooFinance()
const openaiApiKey = process.env.OPENAI_API_KEY
const openai = openaiApiKey ? new OpenAI({ apiKey: openaiApiKey }) : null
const firestoreEnabled = process.env.FIRESTORE_ENABLED !== 'false'
const DAILY_JOB_INTERVAL_MS = 1000 * 60 * 15
const DAILY_JOB_CONCURRENCY = Math.max(1, Number(process.env.DAILY_JOB_CONCURRENCY ?? 6))
const DAILY_JOB_SYMBOL_LIMIT = Math.max(1, Number(process.env.DAILY_JOB_SYMBOL_LIMIT ?? 500))
const RECONCILE_BATCH_LIMIT = Math.max(50, Number(process.env.RECONCILE_BATCH_LIMIT ?? 250))
const BACKTEST_CACHE_TTL_MS = 1000 * 60 * 60 * 6
/** AI 예측 서버(10년 학습)와 맞추기 위한 백테스트·전략 요약 기본 조회 기간 */
const BACKTEST_DEFAULT_LOOKBACK_YEARS = 10
/** 일봉 기준 최대 약 252거래일×10년 & 여유 */
const PREDICTION_HISTORY_QUERY_LIMIT = 4000
const STOCK_CACHE_TTL_MS = 1000 * 60 * 5
const PREDICT_CACHE_TTL_MS = 1000 * 60 * 2
const FX_CACHE_TTL_MS = 1000 * 60 * 10

app.use(cors())
app.use(express.json())

const CandleSchema = z.object({
  date: z.date(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
})

const rssParser = new Parser()
type SentimentCacheValue = { label: string; score: number; analyzedAt: number }
const sentimentCache = new Map<string, SentimentCacheValue>()
const SENTIMENT_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 7
const S_AND_P_500_CSV_URL = 'https://datahub.io/core/s-and-p-500-companies/r/constituents.csv'
const SP500_CACHE_TTL_MS = 1000 * 60 * 60 * 24

type SymbolItem = { symbol: string; name: string; nameKr?: string }
type PredictionDirection = 'Up' | 'Down'
type BacktestCacheRecord = {
  key: string
  ticker: string
  market: Market
  strategy: StrategyMode
  from: string
  to: string
  result: ReturnType<typeof runBacktest>
}
type PredictionRecord = {
  ticker: string
  predictionDate: string
  predictedDirection: PredictionDirection
  probabilityUp: number
  baseClose: number
  targetDateExpected: string
  modelTrainedAt?: string
  cvAccuracy?: number
  cvPrecision?: number
  reasonSummary?: string
  outcomeStatus: 'pending' | 'resolved'
  actualDate?: string
  actualDirection?: PredictionDirection
  actualClose?: number
  isCorrect?: boolean
  source: 'daily-close-job'
}
type CacheEntry<T> = { data: T; cachedAt: number }

const fallbackSymbols: SymbolItem[] = [
  { symbol: 'AAPL', name: 'Apple Inc.', nameKr: '애플' },
  { symbol: 'MSFT', name: 'Microsoft Corp.', nameKr: '마이크로소프트' },
  { symbol: 'NVDA', name: 'NVIDIA Corp.', nameKr: '엔비디아' },
  { symbol: 'AMZN', name: 'Amazon.com Inc.', nameKr: '아마존' },
  { symbol: 'GOOGL', name: 'Alphabet Class A', nameKr: '알파벳 A' },
  { symbol: 'META', name: 'Meta Platforms Inc.', nameKr: '메타' },
  { symbol: 'BRK.B', name: 'Berkshire Hathaway B', nameKr: '버크셔 해서웨이 B' },
  { symbol: 'JPM', name: 'JPMorgan Chase & Co.', nameKr: 'JP모건' },
  { symbol: 'UNH', name: 'UnitedHealth Group Inc.', nameKr: '유나이티드헬스' },
  { symbol: 'XOM', name: 'Exxon Mobil Corp.', nameKr: '엑슨모빌' },
]
const koreaSymbols: SymbolItem[] = [
  { symbol: '005930.KS', name: '삼성전자' },
  { symbol: '000660.KS', name: 'SK하이닉스' },
  { symbol: '035420.KS', name: 'NAVER' },
  { symbol: '005380.KS', name: '현대차' },
  { symbol: '012330.KS', name: '현대모비스' },
  { symbol: '051910.KS', name: 'LG화학' },
  { symbol: '006400.KS', name: '삼성SDI' },
  { symbol: '068270.KS', name: '셀트리온' },
  { symbol: '207940.KS', name: '삼성바이오로직스' },
  { symbol: '035720.KS', name: '카카오' },
  { symbol: '105560.KS', name: 'KB금융' },
  { symbol: '055550.KS', name: '신한지주' },
  { symbol: '066570.KS', name: 'LG전자' },
  { symbol: '096770.KS', name: 'SK이노베이션' },
  { symbol: '003670.KS', name: '포스코홀딩스' },
  { symbol: '028260.KS', name: '삼성물산' },
  { symbol: '017670.KS', name: 'SK텔레콤' },
  { symbol: '030200.KS', name: 'KT' },
  { symbol: '010130.KS', name: '고려아연' },
  { symbol: '034730.KS', name: 'SK' },
  { symbol: '323410.KS', name: '카카오뱅크' },
  { symbol: '259960.KS', name: '크래프톤' },
  { symbol: '251270.KS', name: '넷마블' },
  { symbol: '091990.KS', name: '셀트리온헬스케어' },
  { symbol: '035900.KQ', name: 'JYP Ent.' },
  { symbol: '041510.KQ', name: '에스엠' },
  { symbol: '086900.KQ', name: '메디톡스' },
  { symbol: '039030.KQ', name: '이오테크닉스' },
  { symbol: '263750.KQ', name: '펄어비스' },
  { symbol: '293490.KQ', name: '카카오게임즈' },
]

const sectorMap = [
  { name: '기술', symbol: 'XLK' },
  { name: '금융', symbol: 'XLF' },
  { name: '에너지', symbol: 'XLE' },
  { name: '헬스케어', symbol: 'XLV' },
  { name: '자유소비재', symbol: 'XLY' },
  { name: '산업재', symbol: 'XLI' },
  { name: '커뮤니케이션', symbol: 'XLC' },
  { name: '유틸리티', symbol: 'XLU' },
  { name: '소재', symbol: 'XLB' },
  { name: '부동산', symbol: 'XLRE' },
]

let cachedSp500: { data: SymbolItem[]; expiresAt: number } | null = null
let firestoreDb: FirebaseFirestore.Firestore | null = null
let firestoreDisabledReason: string | null = null
let dailyJobRunning = false
let dailyJobLastRunDate: string | null = null
const stockCache = new Map<string, CacheEntry<{ date: string; close: number }[]>>()
const predictCache = new Map<string, CacheEntry<Record<string, unknown>>>()
const fxCache = new Map<string, CacheEntry<{ rate: number; asOf: string }>>()
const backtestMemoryCache = new Map<string, CacheEntry<ReturnType<typeof runBacktest>>>()

function normalizeSingle(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0]
  return value
}

function parseCsvRow(row: string): string[] {
  const cells: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < row.length; i += 1) {
    const ch = row[i]
    if (ch === '"') {
      const next = row[i + 1]
      if (inQuotes && next === '"') {
        current += '"'
        i += 1
      } else {
        inQuotes = !inQuotes
      }
      continue
    }
    if (ch === ',' && !inQuotes) {
      cells.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  cells.push(current.trim())
  return cells
}

function getNextWeekday(dateIso: string): string {
  const date = new Date(`${dateIso}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + 1)
  while (date.getUTCDay() === 0 || date.getUTCDay() === 6) {
    date.setUTCDate(date.getUTCDate() + 1)
  }
  return date.toISOString().slice(0, 10)
}

function getNewYorkClock() {
  const now = new Date()
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(now)
  const map = new Map(parts.map((p) => [p.type, p.value]))
  return {
    date: `${map.get('year')}-${map.get('month')}-${map.get('day')}`,
    hour: Number(map.get('hour')),
    minute: Number(map.get('minute')),
    weekday: map.get('weekday') ?? 'Mon',
  }
}

function toKoreanSentimentLabel(label: string) {
  const normalized = label.trim().toLowerCase()
  if (normalized === 'positive' || normalized === '긍정') return '긍정'
  if (normalized === 'negative' || normalized === '부정') return '부정'
  return '중립'
}

async function getSp500Symbols(): Promise<SymbolItem[]> {
  const now = Date.now()
  if (cachedSp500 && cachedSp500.expiresAt > now) {
    return cachedSp500.data
  }
  try {
    const response = await fetch(S_AND_P_500_CSV_URL)
    if (!response.ok) {
      throw new Error(`S&P500 목록 다운로드 실패: ${response.status}`)
    }
    const csv = await response.text()
    const rows = csv.trim().split('\n').slice(1)
    const parsed = rows
      .map((row) => parseCsvRow(row))
      .map((cells) => ({
        symbol: (cells[0] ?? '').replace(/\./g, '-').toUpperCase(),
        name: cells[1] ?? cells[0] ?? '이름 없음',
        nameKr: cells[1] ?? cells[0] ?? '이름 없음',
      }))
      .filter((item) => item.symbol.length > 0)
    const unique = Array.from(new Map(parsed.map((item) => [item.symbol, item])).values())
    cachedSp500 = { data: unique, expiresAt: now + SP500_CACHE_TTL_MS }
    return unique
  } catch (err) {
    console.error('S&P500 목록 로딩 실패. fallback 목록 사용', err)
    return fallbackSymbols
  }
}

function getFirestore() {
  if (!firestoreEnabled) return null
  if (firestoreDisabledReason) return null
  if (firestoreDb) return firestoreDb
  try {
    const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
    const hasProjectHint =
      Boolean(process.env.GOOGLE_CLOUD_PROJECT) ||
      Boolean(process.env.GCLOUD_PROJECT) ||
      Boolean(process.env.FIREBASE_CONFIG)
    if (!serviceAccountJson && !hasProjectHint) {
      firestoreDisabledReason = 'Firestore 설정이 없어 비활성화되었습니다.'
      console.warn('[Firestore] FIREBASE_SERVICE_ACCOUNT_JSON 또는 프로젝트 환경변수가 없어 비활성화됩니다.')
      return null
    }
    if (admin.apps.length === 0) {
      if (serviceAccountJson) {
        const serviceAccount = JSON.parse(serviceAccountJson)
        admin.initializeApp({
          credential: admin.credential.cert(serviceAccount),
        })
      } else {
        admin.initializeApp()
      }
    }
    firestoreDb = admin.firestore()
    return firestoreDb
  } catch (err) {
    console.error('Firestore 초기화 실패', err)
    firestoreDisabledReason = 'Firestore 초기화 실패'
    return null
  }
}

async function fetchPredict(ticker: string) {
  const url = `${predictBase.replace(/\/+$/, '')}/predict/${encodeURIComponent(ticker)}`
  const response = await fetch(url)
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`예측 서버 오류(${ticker}): ${response.status} ${body}`)
  }
  return (await response.json()) as {
    ticker: string
    probability_up: number
    direction: PredictionDirection
    last_date: string
    last_close: number
    cv_accuracy: number
    cv_precision: number
    model_trained_at: string
    reason_summary: string
  }
}

function defaultBacktestFromDate(): string {
  const d = new Date()
  d.setFullYear(d.getFullYear() - BACKTEST_DEFAULT_LOOKBACK_YEARS)
  return d.toISOString().slice(0, 10)
}

async function loadHistoricalCandles(
  ticker: string,
  fromDate?: string,
  toDate?: string,
): Promise<CandlePoint[]> {
  const period2 = toDate ? new Date(`${toDate}T23:59:59Z`) : new Date()
  const period1 = fromDate
    ? new Date(`${fromDate}T00:00:00Z`)
    : (() => {
        const p = new Date(period2)
        p.setFullYear(p.getFullYear() - BACKTEST_DEFAULT_LOOKBACK_YEARS)
        return p
      })()
  const candles = await yahooFinance.chart(ticker, {
    period1,
    period2,
    interval: '1d',
  })
  return (
    candles.quotes
      ?.filter((q) => q.open != null && q.close != null && q.date != null)
      .map((q) => ({
        date: q.date!.toISOString().slice(0, 10),
        open: Number(q.open),
        close: Number(q.close),
      }))
      .sort((a, b) => a.date.localeCompare(b.date)) ?? []
  )
}

async function loadProbabilityHistory(
  ticker: string,
  candles: CandlePoint[],
  fromDate?: string,
  toDate?: string,
): Promise<ProbabilityPoint[]> {
  const db = getFirestore()
  if (db) {
    try {
      let query = db.collection('predictions').where('ticker', '==', ticker)
      if (fromDate) query = query.where('predictionDate', '>=', fromDate)
      if (toDate) query = query.where('predictionDate', '<=', toDate)
      const snap = await query.orderBy('predictionDate', 'asc').limit(PREDICTION_HISTORY_QUERY_LIMIT).get()
      if (!snap.empty) {
        return snap.docs
          .map((d) => d.data() as PredictionRecord)
          .map((row) => ({
            date: row.predictionDate,
            probabilityUp: row.probabilityUp,
          }))
      }
    } catch (err) {
      console.error('Firestore 확률 이력 조회 실패. 가격 기반 근사치 사용.', err)
    }
  }

  // Firestore 이력이 없으면 가격 모멘텀 기반 확률 근사치 사용
  return candles.map((candle, idx) => {
    if (idx === 0) return { date: candle.date, probabilityUp: 0.5 }
    const prev = candles[idx - 1]
    const change = prev.close > 0 ? (candle.close - prev.close) / prev.close : 0
    const probabilityUp = Math.max(0.05, Math.min(0.95, 0.5 + change * 3))
    return { date: candle.date, probabilityUp: Number(probabilityUp.toFixed(4)) }
  })
}

function normalizeStrategy(value: string | undefined): StrategyMode {
  const v = (value ?? 'long_only').toLowerCase()
  if (v === 'long_short' || v === 'swing' || v === 'intraday') return v
  return 'long_only'
}

function medianNumbers(values: number[]): number | null {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

function buildTradeGuidance(result: BacktestResult, market: Market, notional: number) {
  const trades = result.trades
  const wins = trades.filter((t) => t.netReturn > 0)
  const losses = trades.filter((t) => t.netReturn < 0)
  const avgWinNet = wins.length > 0 ? wins.reduce((a, b) => a + b.netReturn, 0) / wins.length : null
  const avgLossNet = losses.length > 0 ? losses.reduce((a, b) => a + b.netReturn, 0) / losses.length : null
  const medianHold = medianNumbers(trades.map((t) => t.holdingDays))
  const medianHoldWin = medianNumbers(wins.map((t) => t.holdingDays))

  const sig = result.latestSignal
  const currency = market === 'kr' ? 'KRW' : 'USD'

  const disclaimer = [
    '표시 값은 과거 데이터로 백테스트한 결과이며, 기본 구간은 최근 10년 일봉입니다. 미래 수익을 보장하지 않습니다.',
    '체결가는 다음 거래일 시가를 가정하며 실제와 다를 수 있습니다. 슬리피지·세금·수수료가 반영된 시뮬레이션입니다.',
    '투자 판단은 본인 책임이며, 참고용으로만 활용하세요.',
  ]

  let actionSummary = ''
  if (!sig) {
    actionSummary = '신호를 계산하지 못했습니다.'
  } else if (sig.action === 'buy') {
    actionSummary =
      "진입 후보(매수): 백테스트와 동일하게 '다음 거래일 시가'에 매수 체결된다고 가정합니다. 청산은 이후 '매도' 신호가 나온 날의 다음 거래일 시가에 매도하는 규칙을 따릅니다."
  } else if (sig.action === 'short') {
    actionSummary =
      "진입 후보(공매도): 다음 거래일 시가에 공매도 진입을 가정합니다. 청산은 'cover' 신호가 나온 날의 다음 거래일 시가에 가정합니다."
  } else if (sig.action === 'sell' || sig.action === 'cover') {
    actionSummary =
      '청산 후보: 기존 포지션이 있다면 다음 거래일 시가에 매도(또는 공매도 청산)를 검토할 수 있는 신호로 해석할 수 있습니다.'
  } else {
    actionSummary =
      '관망(hold): 새로운 진입 신호가 나올 때까지 기다리는 구간으로 모델에서 해석됩니다.'
  }

  return {
    ticker: result.ticker,
    market,
    strategy: result.strategy,
    backtestRange: { from: result.startDate, to: result.endDate },
    signal: sig
      ? {
          date: sig.date,
          action: sig.action,
          probabilityUp: sig.probabilityUp,
        }
      : null,
    referenceBar: result.referenceBar,
    actionSummary,
    historical: {
      tradeCount: trades.length,
      avgWinNetReturn: avgWinNet,
      avgLossNetReturn: avgLossNet,
      medianHoldingDays: medianHold,
      medianHoldingDaysWinners: medianHoldWin,
    },
    scenario: {
      notional,
      currency,
      profitIfAvgWin: avgWinNet != null ? notional * avgWinNet : null,
      lossIfAvgLoss: avgLossNet != null ? notional * avgLossNet : null,
    },
    disclaimer,
  }
}

async function getBacktestResult(params: {
  ticker: string
  market: Market
  strategy: StrategyMode
  from?: string
  to?: string
  initialCapital: number
  forceRefresh: boolean
}) {
  const from = params.from ?? defaultBacktestFromDate()
  const to = params.to ?? new Date().toISOString().slice(0, 10)
  const cacheKey = `${params.ticker}:${params.market}:${params.strategy}:${from}:${to}:${params.initialCapital}:v3`
  const memCached = backtestMemoryCache.get(cacheKey)
  if (!params.forceRefresh && memCached && Date.now() - memCached.cachedAt < BACKTEST_CACHE_TTL_MS) {
    return memCached.data
  }

  const db = getFirestore()
  if (!params.forceRefresh && db) {
    try {
      const cachedDoc = await db.collection('analysis_backtest').doc(cacheKey).get()
      if (cachedDoc.exists) {
        const row = cachedDoc.data() as BacktestCacheRecord & { createdAt?: FirebaseFirestore.Timestamp }
        if (row.createdAt) {
          const age = Date.now() - row.createdAt.toMillis()
          if (age < BACKTEST_CACHE_TTL_MS) {
            backtestMemoryCache.set(cacheKey, { data: row.result, cachedAt: Date.now() })
            return row.result
          }
        }
      }
    } catch (err) {
      console.error('백테스트 캐시 조회 실패. 재계산합니다.', err)
    }
  }

  const candles = await loadHistoricalCandles(params.ticker, from, to)
  const probabilities = await loadProbabilityHistory(params.ticker, candles, from, to)
  const cost = resolveCostConfig(params.market)
  const result = runBacktest({
    ticker: params.ticker,
    strategy: params.strategy,
    candles,
    probabilities,
    initialCapital: params.initialCapital,
    cost,
  })
  backtestMemoryCache.set(cacheKey, { data: result, cachedAt: Date.now() })

  if (db) {
    try {
      await db.collection('analysis_backtest').doc(cacheKey).set(
        {
          key: cacheKey,
          ticker: params.ticker,
          market: params.market,
          strategy: params.strategy,
          from,
          to,
          result,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      )
    } catch (err) {
      console.error('백테스트 결과 캐시 저장 실패', err)
    }
  }

  return result
}

async function resolveOutcomeForPrediction(record: PredictionRecord): Promise<{
  actualDate: string
  actualDirection: PredictionDirection
  actualClose: number
  isCorrect: boolean
} | null> {
  const today = new Date()
  const baseDate = new Date(`${record.predictionDate}T00:00:00Z`)
  const period1 = new Date(baseDate)
  period1.setUTCDate(period1.getUTCDate() - 3)
  const quotes = await yahooFinance.chart(record.ticker, {
    period1,
    period2: today,
    interval: '1d',
  })
  const normalized =
    quotes.quotes
      ?.filter((q) => q.close != null && q.date != null)
      .map((q) => ({
        date: q.date!.toISOString().slice(0, 10),
        close: Number(q.close),
      }))
      .sort((a, b) => a.date.localeCompare(b.date)) ?? []

  const basePoint = normalized.find((q) => q.date === record.predictionDate)
  const nextPoint = normalized.find((q) => q.date > record.predictionDate)
  if (!basePoint || !nextPoint) {
    return null
  }
  const actualDirection: PredictionDirection = nextPoint.close >= basePoint.close ? 'Up' : 'Down'
  return {
    actualDate: nextPoint.date,
    actualDirection,
    actualClose: Number(nextPoint.close.toFixed(2)),
    isCorrect: actualDirection === record.predictedDirection,
  }
}

async function runInBatches<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = []
  let index = 0
  const runners = Array.from({ length: concurrency }, async () => {
    while (index < items.length) {
      const current = items[index]
      index += 1
      const value = await worker(current)
      results.push(value)
    }
  })
  await Promise.all(runners)
  return results
}

async function reconcilePendingOutcomes(bookmarkDocId: string | null) {
  const db = getFirestore()
  if (!db) {
    return { resolvedCount: 0, correctCount: 0, processedCount: 0, nextBookmark: null as string | null }
  }
  let query = db
    .collection('predictions')
    .where('outcomeStatus', '==', 'pending')
    .orderBy(admin.firestore.FieldPath.documentId())
    .limit(RECONCILE_BATCH_LIMIT)
  if (bookmarkDocId) {
    query = query.startAfter(bookmarkDocId)
  }
  const snapshot = await query.get()

  let resolvedCount = 0
  let correctCount = 0
  let lastDocId: string | null = null
  for (const doc of snapshot.docs) {
    lastDocId = doc.id
    const data = doc.data() as PredictionRecord
    try {
      const outcome = await resolveOutcomeForPrediction(data)
      if (!outcome) continue
      // 결과는 예측 문서에 바로 반영해 Firestore 추가 읽기/쓰기 비용을 줄입니다.
      await doc.ref.set(
        {
          outcomeStatus: 'resolved',
          actualDate: outcome.actualDate,
          actualDirection: outcome.actualDirection,
          actualClose: outcome.actualClose,
          isCorrect: outcome.isCorrect,
          resolvedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      )
      resolvedCount += 1
      if (outcome.isCorrect) {
        correctCount += 1
      }
    } catch (err) {
      console.error(`실측 비교 실패: ${data.ticker}`, err)
    }
  }
  const nextBookmark =
    snapshot.size === RECONCILE_BATCH_LIMIT && lastDocId
      ? lastDocId
      : null
  return { resolvedCount, correctCount, processedCount: snapshot.size, nextBookmark }
}

async function runDailyCloseJob(force = false) {
  if (dailyJobRunning) return
  const db = getFirestore()
  if (!db) return
  const ny = getNewYorkClock()
  const isWeekend = ny.weekday === 'Sat' || ny.weekday === 'Sun'
  const marketClosed = ny.hour > 16 || (ny.hour === 16 && ny.minute >= 10)
  if (!force && (isWeekend || !marketClosed || dailyJobLastRunDate === ny.date)) {
    return
  }

  dailyJobRunning = true
  try {
    const metaRef = db.collection('job_meta').doc('daily_close')
    const metaSnap = await metaRef.get()
    const meta = (metaSnap.exists ? metaSnap.data() : null) as
      | { lastRunDate?: string; pendingBookmark?: string | null }
      | null
    const lastRunDateFromDb = meta?.lastRunDate
    if (!force && lastRunDateFromDb === ny.date) {
      dailyJobLastRunDate = ny.date
      return
    }

    const symbols = (await getSp500Symbols()).slice(0, DAILY_JOB_SYMBOL_LIMIT).map((s) => s.symbol)
    const predictions: PredictionRecord[] = []
    await runInBatches(symbols, DAILY_JOB_CONCURRENCY, async (ticker) => {
      try {
        const predict = await fetchPredict(ticker)
        const record: PredictionRecord = {
          ticker,
          predictionDate: predict.last_date,
          predictedDirection: predict.direction,
          probabilityUp: Number(predict.probability_up.toFixed(4)),
          baseClose: Number(predict.last_close.toFixed(2)),
          targetDateExpected: getNextWeekday(predict.last_date),
          modelTrainedAt: predict.model_trained_at,
          cvAccuracy: predict.cv_accuracy,
          cvPrecision: predict.cv_precision,
          reasonSummary: predict.reason_summary,
          outcomeStatus: 'pending',
          source: 'daily-close-job',
        }
        const docId = `${ticker}_${record.predictionDate}`
        await db.collection('predictions').doc(docId).set(
          {
            ...record,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true },
        )
        predictions.push(record)
      } catch (err) {
        console.error(`일일 예측 저장 실패: ${ticker}`, err)
      }
    })

    const pendingBookmark = typeof meta?.pendingBookmark === 'string' ? meta.pendingBookmark : null
    const { resolvedCount, correctCount, processedCount, nextBookmark } = await reconcilePendingOutcomes(
      pendingBookmark,
    )
    await db.collection('analysis_daily').doc(ny.date).set(
      {
        date: ny.date,
        generatedCount: predictions.length,
        resolvedCount,
        correctCount,
        accuracy: resolvedCount > 0 ? Number((correctCount / resolvedCount).toFixed(4)) : null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    )
    await metaRef.set(
      {
        lastRunDate: ny.date,
        generatedCount: predictions.length,
        resolvedCount,
        reconcileProcessed: processedCount,
        pendingBookmark: nextBookmark,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    )
    dailyJobLastRunDate = ny.date
  } finally {
    dailyJobRunning = false
  }
}

app.get('/', (_req: Request, res: Response) => {
  res.json({
    name: 'AlphaPulse 백엔드',
    endpoints: [
      '/api/stock/:ticker',
      '/api/fx/usd-krw',
      '/api/news',
      '/api/symbols/sp500',
      '/api/predictions/history/:ticker',
      '/health',
    ],
  })
})

app.get('/api/stock/:ticker', async (req: Request, res: Response) => {
  const ticker = normalizeSingle(req.params.ticker)?.toUpperCase()
  if (!ticker) {
    return res.status(400).json({ error: '티커(symbol) 값이 필요합니다.' })
  }
  const timeframe = (normalizeSingle(req.query.timeframe as string | string[] | undefined) ?? 'month').toLowerCase()
  const stockCacheKey = `${ticker}:${timeframe}:ohlc-v1`
  const stockCached = stockCache.get(stockCacheKey)
  if (stockCached && Date.now() - stockCached.cachedAt < STOCK_CACHE_TTL_MS) {
    return res.json(stockCached.data)
  }

  try {
    const rangeByTimeframe: Record<
      string,
      { interval: '1d' | '1wk' | '1h' | '15m' | '5m'; daysBack: number }
    > = {
      year: { interval: '1d', daysBack: 365 },
      month: { interval: '1d', daysBack: 31 },
      day: { interval: '15m', daysBack: 5 },
      hour: { interval: '5m', daysBack: 1 },
    }
    const selected = rangeByTimeframe[timeframe] ?? rangeByTimeframe.month
    const period2 = new Date()
    const period1 = new Date(period2)
    period1.setDate(period2.getDate() - selected.daysBack)
    const candles = await yahooFinance.chart(ticker, {
      period1,
      period2,
      interval: selected.interval,
    })

    const result =
      candles?.quotes
        ?.filter(
          (q) =>
            q.close != null &&
            q.date != null &&
            q.open != null &&
            q.high != null &&
            q.low != null,
        )
        .map((q) =>
          CandleSchema.parse({
            date: q.date!,
            open: q.open!,
            high: q.high!,
            low: q.low!,
            close: q.close!,
          }),
        )
        .map((q) => ({
          date: q.date.toISOString(),
          open: q.open,
          high: q.high,
          low: q.low,
          close: q.close,
        })) ?? []

    stockCache.set(stockCacheKey, { data: result, cachedAt: Date.now() })
    res.json(result)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '주가 데이터를 가져오지 못했습니다.' })
  }
})

app.get('/api/fx/usd-krw', async (_req: Request, res: Response) => {
  const cacheKey = 'USD_KRW'
  const cached = fxCache.get(cacheKey)
  if (cached && Date.now() - cached.cachedAt < FX_CACHE_TTL_MS) {
    return res.json({
      base: 'USD',
      quote: 'KRW',
      rate: cached.data.rate,
      asOf: cached.data.asOf,
      source: 'open.er-api.com(cache)',
    })
  }

  try {
    const response = await fetch('https://open.er-api.com/v6/latest/USD')
    if (!response.ok) {
      throw new Error(`환율 API 오류: ${response.status}`)
    }
    const json = (await response.json()) as {
      time_last_update_utc?: string
      rates?: Record<string, number>
    }
    const rate = json.rates?.KRW
    if (!rate) {
      throw new Error('USD/KRW 환율 응답이 비어 있습니다.')
    }
    const asOf = json.time_last_update_utc ?? new Date().toISOString()
    fxCache.set(cacheKey, { data: { rate, asOf }, cachedAt: Date.now() })
    return res.json({
      base: 'USD',
      quote: 'KRW',
      rate,
      asOf,
      source: 'open.er-api.com',
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'USD/KRW 환율을 가져오지 못했습니다.' })
  }
})

app.get('/api/news', async (_req: Request, res: Response) => {
  try {
    const feed = await rssParser.parseURL(
      'https://news.google.com/rss/search?q=%EB%AF%B8%EA%B5%AD+%EC%A6%9D%EC%8B%9C+OR+%EC%97%B0%EC%A4%80+OR+%EA%B8%88%EB%A6%AC&hl=ko&gl=KR&ceid=KR:ko',
    )

    const items =
      feed.items
        ?.slice(0, 10)
        .map((item) => ({
          title: item.title ?? '제목 없음',
          link: item.link,
          source: item.source?.title ?? '구글 뉴스',
        }))
        .filter((i) => i.title) ?? []

    // Optional sentiment enrichment when API key provided
    if (openai) {
      try {
        const now = Date.now()
        const cachedMap = new Map<string, SentimentCacheValue>()
        const uncachedTitles: string[] = []

        for (const item of items) {
          const cached = sentimentCache.get(item.title)
          if (cached && now - cached.analyzedAt < SENTIMENT_CACHE_TTL_MS) {
            cachedMap.set(item.title, cached)
          } else {
            uncachedTitles.push(item.title)
          }
        }

        if (uncachedTitles.length > 0) {
        const prompt = `You are a financial sentiment classifier for stock market impact.
Respond with JSON object in this exact format:
{"data":[{"title":"...","label":"Positive|Negative|Neutral","score":-100..100}]}
For each title, return an object {title, label, score}.
label is one of Positive, Negative, Neutral. score is integer -100..100.
Titles:
${uncachedTitles.map((title, idx) => `${idx + 1}. ${title}`).join('\n')}`

        const completion = await openai.responses.create({
          model: 'gpt-4.1-mini',
          input: prompt,
        })
        const parsed = JSON.parse(completion.output_text ?? '{"data": []}') as {
          data?: { title: string; label: string; score: number }[]
        }
        for (const d of parsed.data ?? []) {
          sentimentCache.set(d.title, {
            label: toKoreanSentimentLabel(d.label),
            score: d.score,
            analyzedAt: now,
          })
          }
        }

        const enriched = items.map((item) => {
          const found = cachedMap.get(item.title) ?? sentimentCache.get(item.title)
          return found
            ? { ...item, sentiment: { label: toKoreanSentimentLabel(found.label), score: found.score } }
            : { ...item, sentiment: { label: '중립', score: 0 } }
        })
        return res.json(enriched)
      } catch (err) {
        console.error('OpenAI sentiment error, falling back without sentiment', err)
      }
    }

    res.json(items)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '뉴스 데이터를 가져오지 못했습니다.' })
  }
})

app.get('/api/macro/fear-greed', async (_req: Request, res: Response) => {
  try {
    const response = await fetch('https://api.alternative.me/fng/?limit=1')
    if (!response.ok) {
      throw new Error(`fng api error ${response.status}`)
    }
    const json = (await response.json()) as {
      data?: Array<{ value: string; value_classification: string; timestamp: string }>
    }
    const item = json.data?.[0]
    if (!item) {
      return res.status(500).json({ error: '공포탐욕 지수 응답이 비어 있습니다.' })
    }
    res.json({
      value: Number(item.value),
      classification: item.value_classification,
      timestamp: item.timestamp,
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '공포탐욕 지수를 가져오지 못했습니다.' })
  }
})

app.get('/api/macro/calendar', async (_req: Request, res: Response) => {
  // 무료 소스 안정성을 위해 우선 핵심 이벤트 목록을 제공
  const today = new Date().toISOString().slice(0, 10)
  res.json([
    { date: today, event: '미국 CPI 발표', impact: '높음' },
    { date: today, event: '미국 실업수당 청구건수', impact: '중간' },
    { date: today, event: '연준 위원 연설 일정', impact: '중간' },
    { date: today, event: '원유 재고 지표', impact: '낮음' },
  ])
})

app.get('/api/macro/sectors', async (_req: Request, res: Response) => {
  try {
    const symbols = sectorMap.map((s) => s.symbol)
    const quotes = await yahooFinance.quote(symbols)
    const quoteArray = Array.isArray(quotes) ? quotes : [quotes]
    const bySymbol = new Map(quoteArray.map((q) => [q.symbol, q]))
    const data = sectorMap.map((sector) => {
      const q = bySymbol.get(sector.symbol)
      return {
        name: sector.name,
        symbol: sector.symbol,
        changePercent: Number((q?.regularMarketChangePercent ?? 0).toFixed(2)),
      }
    })
    res.json(data)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '섹터 히트맵 데이터를 가져오지 못했습니다.' })
  }
})

app.get('/api/symbols/sp500', async (req: Request, res: Response) => {
  try {
    const query = (req.query.q as string | undefined)?.trim().toUpperCase() ?? ''
    const limitRaw = Number(req.query.limit ?? 40)
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 40
    const symbols = await getSp500Symbols()
    const filtered = symbols.filter((item) => {
      if (!query) return true
      return item.symbol.includes(query) || item.name.toUpperCase().includes(query)
    })
    return res.json({ total: filtered.length, items: filtered.slice(0, limit) })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'S&P500 종목 목록을 가져오지 못했습니다.' })
  }
})

app.get('/api/symbols', async (req: Request, res: Response) => {
  try {
    const market = (normalizeSingle(req.query.market as string | string[] | undefined) ?? 'us').toLowerCase()
    const query = (normalizeSingle(req.query.q as string | string[] | undefined) ?? '').trim().toUpperCase()
    const limitRaw = Number(req.query.limit ?? 40)
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 40

    const source = market === 'kr' ? koreaSymbols : await getSp500Symbols()
    const filtered = source.filter((item) => {
      if (!query) return true
      return item.symbol.includes(query) || item.name.toUpperCase().includes(query)
    })

    return res.json({
      market: market === 'kr' ? 'kr' : 'us',
      total: filtered.length,
      items: filtered.slice(0, limit),
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: '종목 목록을 가져오지 못했습니다.' })
  }
})

app.get('/api/backtest/:ticker', async (req: Request, res: Response) => {
  const ticker = normalizeSingle(req.params.ticker)?.toUpperCase()
  if (!ticker) {
    return res.status(400).json({ error: '티커(symbol) 값이 필요합니다.' })
  }
  try {
    const strategy = normalizeStrategy(normalizeSingle(req.query.strategy as string | string[] | undefined))
    const marketRaw = (normalizeSingle(req.query.market as string | string[] | undefined) ?? 'us').toLowerCase()
    const market: Market = marketRaw === 'kr' ? 'kr' : 'us'
    const from = normalizeSingle(req.query.from as string | string[] | undefined)
    const to = normalizeSingle(req.query.to as string | string[] | undefined)
    const initialCapital = Math.max(1000, Number(req.query.initialCapital ?? 100000))
    const forceRefresh = normalizeSingle(req.query.refresh as string | string[] | undefined) === '1'
    const result = await getBacktestResult({
      ticker,
      market,
      strategy,
      from,
      to,
      initialCapital,
      forceRefresh,
    })
    return res.json(result)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: '백테스트 계산에 실패했습니다.' })
  }
})

app.get('/api/signals/:ticker', async (req: Request, res: Response) => {
  const ticker = normalizeSingle(req.params.ticker)?.toUpperCase()
  if (!ticker) {
    return res.status(400).json({ error: '티커(symbol) 값이 필요합니다.' })
  }
  try {
    const strategy = normalizeStrategy(normalizeSingle(req.query.strategy as string | string[] | undefined))
    const marketRaw = (normalizeSingle(req.query.market as string | string[] | undefined) ?? 'us').toLowerCase()
    const market: Market = marketRaw === 'kr' ? 'kr' : 'us'
    const result = await getBacktestResult({
      ticker,
      market,
      strategy,
      initialCapital: 100000,
      forceRefresh: false,
    })
    return res.json({
      ticker,
      strategy,
      signal: result.latestSignal,
      latestMetrics: result.metrics,
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: '신호 계산에 실패했습니다.' })
  }
})

app.get('/api/guidance/:ticker', async (req: Request, res: Response) => {
  const ticker = normalizeSingle(req.params.ticker)?.toUpperCase()
  if (!ticker) {
    return res.status(400).json({ error: '티커(symbol) 값이 필요합니다.' })
  }
  try {
    const strategy = normalizeStrategy(normalizeSingle(req.query.strategy as string | string[] | undefined))
    const marketRaw = (normalizeSingle(req.query.market as string | string[] | undefined) ?? 'us').toLowerCase()
    const market: Market = marketRaw === 'kr' ? 'kr' : 'us'
    const defaultNotional = market === 'kr' ? 10_000_000 : 10_000
    const notionalRaw = Number(req.query.notional ?? defaultNotional)
    const notional = Number.isFinite(notionalRaw) && notionalRaw > 0 ? notionalRaw : defaultNotional
    const result = await getBacktestResult({
      ticker,
      market,
      strategy,
      initialCapital: 100_000,
      forceRefresh: false,
    })
    const guidance = buildTradeGuidance(result, market, notional)
    return res.json(guidance)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: '수익 참고 안내 계산에 실패했습니다.' })
  }
})

app.get('/api/backtest/summary/:ticker', async (req: Request, res: Response) => {
  const ticker = normalizeSingle(req.params.ticker)?.toUpperCase()
  if (!ticker) {
    return res.status(400).json({ error: '티커(symbol) 값이 필요합니다.' })
  }
  try {
    const marketRaw = (normalizeSingle(req.query.market as string | string[] | undefined) ?? 'us').toLowerCase()
    const market: Market = marketRaw === 'kr' ? 'kr' : 'us'
    const from = normalizeSingle(req.query.from as string | string[] | undefined)
    const to = normalizeSingle(req.query.to as string | string[] | undefined)
    const initialCapital = Math.max(1000, Number(req.query.initialCapital ?? 100000))
    const strategies: StrategyMode[] = ['long_only', 'long_short', 'swing', 'intraday']
    const summary = await Promise.all(
      strategies.map(async (strategy) => {
        const result = await getBacktestResult({
          ticker,
          market,
          strategy,
          from,
          to,
          initialCapital,
          forceRefresh: false,
        })
        return {
          strategy,
          metrics: result.metrics,
          latestSignal: result.latestSignal,
        }
      }),
    )
    return res.json({
      ticker,
      market,
      from: from ?? null,
      to: to ?? null,
      strategies: summary,
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: '전략 요약 계산에 실패했습니다.' })
  }
})

app.get('/api/predictions/history/:ticker', async (req: Request, res: Response) => {
  const db = getFirestore()
  if (!db) {
    return res.status(503).json({
      error: 'Firestore가 설정되지 않아 예측 이력을 조회할 수 없습니다.',
      detail: firestoreDisabledReason ?? 'FIREBASE_SERVICE_ACCOUNT_JSON 또는 GOOGLE_CLOUD_PROJECT 설정을 확인하세요.',
    })
  }
  const ticker = normalizeSingle(req.params.ticker)?.toUpperCase()
  const limitRaw = Number(req.query.limit ?? 30)
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 90) : 30
  try {
    const snap = await db
      .collection('predictions')
      .where('ticker', '==', ticker)
      .orderBy('predictionDate', 'desc')
      .limit(limit)
      .get()
    const records = snap.docs.map((doc) => {
      const data = doc.data() as PredictionRecord
      return {
        ...data,
        actualDirection: data.actualDirection ?? null,
        actualDate: data.actualDate ?? null,
        isCorrect: data.isCorrect ?? null,
        actualClose: data.actualClose ?? null,
      }
    })
    const sorted = records.sort((a, b) => a.predictionDate.localeCompare(b.predictionDate))
    const withDelta = sorted.map((item, idx) => {
      const prev = idx > 0 ? sorted[idx - 1] : null
      return {
        ...item,
        probabilityDelta: prev ? Number((item.probabilityUp - prev.probabilityUp).toFixed(4)) : null,
        directionChanged: prev ? item.predictedDirection !== prev.predictedDirection : false,
      }
    })
    return res.json({ ticker, items: withDelta.reverse() })
  } catch (err) {
    console.error(err)
    return res.status(503).json({
      error: '예측 이력 조회에 실패했습니다.',
      detail: 'Firestore 인증 또는 프로젝트 설정을 확인하세요.',
    })
  }
})

app.get('/api/predictions/daily-summary', async (req: Request, res: Response) => {
  const db = getFirestore()
  if (!db) {
    return res.status(503).json({
      error: 'Firestore가 설정되지 않아 일별 요약을 조회할 수 없습니다.',
      detail: firestoreDisabledReason ?? 'FIREBASE_SERVICE_ACCOUNT_JSON 또는 GOOGLE_CLOUD_PROJECT 설정을 확인하세요.',
    })
  }
  const date = (req.query.date as string | undefined) ?? getNewYorkClock().date
  try {
    const doc = await db.collection('analysis_daily').doc(date).get()
    if (!doc.exists) {
      return res.status(404).json({ error: '해당 날짜의 분석 요약이 없습니다.' })
    }
    return res.json(doc.data())
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: '일별 분석 요약 조회에 실패했습니다.' })
  }
})

app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  })
})

app.get('/api/predict/directions', (req: Request, res: Response) => {
  const raw = normalizeSingle(req.query.symbols as string | string[] | undefined) ?? ''
  const symbols = raw
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length > 0)
    .slice(0, 60)

  const items = symbols.map((symbol) => {
    const cached = predictCache.get(symbol)
    const validCached = cached && Date.now() - cached.cachedAt < PREDICT_CACHE_TTL_MS
    const direction = validCached ? (cached.data.direction as PredictionDirection | undefined) : undefined
    const probabilityUp = validCached
      ? (cached.data.probability_up as number | undefined)
      : undefined
    return {
      symbol,
      direction: direction ?? null,
      probabilityUp: typeof probabilityUp === 'number' ? probabilityUp : null,
      source: validCached ? 'cache' : 'none',
    }
  })

  return res.json({ items })
})

app.get('/api/predict/:ticker', async (req: Request, res: Response) => {
  const ticker = normalizeSingle(req.params.ticker)?.toUpperCase()
  if (!ticker) {
    return res.status(400).json({ error: '티커(symbol) 값이 필요합니다.' })
  }
  const cached = predictCache.get(ticker)
  if (cached && Date.now() - cached.cachedAt < PREDICT_CACHE_TTL_MS) {
    return res.json(cached.data)
  }

  const url = `${predictBase.replace(/\/+$/, '')}/predict/${encodeURIComponent(ticker)}`

  try {
    const response = await fetch(url)
    if (!response.ok) {
      const body = await response.text()
      return res
        .status(response.status)
        .json({ error: '예측 서버 응답 오류', detail: body })
    }
    const json = await response.json()
    predictCache.set(ticker, { data: json as Record<string, unknown>, cachedAt: Date.now() })
    return res.json(json)
  } catch (err) {
    console.error('Predict proxy failed', err)
    return res.status(502).json({
      error: '예측 서버에 연결할 수 없습니다.',
      detail: 'FastAPI 서버가 http://localhost:8001 에서 실행 중인지 확인하세요.',
    })
  }
})

app.post('/api/jobs/daily-close/run', async (_req: Request, res: Response) => {
  const db = getFirestore()
  if (!db) {
    return res.status(503).json({ error: 'Firestore 설정이 필요합니다.' })
  }
  try {
    await runDailyCloseJob(true)
    return res.json({ ok: true, message: '일일 마감 배치를 실행했습니다.' })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: '일일 배치 실행에 실패했습니다.' })
  }
})

app.listen(port, () => {
  console.log(`Backend server running on http://localhost:${port}`)
  setInterval(() => {
    void runDailyCloseJob(false)
  }, DAILY_JOB_INTERVAL_MS)
  setTimeout(() => {
    void runDailyCloseJob(false)
  }, 5000)
})

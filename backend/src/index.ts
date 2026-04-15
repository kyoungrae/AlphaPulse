import cors from 'cors'
import dotenv from 'dotenv'
import fs from 'fs'
import path from 'path'
import admin from 'firebase-admin'
import express, { Request, Response } from 'express'
import { createClient } from 'redis'
import Parser from 'rss-parser'
import YahooFinance from 'yahoo-finance2'
import { z } from 'zod'
import { resolveCostConfig, type Market } from './services/costModel'
import { readServiceAccountCredential } from './firebaseCredential'
import {
  runBacktest,
  type BacktestResult,
  type CandlePoint,
  type ProbabilityPoint,
  type StrategyMode,
} from './services/backtest'

dotenv.config()

const app = express()
const port = process.env.PORT || 4001
const predictBase = process.env.PREDICT_URL || 'http://localhost:8001'
const yahooFinance = new YahooFinance()
const firestoreEnabled = process.env.FIRESTORE_ENABLED !== 'false'
/** 장 마감 조건을 몇 초마다 검사할지(실제 DB 반영은 마감 후·당일 미실행일 때만). 기본 1분. */
const DAILY_CLOSE_SCHEDULER_MS = Math.max(
  30_000,
  Number(process.env.DAILY_CLOSE_SCHEDULER_MS ?? 60_000),
)
const DAILY_JOB_CONCURRENCY = Math.max(1, Number(process.env.DAILY_JOB_CONCURRENCY ?? 6))
const DAILY_JOB_SYMBOL_LIMIT = Math.max(1, Number(process.env.DAILY_JOB_SYMBOL_LIMIT ?? 500))
/** Startup backfill: look back N calendar days per market TZ excluding today (default 7, max 14). */
const STARTUP_CATCHUP_DAYS = Math.max(1, Math.min(14, Number(process.env.STARTUP_CATCHUP_DAYS ?? 7)))
const STARTUP_CATCHUP_DISABLED =
  process.env.DISABLE_STARTUP_CATCHUP === 'true' || process.env.DISABLE_STARTUP_CATCHUP === '1'
const STARTUP_CATCHUP_ENABLED =
  !STARTUP_CATCHUP_DISABLED &&
  (process.env.ENABLE_STARTUP_CATCHUP === 'true' ||
    process.env.ENABLE_STARTUP_CATCHUP === '1' ||
    process.env.NODE_ENV === 'production')
/** Catch-up should be lighter than scheduled daily job to avoid startup log storms. */
const STARTUP_CATCHUP_SYMBOL_LIMIT = Math.max(1, Number(process.env.STARTUP_CATCHUP_SYMBOL_LIMIT ?? 30))
const BACKTEST_CACHE_TTL_MS = 1000 * 60 * 60 * 6
/** AI 예측 서버(10년 학습)와 맞추기 위한 백테스트·전략 요약 기본 조회 기간 */
const BACKTEST_DEFAULT_LOOKBACK_YEARS = 10
/** 일봉 기준 최대 약 252거래일×10년 & 여유 */
const PREDICTION_HISTORY_QUERY_LIMIT = 4000
const STOCK_CACHE_TTL_MS = 1000 * 60 * 5
const PREDICT_CACHE_TTL_MS = 1000 * 60 * 2
const FX_CACHE_TTL_MS = 1000 * 60 * 10
const redisUrl = process.env.REDIS_URL
const KIS_APP_KEY = process.env.KIS_APP_KEY
const KIS_APP_SECRET = process.env.KIS_APP_SECRET
const KIS_URL_BASE = (process.env.KIS_URL_BASE || 'https://openapi.koreainvestment.com:9443').replace(/\/+$/, '')
const KIS_TIMEOUT_MS = Math.max(2000, Number(process.env.KIS_TIMEOUT_MS ?? 10000))
const KIS_RETRY_MAX_ATTEMPTS = Math.min(5, Math.max(1, Number(process.env.KIS_RETRY_MAX_ATTEMPTS ?? 3)))
const KIS_RETRY_BASE_MS = Math.max(100, Number(process.env.KIS_RETRY_BASE_MS ?? 350))

app.use(cors())
app.use(express.json())

const CandleSchema = z.object({
  date: z.date(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number(),
})

const rssParser = new Parser()
type SentimentCacheValue = { label: NewsSentimentLabel; score: number; analyzedAt: number }
const sentimentCache = new Map<string, SentimentCacheValue>()
const SENTIMENT_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 7
const SENTIMENT_REDIS_TTL_SECONDS = Math.floor(SENTIMENT_CACHE_TTL_MS / 1000)
const NEWS_FEATURE_DEFAULT_DAYS = Math.max(1, Number(process.env.NEWS_FEATURE_DEFAULT_DAYS ?? 14))
const NEWS_FEATURE_MAX_LIMIT = Math.max(20, Number(process.env.NEWS_FEATURE_MAX_LIMIT ?? 200))
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
  market: Market
  predictionDate: string
  predictedDirection: PredictionDirection
  probabilityUp: number
  probabilities?: { h1: number; h3: number; h5: number; h10: number }
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
  source: 'daily-close-job' | 'backfill-script'
}
type CacheEntry<T> = { data: T; cachedAt: number }
type NewsSentimentLabel = '긍정' | '부정' | '중립'
type NewsItemWithSentiment = {
  title: string
  link?: string
  source: string
  publishedAt: string
  sentiment: { label: NewsSentimentLabel; score: number }
}

const POSITIVE_NEWS_KEYWORDS = [
  'beat',
  'surge',
  'rally',
  'upgrades',
  'strong',
  'record high',
  'growth',
  '상승',
  '급등',
  '호재',
  '최고치',
  '실적 개선',
  '매수',
  '수주',
]
const NEGATIVE_NEWS_KEYWORDS = [
  'miss',
  'plunge',
  'drop',
  'downgrade',
  'weak',
  'lawsuit',
  'risk',
  '하락',
  '급락',
  '악재',
  '리스크',
  '소송',
  '경고',
  '감소',
]

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
const dailyJobRunningByMarket: Record<Market, boolean> = { us: false, kr: false }
const dailyJobLastRunDateByMarket: Record<Market, string | null> = { us: null, kr: null }
const stockCache = new Map<string, CacheEntry<{ date: string; close: number }[]>>()
const predictCache = new Map<string, CacheEntry<Record<string, unknown>>>()
const fxCache = new Map<string, CacheEntry<{ rate: number; asOf: string }>>()
const backtestMemoryCache = new Map<string, CacheEntry<ReturnType<typeof runBacktest>>>()
const kisTokenCache: { token: string | null; expiresAtMs: number } = { token: null, expiresAtMs: 0 }
let kisTokenPromise: Promise<string> | null = null
const redisClient = redisUrl ? createClient({ url: redisUrl }) : null
if (redisClient) {
  redisClient.connect().catch((err: unknown) => {
    console.error('Redis 연결 실패. 메모리 캐시로 계속 동작합니다.', err)
  })
}

async function getRedisJson<T>(key: string): Promise<T | null> {
  if (!redisClient || !redisClient.isOpen) return null
  try {
    const raw = await redisClient.get(key)
    if (!raw) return null
    return JSON.parse(raw) as T
  } catch (err) {
    console.error('Redis 조회 실패', err)
    return null
  }
}

async function setRedisJson(key: string, value: unknown, ttlSeconds: number) {
  if (!redisClient || !redisClient.isOpen) return
  try {
    await redisClient.setEx(key, Math.max(1, ttlSeconds), JSON.stringify(value))
  } catch (err) {
    console.error('Redis 저장 실패', err)
  }
}

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

function getSeoulClock() {
  const now = new Date()
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul',
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

/** Past calendar days in `timeZone` before today (today excluded), newest-first, up to `count` days. */
function listPriorCalendarDaysExcludingToday(count: number, timeZone: string): string[] {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone })
  const todayStr = fmt.format(new Date())
  const result: string[] = []
  let cursor = new Date()
  let lastEmitted: string | null = null
  const maxHours = 24 * (count + 5)
  for (let h = 0; result.length < count && h < maxHours; h++) {
    cursor = new Date(cursor.getTime() - 60 * 60 * 1000)
    const ymd = fmt.format(cursor)
    if (ymd >= todayStr) continue
    if (ymd !== lastEmitted) {
      lastEmitted = ymd
      result.push(ymd)
    }
  }
  return result
}

function isWeekendYmdInTz(ymd: string, timeZone: string): boolean {
  const fmtDate = new Intl.DateTimeFormat('en-CA', { timeZone })
  const fmtWeek = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' })
  let cursor = new Date()
  for (let h = 0; h < 24 * 40; h++) {
    if (fmtDate.format(cursor) === ymd) {
      const w = fmtWeek.format(cursor)
      return w === 'Sat' || w === 'Sun'
    }
    cursor = new Date(cursor.getTime() - 60 * 60 * 1000)
  }
  return false
}

function isKoreanTicker(ticker: string): boolean {
  return /\.(KS|KQ)$/i.test(ticker)
}

function ymdToCompact(ymd: string): string {
  return ymd.replace(/-/g, '')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isKisRetryableErrorMessage(message: string): boolean {
  return (
    message.includes('EGW00201') ||
    message.includes('초당 거래건수') ||
    message.includes('429') ||
    message.includes('503')
  )
}

async function getKisAccessToken(): Promise<string> {
  if (!KIS_APP_KEY || !KIS_APP_SECRET) {
    throw new Error('KIS_APP_KEY/KIS_APP_SECRET is not configured')
  }
  const now = Date.now()
  if (kisTokenCache.token && now < kisTokenCache.expiresAtMs) {
    return kisTokenCache.token
  }
  if (kisTokenPromise) {
    return kisTokenPromise
  }
  kisTokenPromise = (async () => {
    try {
      const response = await fetch(`${KIS_URL_BASE}/oauth2/tokenP`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'client_credentials',
          appkey: KIS_APP_KEY,
          appsecret: KIS_APP_SECRET,
        }),
        signal: AbortSignal.timeout(KIS_TIMEOUT_MS),
      })
      if (!response.ok) {
        throw new Error(`KIS token error: ${response.status} ${await response.text()}`)
      }
      const json = (await response.json()) as { access_token?: string }
      if (!json.access_token) throw new Error('KIS token missing in response')
      kisTokenCache.token = json.access_token
      kisTokenCache.expiresAtMs = Date.now() + 1000 * 60 * 60 * 23
      return json.access_token
    } finally {
      kisTokenPromise = null
    }
  })()
  return kisTokenPromise
}

async function fetchKisDailyCloses(
  ticker: string,
  fromYmd: string,
  toYmd: string,
): Promise<Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }>> {
  let lastError: Error | null = null
  for (let attempt = 1; attempt <= KIS_RETRY_MAX_ATTEMPTS; attempt += 1) {
    try {
      const token = await getKisAccessToken()
      const code = ticker.toUpperCase().split('.')[0]
      const params = new URLSearchParams({
        FID_COND_MRKT_DIV_CODE: 'J',
        FID_INPUT_ISCD: code,
        FID_INPUT_DATE_1: ymdToCompact(fromYmd),
        FID_INPUT_DATE_2: ymdToCompact(toYmd),
        FID_PERIOD_DIV_CODE: 'D',
        FID_ORG_ADJ_PRC: '1',
      })
      const response = await fetch(
        `${KIS_URL_BASE}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice?${params.toString()}`,
        {
          headers: {
            'content-type': 'application/json; charset=utf-8',
            authorization: `Bearer ${token}`,
            appkey: KIS_APP_KEY || '',
            appsecret: KIS_APP_SECRET || '',
            tr_id: 'FHKST03010100',
          },
          signal: AbortSignal.timeout(KIS_TIMEOUT_MS),
        },
      )
      if (!response.ok) {
        throw new Error(`KIS price error: ${response.status} ${await response.text()}`)
      }
      const payload = (await response.json()) as { rt_cd?: string; msg1?: string; output2?: Array<Record<string, string>> }
      if (payload.rt_cd !== '0' || !Array.isArray(payload.output2)) {
        throw new Error(`KIS price failed: ${payload.msg1 ?? 'unknown'}`)
      }
      return payload.output2
        .map((row) => ({
          date: String(row.stck_bsop_date ?? '').replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3'),
          open: Number(row.stck_oprc),
          high: Number(row.stck_hgpr),
          low: Number(row.stck_lwpr),
          close: Number(row.stck_clpr),
          volume: Number(row.acml_vol),
        }))
        .filter(
          (row) =>
            /^\d{4}-\d{2}-\d{2}$/.test(row.date) &&
            Number.isFinite(row.open) &&
            Number.isFinite(row.high) &&
            Number.isFinite(row.low) &&
            Number.isFinite(row.close) &&
            Number.isFinite(row.volume),
        )
        .sort((a, b) => a.date.localeCompare(b.date))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      lastError = err instanceof Error ? err : new Error(message)
      const retryable = isKisRetryableErrorMessage(message)
      if (!retryable || attempt >= KIS_RETRY_MAX_ATTEMPTS) {
        throw lastError
      }
      const waitMs = KIS_RETRY_BASE_MS * 2 ** (attempt - 1)
      await sleep(waitMs)
    }
  }
  throw lastError ?? new Error('KIS price failed: unknown')
}

async function fetchYahooDailyCloses(ticker: string, period1: Date, period2: Date): Promise<Array<{ date: string; close: number }>> {
  const quotes = await yahooFinance.chart(ticker, {
    period1,
    period2,
    interval: '1d',
  })
  return (
    quotes.quotes
      ?.filter((q) => q.close != null && q.date != null)
      .map((q) => ({
        date: q.date!.toISOString().slice(0, 10),
        close: Number(q.close),
      }))
      .sort((a, b) => a.date.localeCompare(b.date)) ?? []
  )
}

function toKoreanSentimentLabel(label: string): NewsSentimentLabel {
  const normalized = label.trim().toLowerCase()
  if (normalized === 'positive' || normalized === '긍정') return '긍정'
  if (normalized === 'negative' || normalized === '부정') return '부정'
  return '중립'
}

function normalizeIsoDate(input: string | undefined): string | null {
  if (!input) return null
  const d = new Date(input)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString().slice(0, 10)
}

function defaultDateRange(days: number): { from: string; to: string } {
  const to = new Date()
  const from = new Date(to)
  from.setUTCDate(from.getUTCDate() - Math.max(0, days - 1))
  return {
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
  }
}

function normalizeTickerForNews(ticker: string) {
  return ticker.replace(/\.(KS|KQ)$/i, '').trim().toUpperCase()
}

async function resolveNewsEntityTerms(ticker: string, market: Market) {
  const normalizedTicker = normalizeTickerForNews(ticker)
  const source = market === 'kr' ? koreaSymbols : await getSp500Symbols()
  const found = source.find((item) => item.symbol.toUpperCase() === ticker.toUpperCase())
  const nameTerms = [found?.nameKr, found?.name]
    .filter((v): v is string => Boolean(v && v.trim().length > 0))
    .map((v) => v.trim())
  return {
    tickerTerm: normalizedTicker,
    nameTerms,
  }
}

function buildNewsSearchQuery(tickerTerm: string, nameTerms: string[]) {
  const terms = [tickerTerm, ...nameTerms]
  // 종목/회사명 중심으로만 질의해 비관련 거시 기사 유입을 줄입니다.
  const query = terms.map((term) => `"${term}"`).join(' OR ')
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=ko&gl=KR&ceid=KR:ko`
}

function isRelatedArticleTitle(title: string, tickerTerm: string, nameTerms: string[]) {
  const normalizedTitle = title.toLowerCase()
  if (normalizedTitle.includes(tickerTerm.toLowerCase())) return true
  return nameTerms.some((term) => normalizedTitle.includes(term.toLowerCase()))
}

function scoreSentimentFallback(title: string): SentimentCacheValue {
  const text = title.toLowerCase()
  let score = 0
  for (const kw of POSITIVE_NEWS_KEYWORDS) {
    if (text.includes(kw.toLowerCase())) score += 18
  }
  for (const kw of NEGATIVE_NEWS_KEYWORDS) {
    if (text.includes(kw.toLowerCase())) score -= 18
  }
  score = Math.max(-100, Math.min(100, score))
  const label: NewsSentimentLabel = score > 8 ? '긍정' : score < -8 ? '부정' : '중립'
  return { label, score, analyzedAt: Date.now() }
}

async function enrichNewsSentiment(items: Array<{ title: string }>): Promise<Map<string, SentimentCacheValue>> {
  const now = Date.now()
  const result = new Map<string, SentimentCacheValue>()
  const uncachedTitles: string[] = []
  for (const item of items) {
    const cacheKey = `sentiment:${encodeURIComponent(item.title)}`
    let cached = sentimentCache.get(item.title)
    if (!cached) {
      const redisCached = await getRedisJson<SentimentCacheValue>(cacheKey)
      if (redisCached) {
        cached = redisCached
        sentimentCache.set(item.title, redisCached)
      }
    }
    if (cached && now - cached.analyzedAt < SENTIMENT_CACHE_TTL_MS) {
      result.set(item.title, cached)
    } else {
      uncachedTitles.push(item.title)
    }
  }

  if (uncachedTitles.length === 0) return result
  try {
    const response = await fetch(`${predictBase.replace(/\/+$/, '')}/api/sentiment/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ titles: uncachedTitles }),
    })
    if (!response.ok) {
      throw new Error(`FinBERT endpoint error: ${response.status}`)
    }
    const parsed = (await response.json()) as {
      data?: { title: string; label: string; score: number }[]
    }
    for (const d of parsed.data ?? []) {
      const normalized: SentimentCacheValue = {
        label: toKoreanSentimentLabel(d.label),
        score: Number.isFinite(d.score) ? Math.max(-100, Math.min(100, Math.round(d.score))) : 0,
        analyzedAt: now,
      }
      sentimentCache.set(d.title, normalized)
      result.set(d.title, normalized)
      await setRedisJson(`sentiment:${encodeURIComponent(d.title)}`, normalized, SENTIMENT_REDIS_TTL_SECONDS)
    }
  } catch (err) {
    console.error('FinBERT 연동 실패, 점수 fallback 사용', err)
    // fall through to caller fallback
  }
  return result
}

async function fetchNewsWithSentiment(params: {
  ticker: string
  market: Market
  from: string
  to: string
  limit: number
}) {
  const { tickerTerm, nameTerms } = await resolveNewsEntityTerms(params.ticker, params.market)
  const feed = await rssParser.parseURL(buildNewsSearchQuery(tickerTerm, nameTerms))
  const fromTs = new Date(`${params.from}T00:00:00Z`).getTime()
  const toTs = new Date(`${params.to}T23:59:59Z`).getTime()
  const rawItems =
    feed.items
      ?.map((item) => {
        const publishedRaw = item.isoDate ?? item.pubDate
        const published = publishedRaw ? new Date(publishedRaw) : null
        const publishedAt = published && !Number.isNaN(published.getTime()) ? published : null
        return {
          title: item.title ?? '제목 없음',
          link: item.link,
          source: item.source?.title ?? '구글 뉴스',
          publishedAt,
        }
      })
      .filter((item) => item.title && item.publishedAt)
      .filter((item) => {
        const ts = item.publishedAt!.getTime()
        return ts >= fromTs && ts <= toTs
      })
      .filter((item) => isRelatedArticleTitle(item.title, tickerTerm, nameTerms))
      .slice(0, params.limit) ?? []

  const sentimentMap = await enrichNewsSentiment(rawItems)
  return rawItems.map(
    (item): NewsItemWithSentiment => ({
      title: item.title,
      link: item.link,
      source: item.source,
      publishedAt: item.publishedAt!.toISOString(),
      sentiment: ((): NewsItemWithSentiment['sentiment'] => {
        const found = sentimentMap.get(item.title)
        if (found) {
          const label: NewsSentimentLabel = toKoreanSentimentLabel(found.label)
          return {
            label,
            score: found.score,
          }
        }
        const fallback = scoreSentimentFallback(item.title)
        return { label: fallback.label, score: fallback.score }
      })(),
    }),
  )
}

function keywordRegexes(keywords: string[]) {
  return keywords.map((kw) => ({ keyword: kw, regex: new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi') }))
}

function buildDailyNewsFeatures(items: NewsItemWithSentiment[], keywords: string[]) {
  const keyRegs = keywordRegexes(keywords)
  const byDate = new Map<
    string,
    {
      count: number
      sentimentSum: number
      positiveCount: number
      negativeCount: number
      neutralCount: number
      keywordHits: number
      keywordByName: Record<string, number>
    }
  >()
  for (const item of items) {
    const date = item.publishedAt.slice(0, 10)
    const cur = byDate.get(date) ?? {
      count: 0,
      sentimentSum: 0,
      positiveCount: 0,
      negativeCount: 0,
      neutralCount: 0,
      keywordHits: 0,
      keywordByName: {},
    }
    cur.count += 1
    cur.sentimentSum += item.sentiment.score
    if (item.sentiment.label === '긍정') cur.positiveCount += 1
    else if (item.sentiment.label === '부정') cur.negativeCount += 1
    else cur.neutralCount += 1

    const title = item.title.toLowerCase()
    for (const { keyword, regex } of keyRegs) {
      const matches = title.match(regex)
      const hit = matches?.length ?? 0
      if (hit > 0) {
        cur.keywordHits += hit
        cur.keywordByName[keyword] = (cur.keywordByName[keyword] ?? 0) + hit
      }
    }
    byDate.set(date, cur)
  }

  const daily = Array.from(byDate.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, row]) => ({
      date,
      news_sentiment_score: Number((row.sentimentSum / row.count / 100).toFixed(4)),
      news_volume: row.count,
      event_keyword_count: row.keywordHits,
      positive_count: row.positiveCount,
      negative_count: row.negativeCount,
      neutral_count: row.neutralCount,
      keyword_breakdown: row.keywordByName,
    }))

  const totalCount = daily.reduce((acc, d) => acc + d.news_volume, 0)
  const weightedSentiment =
    totalCount > 0
      ? Number(
          (
            daily.reduce((acc, d) => acc + d.news_sentiment_score * d.news_volume, 0) /
            totalCount
          ).toFixed(4),
        )
      : 0
  const keywordTotal = daily.reduce((acc, d) => acc + d.event_keyword_count, 0)
  const positiveTotal = daily.reduce((acc, d) => acc + d.positive_count, 0)
  const negativeTotal = daily.reduce((acc, d) => acc + d.negative_count, 0)
  const neutralTotal = daily.reduce((acc, d) => acc + d.neutral_count, 0)
  const keywordMap = new Map<string, number>()
  for (const d of daily) {
    for (const [k, v] of Object.entries(d.keyword_breakdown)) {
      keywordMap.set(k, (keywordMap.get(k) ?? 0) + v)
    }
  }
  const topKeywords = Array.from(keywordMap.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([keyword, count]) => ({ keyword, count }))

  return {
    summary: {
      news_sentiment_score: weightedSentiment,
      news_volume: totalCount,
      event_keyword_count: keywordTotal,
      positive_count: positiveTotal,
      negative_count: negativeTotal,
      neutral_count: neutralTotal,
    },
    daily,
    topKeywords,
  }
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
    const serviceAccount = readServiceAccountCredential()
    const hasProjectHint =
      Boolean(process.env.GOOGLE_CLOUD_PROJECT) ||
      Boolean(process.env.GCLOUD_PROJECT) ||
      Boolean(process.env.FIREBASE_CONFIG)
    if (!serviceAccount && !hasProjectHint) {
      firestoreDisabledReason = 'Firestore 설정이 없어 비활성화되었습니다.'
      console.warn(
        '[Firestore] FIREBASE_SERVICE_ACCOUNT_JSON, GOOGLE_APPLICATION_CREDENTIALS(파일 경로), FIREBASE_SERVICE_ACCOUNT_KEY_PATH 또는 프로젝트 환경변수가 없어 비활성화됩니다.',
      )
      return null
    }
    if (admin.apps.length === 0) {
      if (serviceAccount) {
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

async function fetchPredict(ticker: string, asOf?: string, horizon = 1) {
  const base = `${predictBase.replace(/\/+$/, '')}/predict/${encodeURIComponent(ticker)}`
  const query = new URLSearchParams()
  if (asOf && /^\d{4}-\d{2}-\d{2}$/.test(asOf)) query.set('as_of', asOf)
  query.set('horizon', String(horizon))
  const url = query.size > 0 ? `${base}?${query.toString()}` : base
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
  const toStr = toDate ?? new Date().toISOString().slice(0, 10)
  const fromStr =
    fromDate ??
    (() => {
      const p = new Date(`${toStr}T00:00:00Z`)
      p.setUTCFullYear(p.getUTCFullYear() - BACKTEST_DEFAULT_LOOKBACK_YEARS)
      return p.toISOString().slice(0, 10)
    })()

  if (isKoreanTicker(ticker) && KIS_APP_KEY && KIS_APP_SECRET) {
    try {
      const kisData = await fetchKisDailyCloses(ticker, fromStr, toStr)
      return kisData.map((q) => ({
        date: q.date,
        open: q.open,
        high: q.high,
        low: q.low,
        close: q.close,
      }))
    } catch (err) {
      console.warn(`[KIS] loadHistoricalCandles fallback to Yahoo for ${ticker}`, err)
    }
  }

  const period1 = new Date(`${fromStr}T00:00:00Z`)
  const period2 = new Date(`${toStr}T23:59:59Z`)
  const candles = await yahooFinance.chart(ticker, { period1, period2, interval: '1d' })
  return (
    candles.quotes
      ?.filter((q) => q.open != null && q.close != null && q.date != null)
      .map((q) => ({
        date: q.date!.toISOString().slice(0, 10),
        open: Number(q.open),
        high: Number(q.high ?? q.open ?? q.close),
        low: Number(q.low ?? q.open ?? q.close),
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
      const doc = await db.collection('predictions_v2').doc(ticker.toUpperCase()).get()
      if (doc.exists) {
        const data = doc.data() as Record<string, unknown>
        let rows = Object.keys(data)
          .filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k))
          .map((k) => data[k] as PredictionRecord)
          .filter((row) => row?.predictionDate && typeof row.probabilityUp === 'number')
        if (fromDate) rows = rows.filter((r) => r.predictionDate >= fromDate)
        if (toDate) rows = rows.filter((r) => r.predictionDate <= toDate)
        rows.sort((a, b) => a.predictionDate.localeCompare(b.predictionDate))
        if (rows.length > 0) {
          return rows.slice(0, PREDICTION_HISTORY_QUERY_LIMIT).map((row) => ({
            date: row.predictionDate,
            probabilityUp: row.probabilityUp,
          }))
        }
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
  let normalized: Array<{ date: string; close: number }> = []
  if (isKoreanTicker(record.ticker) && KIS_APP_KEY && KIS_APP_SECRET) {
    try {
      normalized = await fetchKisDailyCloses(record.ticker, period1.toISOString().slice(0, 10), today.toISOString().slice(0, 10))
    } catch (err) {
      console.warn(`[KIS] outcome price fallback to Yahoo: ${record.ticker}`, err)
      normalized = await fetchYahooDailyCloses(record.ticker, period1, today)
    }
  } else {
    normalized = await fetchYahooDailyCloses(record.ticker, period1, today)
  }

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

async function reconcilePendingOutcomes(symbols: string[]) {
  const db = getFirestore()
  if (!db) {
    return { resolvedCount: 0, correctCount: 0, processedCount: 0 }
  }

  let resolvedCount = 0
  let correctCount = 0

  await runInBatches(symbols, DAILY_JOB_CONCURRENCY, async (ticker) => {
    try {
      const docRef = db.collection('predictions_v2').doc(ticker.toUpperCase())
      const doc = await docRef.get()
      if (!doc.exists) return

      const data = doc.data() as Record<string, unknown>
      const updates: Record<string, unknown> = {}
      let needsUpdate = false

      for (const [date, record] of Object.entries(data)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !record || typeof record !== 'object') continue
        const row = record as PredictionRecord
        if (row.outcomeStatus === 'pending') {
          const outcome = await resolveOutcomeForPrediction(row)
          if (outcome) {
            updates[`${date}.outcomeStatus`] = 'resolved'
            updates[`${date}.actualDate`] = outcome.actualDate
            updates[`${date}.actualDirection`] = outcome.actualDirection
            updates[`${date}.actualClose`] = outcome.actualClose
            updates[`${date}.isCorrect`] = outcome.isCorrect
            updates[`${date}.resolvedAt`] = admin.firestore.FieldValue.serverTimestamp()

            resolvedCount += 1
            if (outcome.isCorrect) correctCount += 1
            needsUpdate = true
          }
        }
      }

      if (needsUpdate) {
        await docRef.update(updates)
      }
    } catch (err) {
      console.error(`실측 비교 실패: ${ticker}`, err)
    }
  })

  return { resolvedCount, correctCount, processedCount: symbols.length }
}

async function runDailyClosePipeline(
  market: Market,
  runDate: string,
  options?: { symbolLimit?: number; throwIfNoSuccess?: boolean },
): Promise<{
  generatedCount: number
  resolvedCount: number
  correctCount: number
  processedCount: number
  failedCount: number
} | null> {
  const db = getFirestore()
  if (!db || !/^\d{4}-\d{2}-\d{2}$/.test(runDate)) return null

  const limit = Math.max(1, Math.min(options?.symbolLimit ?? DAILY_JOB_SYMBOL_LIMIT, DAILY_JOB_SYMBOL_LIMIT))
  const symbols =
    market === 'kr'
      ? koreaSymbols.slice(0, limit).map((s) => s.symbol)
      : (await getSp500Symbols()).slice(0, limit).map((s) => s.symbol)
  const predictions: PredictionRecord[] = []
  await runInBatches(symbols, DAILY_JOB_CONCURRENCY, async (ticker) => {
    try {
      const horizons = [1, 3, 5, 10] as const
      const predicts: Awaited<ReturnType<typeof fetchPredict>>[] = []
      for (const h of horizons) {
        predicts.push(await fetchPredict(ticker, runDate, h))
      }
      const basePredict = predicts[0]
      const record: PredictionRecord = {
        ticker,
        market,
        predictionDate: basePredict.last_date,
        predictedDirection: basePredict.direction,
        probabilityUp: Number(basePredict.probability_up.toFixed(4)),
        probabilities: {
          h1: Number(predicts[0].probability_up.toFixed(4)),
          h3: Number(predicts[1].probability_up.toFixed(4)),
          h5: Number(predicts[2].probability_up.toFixed(4)),
          h10: Number(predicts[3].probability_up.toFixed(4)),
        },
        baseClose: Number(basePredict.last_close.toFixed(2)),
        targetDateExpected: getNextWeekday(basePredict.last_date),
        modelTrainedAt: basePredict.model_trained_at,
        cvAccuracy: basePredict.cv_accuracy,
        cvPrecision: basePredict.cv_precision,
        reasonSummary: basePredict.reason_summary,
        outcomeStatus: 'pending',
        source: 'daily-close-job',
      }
      await db
        .collection('predictions_v2')
        .doc(ticker.toUpperCase())
        .set(
          {
            [record.predictionDate]: {
              ...record,
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
          },
          { merge: true },
        )
      predictions.push(record)
    } catch (err) {
      console.error(`일일 예측 저장 실패: ${ticker}`, err)
    }
  })
  const failedCount = Math.max(0, symbols.length - predictions.length)
  if (options?.throwIfNoSuccess && predictions.length === 0 && failedCount > 0) {
    throw new Error(
      `[daily-close pipeline] all predictions failed for market=${market}, runDate=${runDate}, symbols=${symbols.length}`,
    )
  }

  const { resolvedCount, correctCount, processedCount } = await reconcilePendingOutcomes(symbols)
  await db.collection('analysis_daily').doc(`${market}_${runDate}`).set(
    {
      date: runDate,
      market,
      generatedCount: predictions.length,
      resolvedCount,
      correctCount,
      accuracy: resolvedCount > 0 ? Number((correctCount / resolvedCount).toFixed(4)) : null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true },
  )
  return {
    generatedCount: predictions.length,
    resolvedCount,
    correctCount,
    processedCount,
    failedCount,
  }
}

/** After server start: for each market TZ, fill missing weekdays in last N days (today excluded) when analysis_daily is absent or empty. Does not update job_meta. */
async function runStartupDailyCloseCatchUp() {
  if (!STARTUP_CATCHUP_ENABLED) {
    console.log('[startup daily catch-up] skipped (disabled for this environment)')
    return
  }
  const db = getFirestore()
  if (!db) return

  console.log(
    `[startup daily catch-up] Checking last ${STARTUP_CATCHUP_DAYS} days, symbolLimit=${STARTUP_CATCHUP_SYMBOL_LIMIT}`,
  )
  for (const market of ['us', 'kr'] as const) {
    const tz = market === 'kr' ? 'Asia/Seoul' : 'America/New_York'
    const dates = listPriorCalendarDaysExcludingToday(STARTUP_CATCHUP_DAYS, tz)
      .filter((d) => !isWeekendYmdInTz(d, tz))
      .sort((a, b) => a.localeCompare(b))

    for (const runDate of dates) {
      const summaryRef = db.collection('analysis_daily').doc(`${market}_${runDate}`)
      const snap = await summaryRef.get()
      if (snap.exists) {
        const g = snap.data()?.generatedCount
        if (typeof g === 'number' && g > 0) continue
      }

      if (dailyJobRunningByMarket[market]) {
        console.warn(`[startup daily catch-up] skip ${market} ${runDate} (daily job running)`)
        continue
      }

      dailyJobRunningByMarket[market] = true
      try {
        console.log(`[startup daily catch-up] ${market} ${runDate} missing → pipeline`)
        const result = await runDailyClosePipeline(market, runDate, {
          symbolLimit: STARTUP_CATCHUP_SYMBOL_LIMIT,
          throwIfNoSuccess: true,
        })
        if (result) {
          console.log(
            `[startup daily catch-up] ${market} ${runDate} done · predictions ${result.generatedCount} · failed ${result.failedCount} · outcomes ${result.resolvedCount}`,
          )
        }
      } catch (err) {
        console.error(`[startup daily catch-up] ${market} ${runDate} failed`, err)
      } finally {
        dailyJobRunningByMarket[market] = false
      }
    }
  }
  console.log('[startup daily catch-up] finished')
}

async function runDailyCloseJob(market: Market, force = false) {
  if (dailyJobRunningByMarket[market]) return
  const db = getFirestore()
  if (!db) return
  const clock = market === 'kr' ? getSeoulClock() : getNewYorkClock()
  const isWeekend = clock.weekday === 'Sat' || clock.weekday === 'Sun'
  /** KRX 15:30 KST close buffer / US 16:00 ET close buffer — batch only after this time */
  const marketClosed =
    market === 'kr'
      ? clock.hour > 15 || (clock.hour === 15 && clock.minute >= 40)
      : clock.hour > 16 || (clock.hour === 16 && clock.minute >= 10)
  if (!force && (isWeekend || !marketClosed || dailyJobLastRunDateByMarket[market] === clock.date)) {
    return
  }

  dailyJobRunningByMarket[market] = true
  try {
    const metaRef = db.collection('job_meta').doc(`daily_close_${market}`)
    const metaSnap = await metaRef.get()
    const meta = (metaSnap.exists ? metaSnap.data() : null) as { lastRunDate?: string } | null
    const lastRunDateFromDb = meta?.lastRunDate
    if (!force && lastRunDateFromDb === clock.date) {
      dailyJobLastRunDateByMarket[market] = clock.date
      return
    }

    const result = await runDailyClosePipeline(market, clock.date)
    if (!result) return

    await metaRef.set(
      {
        lastRunDate: clock.date,
        market,
        generatedCount: result.generatedCount,
        resolvedCount: result.resolvedCount,
        reconcileProcessed: result.processedCount,
        pendingBookmark: null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    )
    dailyJobLastRunDateByMarket[market] = clock.date
  } finally {
    dailyJobRunningByMarket[market] = false
  }
}

app.get('/', (_req: Request, res: Response) => {
  res.json({
    name: 'AlphaPulse 백엔드',
    endpoints: [
      '/api/stock/:ticker',
      '/api/fx/usd-krw',
      '/api/news',
      '/api/features/news/:ticker',
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
  const yearsRaw = Number(normalizeSingle(req.query.years as string | string[] | undefined) ?? 1)
  const years = Number.isFinite(yearsRaw) ? Math.min(Math.max(Math.floor(yearsRaw), 1), 30) : 1
  const stockCacheKey = `${ticker}:${timeframe}:${years}:ohlc-v1`
  const redisStockKey = `stock:${stockCacheKey}`
  const redisStock = await getRedisJson<{ date: string; open: number; high: number; low: number; close: number; volume: number }[]>(
    redisStockKey,
  )
  if (redisStock) {
    stockCache.set(stockCacheKey, { data: redisStock, cachedAt: Date.now() })
    return res.json(redisStock)
  }
  const stockCached = stockCache.get(stockCacheKey)
  if (stockCached && Date.now() - stockCached.cachedAt < STOCK_CACHE_TTL_MS) {
    return res.json(stockCached.data)
  }

  try {
    const rangeByTimeframe: Record<
      string,
      { interval: '1d' | '1wk' | '1h' | '15m' | '5m'; daysBack: number }
    > = {
      year: { interval: '1d', daysBack: years * 365 },
      month: { interval: '1d', daysBack: 31 },
      day: { interval: '15m', daysBack: 5 },
      hour: { interval: '5m', daysBack: 1 },
    }
    const selected = rangeByTimeframe[timeframe] ?? rangeByTimeframe.month
    let result: Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }> = []

    if (selected.interval === '1d' && isKoreanTicker(ticker) && KIS_APP_KEY && KIS_APP_SECRET) {
      const toDate = new Date().toISOString().slice(0, 10)
      const fromDate = new Date(Date.now() - selected.daysBack * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
      try {
        const kisData = await fetchKisDailyCloses(ticker, fromDate, toDate)
        result = kisData.map((q) => ({
          date: `${q.date}T00:00:00.000Z`,
          open: q.open,
          high: q.high,
          low: q.low,
          close: q.close,
          volume: q.volume,
        }))
      } catch (err) {
        console.warn(`[KIS] stock chart fallback to Yahoo for ${ticker}`, err)
      }
    }

    if (result.length === 0) {
      const period2 = new Date()
      const period1 = new Date(period2)
      period1.setDate(period2.getDate() - selected.daysBack)
      const candles = await yahooFinance.chart(ticker, {
        period1,
        period2,
        interval: selected.interval,
      })

      result =
        candles?.quotes
          ?.filter(
            (q) =>
              q.close != null &&
              q.date != null &&
              q.open != null &&
              q.high != null &&
              q.low != null &&
              q.volume != null,
          )
          .map((q) =>
            CandleSchema.parse({
              date: q.date!,
              open: q.open!,
              high: q.high!,
              low: q.low!,
              close: q.close!,
              volume: q.volume!,
            }),
          )
          .map((q) => ({
            date: q.date.toISOString(),
            open: q.open,
            high: q.high,
            low: q.low,
            close: q.close,
            volume: q.volume,
          })) ?? []
    }

    stockCache.set(stockCacheKey, { data: result, cachedAt: Date.now() })
    await setRedisJson(redisStockKey, result, Math.floor(STOCK_CACHE_TTL_MS / 1000))
    res.json(result)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '주가 데이터를 가져오지 못했습니다.' })
  }
})

app.get('/api/fx/usd-krw', async (_req: Request, res: Response) => {
  const cacheKey = 'USD_KRW'
  const redisFxKey = `fx:${cacheKey}`
  const redisFx = await getRedisJson<{ rate: number; asOf: string }>(redisFxKey)
  if (redisFx) {
    fxCache.set(cacheKey, { data: redisFx, cachedAt: Date.now() })
    return res.json({
      base: 'USD',
      quote: 'KRW',
      rate: redisFx.rate,
      asOf: redisFx.asOf,
      source: 'open.er-api.com(redis-cache)',
    })
  }
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
    await setRedisJson(redisFxKey, { rate, asOf }, Math.floor(FX_CACHE_TTL_MS / 1000))
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
    const sentimentMap = await enrichNewsSentiment(items)
    const enriched = items.map((item) => {
      const found = sentimentMap.get(item.title) ?? sentimentCache.get(item.title)
      if (found) {
        return { ...item, sentiment: { label: toKoreanSentimentLabel(found.label), score: found.score } }
      }
      const fallback = scoreSentimentFallback(item.title)
      return { ...item, sentiment: { label: fallback.label, score: fallback.score } }
    })
    res.json(enriched)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '뉴스 데이터를 가져오지 못했습니다.' })
  }
})

app.get('/api/features/news/:ticker', async (req: Request, res: Response) => {
  const ticker = normalizeSingle(req.params.ticker)?.toUpperCase()
  if (!ticker) {
    return res.status(400).json({ error: '티커(symbol) 값이 필요합니다.' })
  }
  const marketRaw = (normalizeSingle(req.query.market as string | string[] | undefined) ?? 'us').toLowerCase()
  const market: Market = marketRaw === 'kr' ? 'kr' : 'us'
  const limitRaw = Number(req.query.limit ?? 80)
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 10), NEWS_FEATURE_MAX_LIMIT) : 80

  const defaultRange = defaultDateRange(NEWS_FEATURE_DEFAULT_DAYS)
  const from = normalizeIsoDate(normalizeSingle(req.query.from as string | string[] | undefined)) ?? defaultRange.from
  const to = normalizeIsoDate(normalizeSingle(req.query.to as string | string[] | undefined)) ?? defaultRange.to
  if (from > to) {
    return res.status(400).json({ error: 'from은 to보다 이후일 수 없습니다.' })
  }

  const keywordsRaw = normalizeSingle(req.query.keywords as string | string[] | undefined)
  const keywords =
    keywordsRaw
      ?.split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0)
      .slice(0, 40) ?? [
      'war',
      '전쟁',
      '봉쇄',
      '제재',
      '유가',
      '금리',
      '인플레이션',
      '실적',
      'guidance',
      'recession',
      'fed',
    ]

  try {
    const items = await fetchNewsWithSentiment({
      ticker,
      market,
      from,
      to,
      limit,
    })
    const features = buildDailyNewsFeatures(items, keywords)
    return res.json({
      ticker,
      market,
      from,
      to,
      generatedAt: new Date().toISOString(),
      keywords,
      summary: features.summary,
      daily: features.daily,
      topKeywords: features.topKeywords,
      articles: items.slice(0, 20),
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: '뉴스 피처 집계에 실패했습니다.' })
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
  const ticker = normalizeSingle(req.params.ticker)?.toUpperCase()
  const limitRaw = Number(req.query.limit ?? 30)
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 90) : 30
  if (!ticker) {
    return res.status(400).json({ error: '티커(symbol) 값이 필요합니다.' })
  }
  if (!db) {
    return res.json({
      ticker,
      items: [],
      warning: 'Firestore 미설정으로 예측 이력이 비어 있습니다.',
      detail: firestoreDisabledReason ?? 'FIREBASE_SERVICE_ACCOUNT_JSON 또는 GOOGLE_CLOUD_PROJECT 설정을 확인하세요.',
    })
  }
  try {
    const doc = await db.collection('predictions_v2').doc(ticker).get()
    if (!doc.exists) {
      return res.json({ ticker, items: [] })
    }

    const data = doc.data() as Record<string, unknown>
    const records = Object.keys(data)
      .filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k))
      .map((k) => data[k] as PredictionRecord)
      .filter((row) => {
        if (row == null || typeof row !== 'object') return false
        return typeof row.predictionDate === 'string' && typeof row.probabilityUp === 'number'
      })
      .map((row) => ({
        ...row,
        actualDirection: row.actualDirection ?? null,
        actualDate: row.actualDate ?? null,
        isCorrect: row.isCorrect ?? null,
        actualClose: row.actualClose ?? null,
      }))

    const sortedDesc = [...records].sort((a, b) => b.predictionDate.localeCompare(a.predictionDate)).slice(0, limit)
    const chronological = sortedDesc.slice().reverse()
    const withDelta = chronological.map((item, idx) => {
      const prev = idx > 0 ? chronological[idx - 1] : null
      return {
        ...item,
        probabilityDelta: prev ? Number((item.probabilityUp - prev.probabilityUp).toFixed(4)) : null,
        directionChanged: prev ? item.predictedDirection !== prev.predictedDirection : false,
      }
    })
    return res.json({ ticker, items: withDelta.slice().reverse() })
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
  const marketRaw = (normalizeSingle(req.query.market as string | string[] | undefined) ?? 'us').toLowerCase()
  const market: Market = marketRaw === 'kr' ? 'kr' : 'us'
  const date = (req.query.date as string | undefined) ?? (market === 'kr' ? getSeoulClock().date : getNewYorkClock().date)
  try {
    const doc = await db.collection('analysis_daily').doc(`${market}_${date}`).get()
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
  const asOfRaw = typeof req.query.as_of === 'string' ? req.query.as_of.trim() : ''
  const asOf = /^\d{4}-\d{2}-\d{2}$/.test(asOfRaw) ? asOfRaw : undefined
  const horizonRaw = Number(req.query.horizon ?? 1)
  const horizon = Number.isFinite(horizonRaw) ? Math.min(Math.max(Math.floor(horizonRaw), 1), 30) : 1
  const cacheKey = `${ticker}:${horizon}`
  const redisPredictKey = `predict:${cacheKey}`
  if (!asOf) {
    const redisPredict = await getRedisJson<Record<string, unknown>>(redisPredictKey)
    if (redisPredict) {
      predictCache.set(cacheKey, { data: redisPredict, cachedAt: Date.now() })
      return res.json(redisPredict)
    }
    const cached = predictCache.get(cacheKey)
    if (cached && Date.now() - cached.cachedAt < PREDICT_CACHE_TTL_MS) {
      return res.json(cached.data)
    }
  }

  const base = `${predictBase.replace(/\/+$/, '')}/predict/${encodeURIComponent(ticker)}`
  const query = new URLSearchParams()
  if (asOf) query.set('as_of', asOf)
  query.set('horizon', String(horizon))
  const url = `${base}?${query.toString()}`

  try {
    const response = await fetch(url)
    if (!response.ok) {
      const body = await response.text()
      return res
        .status(response.status)
        .json({ error: '예측 서버 응답 오류', detail: body })
    }
    const json = await response.json()
    if (!asOf) {
      predictCache.set(cacheKey, { data: json as Record<string, unknown>, cachedAt: Date.now() })
      await setRedisJson(redisPredictKey, json, Math.floor(PREDICT_CACHE_TTL_MS / 1000))
    }
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
    await runDailyCloseJob('us', true)
    await runDailyCloseJob('kr', true)
    return res.json({ ok: true, message: '일일 마감 배치를 실행했습니다.' })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: '일일 배치 실행에 실패했습니다.' })
  }
})

/** 프로덕션: 같은 오리진에서 프론트(Vite 빌드) + /api 제공. `npm run build` 후 저장소 루트에서 서버 실행 시 `frontend/dist` 사용. */
const frontendDist = process.env.FRONTEND_DIST || path.join(process.cwd(), 'frontend', 'dist')
if (process.env.NODE_ENV === 'production' && fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist))
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next()
    res.sendFile(path.join(frontendDist, 'index.html'))
  })
}

app.listen(port, () => {
  console.log(`Backend server running on http://localhost:${port}`)
  console.log(
    `[일일 마감 배치] 한국·미국 각각 '해당 시장 정규장 마감 이후'에만 Firestore 반영, 시장별 하루 1회(job_meta). 조건 검사 주기 ${DAILY_CLOSE_SCHEDULER_MS / 1000}s (환경변수 DAILY_CLOSE_SCHEDULER_MS 로 변경 가능)`,
  )
  setImmediate(() => {
    void runStartupDailyCloseCatchUp()
  })
  setInterval(() => {
    void runDailyCloseJob('us', false)
    void runDailyCloseJob('kr', false)
  }, DAILY_CLOSE_SCHEDULER_MS)
})

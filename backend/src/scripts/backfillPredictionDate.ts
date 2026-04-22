/**
 * 지정한 날짜 키(기본: 로컬 달력 기준 어제)로 predictions_v2/{TICKER} 에 예측 스냅샷을 저장합니다.
 * 예측 값은 PREDICT_URL 에 `?as_of=대상일` 로 요청해 해당 거래일 피처 기준 상승 확률을 쓰고,
 * Firestore 문서 키와 predictionDate 는 대상 날짜와 맞춥니다.
 *
 * 사용 예:
 *   npx ts-node --transpile-only src/scripts/backfillPredictionDate.ts --yesterday --market=us --symbols=AAPL,MSFT
 *   npx ts-node --transpile-only src/scripts/backfillPredictionDate.ts --date=2026-04-13 --market=kr --symbols=005930.KS
 *   npx ts-node --transpile-only src/scripts/backfillPredictionDate.ts --rebackfill-from-doc=AAPL
 *     → predictions_v2/AAPL 문서에 있는 모든 YYYY-MM-DD 키를 as_of 백필로 다시 씀 (확률·실측 갱신)
 */

import fs from 'fs'
import path from 'path'
import dotenv from 'dotenv'
import admin from 'firebase-admin'
import YahooFinance from 'yahoo-finance2'
import { credentialEnvDiagnostics, readServiceAccountCredential } from '../firebaseCredential'

for (const envPath of [
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '..', '.env'),
  path.resolve(__dirname, '..', '.env'),
]) {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, override: true })
  }
}

const predictBase = process.env.PREDICT_URL || 'http://localhost:8001'
const CONCURRENCY = Math.max(1, Number(process.env.DAILY_JOB_CONCURRENCY ?? 6))
const S_AND_P_500_CSV_URL = 'https://datahub.io/core/s-and-p-500-companies/r/constituents.csv'
const yahooFinance = new YahooFinance()
const KIS_APP_KEY = process.env.KIS_APP_KEY
const KIS_APP_SECRET = process.env.KIS_APP_SECRET
const KIS_URL_BASE = (process.env.KIS_URL_BASE || 'https://openapi.koreainvestment.com:9443').replace(/\/+$/, '')
const KIS_TIMEOUT_MS = Math.max(2000, Number(process.env.KIS_TIMEOUT_MS ?? 10000))
const KIS_RETRY_MAX_ATTEMPTS = Math.min(5, Math.max(1, Number(process.env.KIS_RETRY_MAX_ATTEMPTS ?? 3)))
const KIS_RETRY_BASE_MS = Math.max(100, Number(process.env.KIS_RETRY_BASE_MS ?? 350))
const kisTokenCache: { token: string | null; expiresAtMs: number } = { token: null, expiresAtMs: 0 }

type Market = 'us' | 'kr'
type PredictionDirection = 'Up' | 'Down'

type PredictionRecord = {
  ticker: string
  market: Market
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
  source: 'backfill-script'
}

type RebackfillMode = 'outcome-only' | 'full-recompute'

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
  kisTokenCache.expiresAtMs = now + 1000 * 60 * 60 * 23
  return json.access_token
}

async function fetchKisDailyCloses(ticker: string, fromYmd: string, toYmd: string): Promise<Array<{ date: string; close: number }>> {
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
        FID_ORG_ADJ_PRC: '0',
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
          close: Number(row.stck_clpr),
        }))
        .filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date) && Number.isFinite(row.close))
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

async function fetchDailyClosesPreferKis(ticker: string, period1: Date, period2: Date): Promise<Array<{ date: string; close: number }>> {
  if (isKoreanTicker(ticker) && KIS_APP_KEY && KIS_APP_SECRET) {
    try {
      return await fetchKisDailyCloses(ticker, period1.toISOString().slice(0, 10), period2.toISOString().slice(0, 10))
    } catch (err) {
      console.warn(`[KIS] close price fallback to Yahoo: ${ticker}`, err)
      return await fetchYahooDailyCloses(ticker, period1, period2)
    }
  }
  return await fetchYahooDailyCloses(ticker, period1, period2)
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
  const normalized = await fetchDailyClosesPreferKis(record.ticker, period1, today)

  const basePoint = normalized.find((q) => q.date === record.predictionDate)
  const nextPoint = normalized.find((q) => q.date > record.predictionDate)
  if (!basePoint || !nextPoint) return null

  const actualDirection: PredictionDirection = nextPoint.close >= basePoint.close ? 'Up' : 'Down'
  return {
    actualDate: nextPoint.date,
    actualDirection,
    actualClose: Number(nextPoint.close.toFixed(2)),
    isCorrect: actualDirection === record.predictedDirection,
  }
}

async function fetchCloseOnDate(ticker: string, dateIso: string): Promise<number | null> {
  const target = new Date(`${dateIso}T00:00:00Z`)
  const period1 = new Date(target)
  period1.setUTCDate(period1.getUTCDate() - 3)
  const period2 = new Date(target)
  period2.setUTCDate(period2.getUTCDate() + 1)
  const closes = await fetchDailyClosesPreferKis(ticker, period1, period2)
  const row = closes.find((q) => q.date === dateIso) ?? null
  return row ? Number(row.close.toFixed(2)) : null
}

function getNextWeekday(dateIso: string): string {
  const date = new Date(`${dateIso}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + 1)
  while (date.getUTCDay() === 0 || date.getUTCDay() === 6) {
    date.setUTCDate(date.getUTCDate() + 1)
  }
  return date.toISOString().slice(0, 10)
}

function formatLocalYmd(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function localYesterdayYmd(): string {
  const now = new Date()
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  return formatLocalYmd(yesterday)
}

function initFirestore(): FirebaseFirestore.Firestore {
  const serviceAccount = readServiceAccountCredential()
  const hasProjectHint =
    Boolean(process.env.GOOGLE_CLOUD_PROJECT) ||
    Boolean(process.env.GCLOUD_PROJECT) ||
    Boolean(process.env.FIREBASE_CONFIG)

  if (!serviceAccount && !hasProjectHint) {
    const examplePath = path.resolve(process.cwd(), '.env.example')
    throw new Error(
      [
        'Firestore 인증이 없습니다.',
        '',
        '  1) .env 에 한 줄 추가: GOOGLE_APPLICATION_CREDENTIALS=/절대/경로/키.json',
        '     (따옴표·~ 경로 지원: GOOGLE_APPLICATION_CREDENTIALS="/Users/나/키.json")',
        '  2) 또는 키 파일을 backend/firebase-adminsdk.json 로 저장',
        '  3) 또는 FIREBASE_SERVICE_ACCOUNT_JSON=\'{"type":"service_account",...}\'',
        '',
        fs.existsSync(examplePath) ? `(참고: ${examplePath})` : '',
        '',
        '--- 진단 (민감한 값은 일부만 표시) ---',
        credentialEnvDiagnostics(),
        '',
        `cwd=${process.cwd()}`,
      ]
        .filter(Boolean)
        .join('\n'),
    )
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
  return admin.firestore()
}

async function fetchPredict(ticker: string, asOf: string) {
  const base = `${predictBase.replace(/\/+$/, '')}/predict/${encodeURIComponent(ticker)}`
  const url = `${base}?as_of=${encodeURIComponent(asOf)}`
  const response = await fetch(url)
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`예측 서버 오류(${ticker}): ${response.status} ${body}`)
  }
  return (await response.json()) as {
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

function inferMarketFromDoc(data: Record<string, unknown>): Market {
  const keys = Object.keys(data)
    .filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k))
    .sort()
  for (const k of keys) {
    const row = data[k]
    if (row && typeof row === 'object' && row !== null && 'market' in row) {
      const m = (row as { market?: string }).market
      if (m === 'kr') return 'kr'
      if (m === 'us') return 'us'
    }
  }
  return 'us'
}

async function processOneDate(
  db: FirebaseFirestore.Firestore,
  ticker: string,
  targetDate: string,
  market: Market,
  options?: { mode?: RebackfillMode },
): Promise<void> {
  const mode: RebackfillMode = options?.mode ?? 'full-recompute'
  const docRef = db.collection('predictions_v2').doc(ticker.toUpperCase())
  const existingData = (await docRef.get()).data() as Record<string, unknown> | undefined
  const existingRow = (existingData?.[targetDate] as Record<string, unknown> | undefined) ?? undefined

  let record: PredictionRecord
  if (
    mode === 'outcome-only' &&
    existingRow &&
    typeof existingRow.predictedDirection === 'string' &&
    typeof existingRow.probabilityUp === 'number' &&
    typeof existingRow.baseClose === 'number'
  ) {
    record = {
      ticker,
      market:
        existingRow.market === 'kr' || existingRow.market === 'us'
          ? (existingRow.market as Market)
          : market,
      predictionDate: targetDate,
      predictedDirection: existingRow.predictedDirection === 'Down' ? 'Down' : 'Up',
      probabilityUp: Number(existingRow.probabilityUp),
      baseClose: Number(existingRow.baseClose),
      targetDateExpected:
        typeof existingRow.targetDateExpected === 'string' ? existingRow.targetDateExpected : getNextWeekday(targetDate),
      modelTrainedAt: typeof existingRow.modelTrainedAt === 'string' ? existingRow.modelTrainedAt : undefined,
      cvAccuracy: typeof existingRow.cvAccuracy === 'number' ? existingRow.cvAccuracy : undefined,
      cvPrecision: typeof existingRow.cvPrecision === 'number' ? existingRow.cvPrecision : undefined,
      reasonSummary: typeof existingRow.reasonSummary === 'string' ? existingRow.reasonSummary : undefined,
      outcomeStatus: 'pending',
      source: 'backfill-script',
    }
  } else {
    const predict = await fetchPredict(ticker, targetDate)
    const historicalClose = await fetchCloseOnDate(ticker, targetDate)
    record = {
      ticker,
      market,
      predictionDate: targetDate,
      predictedDirection: predict.direction,
      probabilityUp: Number(predict.probability_up.toFixed(4)),
      baseClose: historicalClose ?? Number(predict.last_close.toFixed(2)),
      targetDateExpected: getNextWeekday(targetDate),
      modelTrainedAt: predict.model_trained_at,
      cvAccuracy: predict.cv_accuracy,
      cvPrecision: predict.cv_precision,
      reasonSummary: predict.reason_summary,
      outcomeStatus: 'pending',
      source: 'backfill-script',
    }
  }
  const outcome = await resolveOutcomeForPrediction(record)
  const preserved = existingRow ?? {}
  const enrichedRecord = outcome
    ? {
        ...preserved,
        ...record,
        outcomeStatus: 'resolved' as const,
        actualDate: outcome.actualDate,
        actualDirection: outcome.actualDirection,
        actualClose: outcome.actualClose,
        isCorrect: outcome.isCorrect,
        resolvedAt: admin.firestore.FieldValue.serverTimestamp(),
      }
    : { ...preserved, ...record }
  await db
    .collection('predictions_v2')
    .doc(ticker.toUpperCase())
    .set(
      {
        [targetDate]: {
          ...enrichedRecord,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
      },
      { merge: true },
    )
  console.log(`OK ${ticker} → ${targetDate} (mode=${mode}, predictionDate=${record.predictionDate})`)
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

async function fetchSp500Symbols(limit: number): Promise<string[]> {
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
    }))
    .filter((item) => item.symbol.length > 0)
  const unique = Array.from(new Map(parsed.map((item) => [item.symbol, item.symbol])).values())
  return unique.slice(0, limit)
}

async function runInBatches<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>) {
  let index = 0
  const runners = Array.from({ length: concurrency }, async () => {
    while (index < items.length) {
      const current = items[index]
      index += 1
      await worker(current)
    }
  })
  await Promise.all(runners)
}

function parseArgs() {
  const raw = process.argv.slice(2)
  let dateStr: string | null = null
  let market: Market = 'us'
  let marketFromArg = false
  let symbolsStr: string | null = null
  let sp500 = false
  let sp500Limit = 50
  let rebackfillFromDoc: string | null = null
  let rebackfillMode: RebackfillMode = 'outcome-only'

  for (const arg of raw) {
    if (arg === '--yesterday') {
      dateStr = localYesterdayYmd()
    } else if (arg.startsWith('--date=')) {
      dateStr = arg.slice('--date='.length).trim()
    } else if (arg.startsWith('--market=')) {
      const m = arg.slice('--market='.length).toLowerCase()
      market = m === 'kr' ? 'kr' : 'us'
      marketFromArg = true
    } else if (arg.startsWith('--symbols=')) {
      symbolsStr = arg.slice('--symbols='.length).trim()
    } else if (arg === '--sp500') {
      sp500 = true
    } else if (arg.startsWith('--limit=')) {
      sp500Limit = Math.max(1, Number(arg.slice('--limit='.length)) || 50)
    } else if (arg.startsWith('--rebackfill-from-doc=')) {
      rebackfillFromDoc = arg.slice('--rebackfill-from-doc='.length).trim().toUpperCase()
    } else if (arg === '--recompute-prediction') {
      rebackfillMode = 'full-recompute'
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
백필: predictions_v2/{티커} 문서에 [날짜] 키로 예측 레코드 저장

  --yesterday          저장 키·predictionDate 를 로컬 달력 "어제"로 설정
  --date=YYYY-MM-DD    위와 같이 특정 날짜로 저장 (권장: 배치가 빠진 날)
  --rebackfill-from-doc=TICKER
                       해당 티커 문서에 이미 있는 모든 YYYY-MM-DD 키를 다시 백필
                       (기본: 기존 예측값 유지 + 실측값만 갱신)
  --recompute-prediction
                       --rebackfill-from-doc 시 예측값까지 다시 계산해서 덮어씀
  --market=us|kr       기본 us (--rebackfill-from-doc 시 생략하면 문서에 저장된 market 사용)
  --symbols=A,B,C      쉼표로 구분 (미지정 시 AAPL 또는 005930.KS 단일 종목)
  --sp500              미국 시장일 때 S&P500 상위 --limit 종목
  --limit=N            --sp500 일 때 종목 수 (기본 50)

환경: FIREBASE_SERVICE_ACCOUNT_JSON 또는 GOOGLE_APPLICATION_CREDENTIALS(파일 경로), PREDICT_URL(기본 http://localhost:8001)
`)
      process.exit(0)
    }
  }

  if (rebackfillFromDoc) {
    if (!rebackfillFromDoc.length) {
      throw new Error('--rebackfill-from-doc 에 티커를 지정하세요.')
    }
    return {
      mode: 'rebackfill' as const,
      rebackfillTicker: rebackfillFromDoc,
      rebackfillMode,
      market,
      marketFromArg,
      symbolsStr,
      sp500,
      sp500Limit,
    }
  }

  const targetDate = dateStr ?? localYesterdayYmd()

  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
    throw new Error(`날짜 형식이 잘못되었습니다: ${targetDate}`)
  }

  return {
    mode: 'single' as const,
    targetDate,
    market,
    marketFromArg,
    symbolsStr,
    sp500,
    sp500Limit,
  }
}

async function main() {
  const parsed = parseArgs()

  if (parsed.mode === 'rebackfill') {
    const db = initFirestore()
    const ticker = parsed.rebackfillTicker
    const snap = await db.collection('predictions_v2').doc(ticker).get()
    if (!snap.exists) {
      console.error(`문서 없음: predictions_v2/${ticker}`)
      process.exit(1)
    }
    const data = snap.data() as Record<string, unknown>
    const dates = Object.keys(data)
      .filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k))
      .sort()
    if (dates.length === 0) {
      console.error(`YYYY-MM-DD 형식 키 없음: predictions_v2/${ticker}`)
      process.exit(1)
    }
    const market: Market = parsed.marketFromArg ? parsed.market : inferMarketFromDoc(data)
    console.log(
      `재백필: ${ticker}, 날짜 ${dates.length}개 (${dates[0]} … ${dates[dates.length - 1]}), market=${market}, mode=${parsed.rebackfillMode}`,
    )

    let ok = 0
    let fail = 0
    await runInBatches(dates, CONCURRENCY, async (targetDate) => {
      try {
        await processOneDate(db, ticker, targetDate, market, { mode: parsed.rebackfillMode })
        ok += 1
      } catch (err) {
        console.error(`FAIL ${ticker} ${targetDate}`, err)
        fail += 1
      }
    })
    console.log(`완료: 성공 ${ok}, 실패 ${fail}, 티커 ${ticker}`)
    process.exit(fail > 0 ? 1 : 0)
  }

  const { targetDate, market, symbolsStr, sp500, sp500Limit } = parsed

  let symbols: string[]
  if (symbolsStr) {
    symbols = symbolsStr
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  } else if (sp500 && market === 'us') {
    console.log(`S&P500 상위 ${sp500Limit}종목 로드 중...`)
    symbols = await fetchSp500Symbols(sp500Limit)
  } else {
    symbols = market === 'kr' ? ['005930.KS'] : ['AAPL']
    console.log(`종목 미지정 → 기본 1종목만 처리: ${symbols.join(', ')} (더 많이 넣으려면 --symbols 또는 --sp500)`)
  }

  const db = initFirestore()
  let ok = 0
  let fail = 0

  await runInBatches(symbols, CONCURRENCY, async (ticker) => {
    try {
      await processOneDate(db, ticker, targetDate, market)
      ok += 1
    } catch (err) {
      console.error(`FAIL ${ticker}`, err)
      fail += 1
    }
  })

  console.log(`완료: 성공 ${ok}, 실패 ${fail}, 대상일 ${targetDate}`)
  process.exit(fail > 0 ? 1 : 0)
}

void main()

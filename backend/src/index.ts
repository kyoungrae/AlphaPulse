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
const KIS_ACCOUNT_NUMBER = (process.env.KIS_ACCOUNT_NUMBER || '').trim()
const KIS_TRADE_PASSWORD = (process.env.KIS_TRADE_PASSWORD || '').trim()
const KIS_TIMEOUT_MS = Math.max(2000, Number(process.env.KIS_TIMEOUT_MS ?? 10000))
const KIS_RETRY_MAX_ATTEMPTS = Math.min(5, Math.max(1, Number(process.env.KIS_RETRY_MAX_ATTEMPTS ?? 3)))
const KIS_RETRY_BASE_MS = Math.max(100, Number(process.env.KIS_RETRY_BASE_MS ?? 350))
/** KIS 데이터 REST 호출 최소 간격(ms). 기본 220ms ~= 초당 4~5건 */
const KIS_DATA_MIN_INTERVAL_MS = Math.max(120, Number(process.env.KIS_DATA_MIN_INTERVAL_MS ?? 220))
const AUTO_TRADING_ENABLED = process.env.AUTO_TRADING_ENABLED === 'true'
/** 안전장치: 기본 true(실주문 차단). 실주문은 명시적으로 false 설정 필요 */
const AUTO_TRADING_DRY_RUN = process.env.AUTO_TRADING_DRY_RUN !== 'false'
const AUTO_TRADING_CHECK_MS = Math.max(15_000, Number(process.env.AUTO_TRADING_CHECK_MS ?? 60_000))
const AUTO_TRADING_RUN_HOUR_KST = Math.max(0, Math.min(23, Number(process.env.AUTO_TRADING_RUN_HOUR_KST ?? 9)))
const AUTO_TRADING_RUN_MINUTE_KST = Math.max(0, Math.min(59, Number(process.env.AUTO_TRADING_RUN_MINUTE_KST ?? 1)))
const IS_KIS_PAPER = /openapivts|vts/i.test(KIS_URL_BASE)

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
const SENTIMENT_API_RETRY_COOLDOWN_MS = Math.max(
  5000,
  Number(process.env.SENTIMENT_API_RETRY_COOLDOWN_MS ?? 60_000),
)
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
  { symbol: '^KS200', name: 'KOSPI 200' },
  { symbol: '^KS11', name: 'KOSPI' },
  { symbol: '226490.KS', name: 'KODEX 코스피' },
  { symbol: '069500.KS', name: 'KODEX 200' },
  { symbol: '102110.KS', name: 'TIGER 200' },
  { symbol: '105190.KS', name: 'ACE 200' },
  { symbol: '360750.KS', name: 'TIGER 미국S&P500' },
  { symbol: '214980.KS', name: 'KODEX 미국S&P500선물인버스(H)' },
  { symbol: '379800.KS', name: 'KODEX 미국S&P500TR' },
  { symbol: '360200.KS', name: 'ACE 미국S&P500' },
  { symbol: '133690.KS', name: 'TIGER 미국나스닥100' },
  { symbol: '114800.KS', name: 'KODEX 인버스' },
  { symbol: '252670.KS', name: 'KODEX 200선물인버스2X' },
  { symbol: '252710.KS', name: 'TIGER 200선물인버스2X' },
  { symbol: '251340.KS', name: 'KODEX 코스닥150선물인버스' },
  { symbol: '250780.KS', name: 'TIGER 코스닥150선물인버스' },
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
  { symbol: '011200.KS', name: 'HMM' },
  { symbol: '316140.KS', name: '우리금융지주' },
  { symbol: '086790.KS', name: '하나금융지주' },
  { symbol: '024110.KS', name: '기업은행' },
  { symbol: '018260.KS', name: '삼성에스디에스' },
  { symbol: '009150.KS', name: '삼성전기' },
  { symbol: '010950.KS', name: 'S-Oil' },
  { symbol: '032830.KS', name: '삼성생명' },
  { symbol: '086280.KS', name: '현대글로비스' },
  { symbol: '005490.KS', name: 'POSCO홀딩스' },
  { symbol: '373220.KS', name: 'LG에너지솔루션' },
  { symbol: '361610.KS', name: 'SK아이이테크놀로지' },
  { symbol: '267250.KS', name: 'HD현대' },
  { symbol: '267270.KS', name: 'HD현대건설기계' },
  { symbol: '329180.KS', name: 'HD현대중공업' },
  { symbol: '042660.KS', name: '한화오션' },
  { symbol: '009830.KS', name: '한화솔루션' },
  { symbol: '015760.KS', name: '한국전력' },
  { symbol: '088350.KS', name: '유한양행' },
  { symbol: '326030.KS', name: 'SK바이오팜' },
  { symbol: '302440.KS', name: 'SK바이오사이언스' },
  { symbol: '185750.KS', name: '종근당' },
  { symbol: '192820.KS', name: '코스맥스' },
  { symbol: '214450.KS', name: '파마리서치' },
  { symbol: '278470.KS', name: '에이피알' },
  { symbol: '457190.KS', name: '이수페타시스' },
  { symbol: '042700.KS', name: '한화에어로스페이스' },
  { symbol: '011070.KS', name: 'LG이노텍' },
  { symbol: '161890.KS', name: '한글과컴퓨터' },
  { symbol: '272210.KS', name: '에이치디현대미포' },
  { symbol: '047810.KS', name: '한국항공우주' },
  { symbol: '180640.KS', name: '한진칼' },
  { symbol: '005850.KS', name: '에스엘' },
  { symbol: '004020.KS', name: '현대제철' },
  { symbol: '138040.KS', name: '메리츠금융지주' },
  { symbol: '241560.KS', name: '두산밥캣' },
  { symbol: '383220.KS', name: 'F&F' },
  { symbol: '204320.KS', name: 'HL만도' },
  { symbol: '139480.KS', name: '이마트' },
  { symbol: '069960.KS', name: '현대백화점' },
  { symbol: '009970.KS', name: '영원무역홀딩스' },
  { symbol: '021240.KS', name: '코웨이' },
  { symbol: '039130.KS', name: '하나투어' },
  { symbol: '017800.KS', name: '현대엘리베이터' },
  { symbol: '450080.KS', name: '에코프로머티' },
  { symbol: '022100.KS', name: '포스코DX' },
  { symbol: '128940.KS', name: '한미반도체' },
  { symbol: '352820.KQ', name: '하이브' },
  { symbol: '247540.KQ', name: '에코프로비엠' },
  { symbol: '086520.KQ', name: '에코프로' },
  { symbol: '196170.KQ', name: '알테오젠' },
  { symbol: '145020.KQ', name: '휴젤' },
  { symbol: '058470.KQ', name: '리노공업' },
  { symbol: '403870.KQ', name: 'HPSP' },
  { symbol: '112040.KQ', name: '위메이드' },
  { symbol: '222800.KQ', name: '심텍' },
  { symbol: '140410.KQ', name: '메지온' },
  { symbol: '041190.KQ', name: '우리기술투자' },
  { symbol: '131970.KQ', name: '테스나' },
  { symbol: '214370.KQ', name: '케어젠' },
  { symbol: '348370.KQ', name: '엔켐' },
  { symbol: '277810.KQ', name: '레인보우로보틱스' },
  { symbol: '039200.KQ', name: '오스코텍' },
  { symbol: '253450.KQ', name: '스튜디오드래곤' },
  { symbol: '194480.KQ', name: '데브시스터즈' },
  { symbol: '376300.KQ', name: '디어유' },
  { symbol: '357780.KQ', name: '솔브레인' },
  { symbol: '095340.KQ', name: 'ISC' },
  { symbol: '237690.KQ', name: '에스티팜' },
  { symbol: '141080.KQ', name: '리가켐바이오' },
  { symbol: '215200.KQ', name: '메가스터디교육' },
  { symbol: '310210.KQ', name: '보로노이' },
]

/**
 * S&P 500 티커 → 한글 통용명 (검색·표시). CSV 심볼은 점(.)이 하이픈(-)으로 정규화됨.
 */
const SP500_KR_NAMES: Record<string, string> = {
  A: '에이전트릭스',
  AAPL: '애플',
  ABBV: '애브비',
  ABNB: '에어비앤비',
  ABT: '애벗',
  ACGL: '아치캐피탈',
  ACN: '액센추어',
  ADBE: '어도비',
  ADI: '아나로그디바이스',
  ADM: '아처대니얼스미들랜드',
  ADP: 'ADP',
  ADSK: '오토데스크',
  AEE: '애머렌',
  AEP: 'AEP',
  AES: 'AES',
  AFL: 'AFLAC',
  AIG: 'AIG',
  AIZ: '어쏘리에이션',
  AJG: '아서J갤러거',
  ALB: '알버말',
  ALGN: '얼라인테크놀로지',
  ALL: '올스테이트',
  ALLE: '알레그리온',
  AMAT: '어플라이드머티리얼즈',
  AMCR: '앰코',
  AMD: 'AMD',
  AME: 'AMETEK',
  AMGN: '암젠',
  AMP: '아메리프라이즈',
  AMT: '아메리칸타워',
  AMZN: '아마존',
  ANET: '아리스타',
  ANSS: '앤시스',
  AON: '에온',
  AOS: 'A.O.스미스',
  APA: 'APA',
  APD: '에어프로덕츠',
  APH: '앰페놀',
  APTV: '앱티브',
  ARE: '알렉산드리아리얼에스테이트',
  ATO: '앳모스에너지',
  AVB: '애벌론베이커리',
  AVGO: '브로드컴',
  AVY: '에이버리데니슨',
  AWK: '아메리칸워터웍스',
  AXON: '액슨',
  AXP: '아메리칸익스프레스',
  AZO: '오라일리오토',
  BA: '보잉',
  BAC: '뱅크오브아메리카',
  BALL: '볼',
  BAX: '박스터',
  BBWI: '배스앤바디웍스',
  BBY: '베스트바이',
  BDX: '벡턴딕킨슨',
  BEN: '프랭클린리소시스',
  'BF-B': '브라운포먼',
  BIIB: '바이오젠',
  BIO: '바이오래드',
  BK: '뱅오브뉴욕멜론',
  BKNG: '부킹닷컴',
  BKR: '베이커휴즈',
  BLK: '블랙록',
  BMY: '브리스톨마이어스',
  BR: '브로드리지',
  'BRK-B': '버크셔 해서웨이',
  BRO: '브라운앤브라운',
  BSX: '보스턴사이언티픽',
  BX: '블랙스톤',
  BXP: '보스턴프로퍼티',
  C: '시티그룹',
  CAG: '콘아그라',
  CAH: '카디널헬스',
  CARR: '캐리어',
  CAT: '캐터필러',
  CB: '차브',
  CBOE: 'CBOE',
  CBRE: 'CBRE',
  CCI: '크라운캐슬',
  CCL: '카니발',
  CDNS: '케이던스',
  CDW: 'CDW',
  CE: '셀라니즈',
  CEG: '콘스텔레이션에너지',
  CF: 'CF인더스트리',
  CFG: '시티즌스파이낸셜',
  CHD: '처치앤드와이트',
  CHRW: 'C.H.로빈슨',
  CHTR: '차터커뮤니케이션',
  CI: '시그나',
  CINF: '신시내티파이낸셜',
  CL: '콜게이트',
  CLX: '클로락스',
  CMCSA: '컴캐스트',
  CME: 'CME그룹',
  CMG: '칩올레',
  CMI: '커민스',
  CMS: 'CMS에너지',
  CNC: '센트넷',
  CNP: '센터포인트에너지',
  COF: '캐피털원',
  COO: '쿠퍼',
  COP: '코노코필립스',
  COR: '코디어리',
  COST: '코스트코',
  CPAY: '코퍼페이',
  CPB: '캠벌스',
  CPRT: '코파트',
  CPT: '카멀턴프로퍼티',
  CRL: '찰스리버랩',
  CRM: '세일즈포스',
  CRWD: '크라우드스트라이크',
  CSCO: '시스코',
  CSGP: '코스타그룹',
  CSX: 'CSX',
  CTAS: '신타스',
  CTRA: '코테라에너지',
  CTSH: '코그니전트',
  CTVA: '코티바',
  CVS: 'CVS헬스',
  CVX: '셰브론',
  CZR: '시저스',
  D: '도미니언에너지',
  DAL: '델타항공',
  DASH: '도어대시',
  DAY: '데이포스',
  DD: '듀폰',
  DE: '디어',
  DECK: '덱커스',
  DELL: '델',
  DG: '달러제너럴',
  DGX: '퀘스트다이아그노스틱',
  DHI: 'D.R.호턴',
  DHR: '다나허',
  DIS: '디즈니',
  DLR: '디지털리얼티',
  DLTR: '달러트리',
  DOC: '헬스피크',
  DOV: '도버',
  DOW: '다우',
  DPZ: '도미노피자',
  DRI: '다든레스토랑',
  DTE: 'DTE에너지',
  DUK: '듀크에너지',
  DVA: '다비타',
  DVN: '데본에너지',
  DXCM: '덱스콤',
  EA: '일렉트로닉아츠',
  EBAY: '이베이',
  ECL: '이콜랩',
  ED: '콘솔리데이티드에디슨',
  EFX: '이퀴팩스',
  EG: '에버레스트그룹',
  EIX: '에디슨인터내셔널',
  EL: '에스티로더',
  ELV: '엘리번스',
  EMN: '이스트만케미컬',
  EMR: '에머슨',
  ENPH: '엔페이즈에너지',
  EOG: 'EOG리소스',
  EPAM: 'EPAM',
  EQIX: '이퀴닉스',
  EQR: '에쿼티레지덴셜',
  ERIE: '이리인슈어런스',
  ES: '이버소스',
  ESS: '에섹스프로퍼티',
  ETN: '이튼',
  ETR: '엔터지',
  EVRG: '에버지에너지',
  EW: '에드워드라이프사이언시스',
  EXC: '엑셀론',
  EXE: '이엑스피에너지',
  EXPD: '익스피디터스',
  EXPE: '익스피디아',
  EXR: '엑스트라스페이스',
  F: '포드',
  FANG: '다이아몬드백에너지',
  FAST: '패스널',
  FCX: '프리포트맥모란',
  FDS: '팩트셋',
  FDX: '페덱스',
  FE: '퍼스트에너지',
  FFIV: 'F5',
  FICO: '페어아이작',
  FIS: 'FIS',
  FITB: '피프스서드뱅크',
  FOX: '폭스B',
  FOXA: '폭스A',
  FRT: '페더럴리얼티',
  FSLR: '퍼스트솔라',
  FTNT: '포티넷',
  FTV: '포티브',
  GD: '제너럴디나믹스',
  GE: 'GE',
  GEHC: 'GE헬스케어',
  GEN: '젠디지털',
  GEV: 'GE버노바',
  GILD: '길리어드',
  GIS: '제너럴밀스',
  GL: '글로브라이프',
  GLW: '코닝',
  GM: 'GM',
  GNRC: '제너랙',
  GOOG: '구글C',
  GOOGL: '구글',
  GPC: '진뉴인파츠',
  GPN: '글로벌페이먼츠',
  GRMN: '가민',
  GS: '골드만삭스',
  GWW: '그레인저',
  HAL: '할리버튼',
  HAS: '해즈브로',
  HBAN: '헌팅턴뱅크샤어스',
  HCA: 'HCA',
  HD: '홈디포',
  HES: '헤스',
  HIG: '하트포드',
  HII: '헌팅턴잉걸스',
  HLT: '힐튼',
  HOLX: '홀로직',
  HON: '허니웰',
  HPE: 'HPE',
  HPQ: 'HP',
  HRL: '호멜푸즈',
  HSIC: '헨리셰인',
  HST: '호스트호텔',
  HSY: '허쉬',
  HUBB: '허벨',
  HUM: '휴매나',
  HWM: '하우멧',
  IBM: 'IBM',
  ICE: '인터컨티넨탈거래소',
  IDXX: '아이덱스',
  IEX: 'IDEX',
  IFF: 'IFF',
  INCY: '인사이트',
  INTC: '인텔',
  INTU: '인튜이트',
  INVH: '인비테이션홈즈',
  IP: '인터내셔널페이퍼',
  IPG: '인터퍼블릭',
  IQV: 'IQVIA',
  IR: '잉가솔랜드',
  IRM: '아이언마운틴',
  ISRG: '인튜이티브서지컬',
  IT: 'Gartner',
  ITW: '일리노이스툴웍스',
  IVZ: '인베스코',
  J: '제이콥스',
  JBHT: 'J.B.헌트',
  JBL: 'J빌',
  JCI: '존슨콘트롤즈',
  JKHY: '잭헨리',
  JNJ: '존슨앤드존슨',
  JPM: 'JP모건',
  K: '켈로그',
  KDP: '큐리그닥터페퍼',
  KEY: '키뱅크',
  KEYS: '키사이트',
  KHC: '크래프트하인즈',
  KIM: '킴코리얼티',
  KKR: 'KKR',
  KLAC: '클라텍',
  KMB: '킴벌리클라크',
  KMI: '킨더모건',
  KMX: '카맥스',
  KO: '코카콜라',
  KR: '크로거',
  L: '로우즈',
  LDOS: '라이도스',
  LEN: '레나',
  LH: '래버러토리코프오브아메리카',
  LHX: 'L3해리스',
  LII: '레녹스',
  LIN: '린데',
  LKQ: 'LKQ',
  LLY: '일라이릴리',
  LMT: '록히드마틴',
  LNT: '앨라인트에너지',
  LOW: '로우스',
  LRCX: '램리서치',
  LULU: '룰루레몬',
  LUV: '사우스웨스트',
  LVS: '라스베이거스샌즈',
  LW: '람웨스턴',
  LYB: '라이온델바셀',
  LYV: '라이브네이션',
  MA: '마스터카드',
  MAA: '미드아메리카아파트',
  MAR: '메리어트',
  MAS: '매스코',
  MCD: '맥도날드',
  MCHP: '마이크로칩',
  MCK: '맥케슨',
  MCO: '무디스',
  MDLZ: '몬델리즈',
  MDT: '메드트로닉',
  MET: '메트라이프',
  META: '메타',
  MGM: 'MGM리조트',
  MKC: '맥코믹',
  MLM: '마틴마리에타',
  MMC: '마쉬맥레넌',
  MMM: '3M',
  MNST: '몬스터베버리지',
  MO: '알트리아',
  MOH: '몰리나헬스케어',
  MOS: '모자이크',
  MPC: '마라톤페트롤리움',
  MPWR: '모놀리식파워',
  MRK: '머크',
  MRNA: '모더나',
  MS: '모건스탠리',
  MSCI: 'MSCI',
  MSFT: '마이크로소프트',
  MSI: '모토로라솔루션',
  MTB: 'M&T뱅크',
  MTCH: '매치그룹',
  MTD: '메틀러토레도',
  MU: '마이크론',
  NCLH: '노르웨이안크루즈',
  NDAQ: '나스닥',
  NDSN: '노드슨',
  NEE: '넥스트에라에너지',
  NEM: '뉴몬트',
  NFLX: '넷플릭스',
  NI: '니소스',
  NKE: '나이키',
  NOC: '노스롭그루먼',
  NOW: '서비스나우',
  NRG: 'NRG에너지',
  NSC: '노퍽서던',
  NTAP: '넷앱',
  NTRS: '노던트러스트',
  NUE: '뉴코어',
  NVDA: '엔비디아',
  NVR: 'NVR',
  NWS: '뉴스코프B',
  NWSA: '뉴스코프A',
  NXPI: 'NXP',
  O: '리얼티인컴',
  ODFL: '올드도미니언',
  OKE: '원오케이',
  OMC: '옴니콤',
  ON: '온세미',
  ORCL: '오라클',
  ORLY: '오라일리',
  OTIS: '오티스',
  OXY: '옥시덴탈',
  PANW: '팔로알토네트웍스',
  PARA: '파라마운트',
  PAYC: '페이컴',
  PAYX: '페이첵스',
  PCAR: 'PACCAR',
  PCG: 'PG&E',
  PEG: '퍼블릭서비스',
  PEP: '펩시코',
  PFE: '화이자',
  PFG: '프린시펄파이낸셜',
  PG: 'P&G',
  PGR: '프로그레시브',
  PH: '파커하니핀',
  PHM: '풀티그룹',
  PKG: '패키징코퍼오브아메리카',
  PLD: '프로로지스',
  PM: '필립모리스',
  PNC: 'PNC',
  PNR: '펜타이어',
  POOL: '풀',
  PPG: 'PPG인더스트리',
  PPL: 'PPL',
  PRU: '푸르덴셜',
  PSA: '퍼블릭스토리지',
  PSKY: '파라마운트스카이',
  PSX: '필립스66',
  PTC: 'PTC',
  PWR: '쿼스트',
  PYPL: '페이팔',
  QCOM: '퀄컴',
  RCL: '로얄캐리비안',
  REG: '리젠시센터',
  REGN: '리제네론',
  RF: '리전스파이낸셜',
  RJF: '레이몬드제임스',
  RL: '랄프로렌',
  RMD: '레스메드',
  ROK: '록웰오토메이션',
  ROL: '롤린스',
  ROP: '로퍼테크놀로지',
  ROST: '로스스토어',
  RSG: '리퍼블릭서비스',
  RTX: '레이시온',
  RVTY: '리바티',
  SBAC: 'SBA커뮤니케이션',
  SBUX: '스타벅스',
  SCHW: '찰스슈왑',
  SHW: '셔윈윌리엄스',
  SJM: '스머커',
  SLB: '슐럼버거',
  SMCI: '슈퍼마이크로',
  SNA: '스냅온',
  SNPS: '시높시스',
  SO: '서던컴퍼니',
  SOLV: '솔벤트움',
  SPG: '사이먼프로퍼티',
  SPGI: 'S&P글로벌',
  SRE: '세미프라이에너지',
  STE: 'STERIS',
  STLD: '스틸다이나믹스',
  STT: '스테이트스트리트',
  STX: '시게이트',
  STZ: '컨스텔레이션브랜즈',
  SW: '스모우더스',
  SWK: '스탠리블랙앤덱커',
  SWKS: '스카이웍스',
  SYF: '싱크파이낸셜',
  SYK: '스트라이커',
  SYY: '시스코푸드',
  T: 'AT&T',
  TAP: '몰슨쿠어스',
  TDG: '트랜스다임',
  TDY: '테이들인',
  TECH: '바이오테크',
  TEL: 'TE커넥티비티',
  TER: '테라다인',
  TFC: '트루이스트',
  TGT: '타깃',
  TJX: 'TJX',
  TKO: 'TKO그룹',
  TMO: '써모피셔',
  TMUS: 'T모바일',
  TPL: '텍사스퍼시픽랜드',
  TPR: '테이프리',
  TRGP: '타르가리소스',
  TRMB: '트림블',
  TROW: '티로우프라이스',
  TRV: '트래블러스',
  TSCO: '트랙터서플라이',
  TSLA: '테슬라',
  TSN: '타이슨푸즈',
  TT: '트레인테크놀로지',
  TTD: '트레이드데스크',
  TTWO: '테이크투',
  TXN: '텍사스인스트루먼트',
  TXT: '텍스트론',
  TYL: '타일러테크놀로지',
  UAL: '유나이티드항공',
  UBER: '우버',
  UDR: 'UDR',
  UHS: '유니버설헬스',
  ULTA: '얼타뷰티',
  UNH: '유나이티드헬스',
  UNP: '유니언퍼시픽',
  UPS: 'UPS',
  URI: '유나이티드렌탈',
  USB: 'US뱅코프',
  V: '비자',
  VICI: 'VICI프로퍼티',
  VLO: '발레로',
  VLTO: '베론토',
  VMC: '불마틴',
  VRSK: '베리스크',
  VRSN: '베리사인',
  VRTX: '버텍스',
  VST: '비스트라에너지',
  VTR: '벤타스',
  VTRS: '비아트리스',
  VZ: '버라이즌',
  WAB: '웨스팅하우스브레이크',
  WAT: '워터스',
  WBA: '월그린즈',
  WBD: '워너브로스디스커버리',
  WDAY: '워크데이',
  WDC: '웨스턴디지털',
  WEC: 'WEC에너지',
  WELL: '웰타워',
  WFC: '웰스파고',
  WM: '폐기물관리',
  WMB: '윌리엄스컴퍼니',
  WMT: '월마트',
  WRB: 'W.R.버클리',
  WSM: '윌리엄스소노마',
  WST: '웨스트파머시컬',
  WTW: '윌리스타워스왓슨',
  WYNN: '윈리조트',
  XEL: '자일',
  XOM: '엑슨모빌',
  XYL: '자일럼',
  XYZ: '블록',
  YUM: '얌브랜즈',
  ZBH: '짐머바이오멧',
  ZBRA: '제브라',
  ZTS: '조에티스',
}

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
/** S&P500 CSV 네트워크 갱신 — 동시에 하나만 실행 */
let sp500RefreshPromise: Promise<void> | null = null
let firestoreDb: FirebaseFirestore.Firestore | null = null
let firestoreDisabledReason: string | null = null
const dailyJobRunningByMarket: Record<Market, boolean> = { us: false, kr: false }
const dailyJobLastRunDateByMarket: Record<Market, string | null> = { us: null, kr: null }
const stockCache = new Map<string, CacheEntry<{ date: string; close: number }[]>>()
const predictCache = new Map<string, CacheEntry<Record<string, unknown>>>()
const fxCache = new Map<string, CacheEntry<{ rate: number; asOf: string }>>()
/** 야후 quote 단건 폴링 완화(프론트 실시간 현황용) */
const quoteLiveCache = new Map<string, { payload: Record<string, unknown>; cachedAt: number }>()
/** 실시간 시세 API 캐시 — KIS 부하 완화(프론트 1초 폴링 시 약간 짧게 두어 갱신 빈도 확보) */
const QUOTE_LIVE_CACHE_TTL_MS = Math.max(0, Number(process.env.QUOTE_LIVE_CACHE_TTL_MS ?? 800))
/** 분봉 차트(실시간 현황 페이지) — 야후 호출 부하 완화 */
const intradayLiveCache = new Map<string, { payload: Record<string, unknown>; cachedAt: number }>()
/** 동시 다발적인 동일 종목 요청 병합(Deduplication) */
const quoteInFlight = new Map<string, Promise<Record<string, unknown>>>()
const intradayInFlight = new Map<string, Promise<Record<string, unknown>>>()
/** 당일 분봉 API 캐시 — 실시간 현재가 보정이 있으므로 분봉 원본은 여유 있게 캐시 */
const INTRADAY_CHART_CACHE_TTL_MS = Math.max(0, Number(process.env.INTRADAY_CHART_CACHE_TTL_MS ?? 10_000))
const backtestMemoryCache = new Map<string, CacheEntry<ReturnType<typeof runBacktest>>>()
const kisTokenCache: { token: string | null; expiresAtMs: number } = { token: null, expiresAtMs: 0 }
const KIS_TOKEN_REDIS_KEY = 'kis:oauth:token'
let kisTokenPromise: Promise<string> | null = null
/** KIS 토큰 발급 제한(예: EGW00133) 방지를 위한 로컬 쿨다운 */
let kisTokenRetryNotBeforeMs = 0
/** 데이터 API TPS 초과(EGW00201) 방지를 위한 전역 직렬화 게이트 */
let kisDataRequestQueue: Promise<void> = Promise.resolve()
let kisDataLastRequestAtMs = 0
let sentimentApiBackoffUntil = 0
const redisClient = redisUrl ? createClient({ url: redisUrl }) : null

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
type AutoTradingConfig = {
  isActive: boolean
  aiTicker: string
  upSymbol: string
  downSymbol: string
  symbolsLocked: boolean
  threshold: number
  tradeAmount: number
}

let autoTradingConfig: AutoTradingConfig = {
  isActive: false,
  aiTicker: '^KS200',
  upSymbol: '122630.KS',
  downSymbol: '252710.KS',
  symbolsLocked: true,
  threshold: 60,
  tradeAmount: 1_000_000,
}
let autoTradingLastRunDate = ''
const autoTradeLogs: AutoTradeLog[] = []
let autoTradeLogSeq = 1

async function loadAutoTradingConfig(): Promise<void> {
  const db = getFirestore()
  if (!db) return
  try {
    const doc = await db.collection('system_config').doc('auto_trading').get()
    if (!doc.exists) return
    const data = (doc.data() ?? {}) as Partial<AutoTradingConfig>
    autoTradingConfig = {
      ...autoTradingConfig,
      ...data,
      threshold: Math.max(50, Math.min(99, Number(data.threshold ?? autoTradingConfig.threshold))),
      tradeAmount: Math.max(1, Number(data.tradeAmount ?? autoTradingConfig.tradeAmount)),
    }
    console.log('[AutoTrade] Firestore에서 설정을 불러왔습니다.', autoTradingConfig)
  } catch (err) {
    console.error('[AutoTrade] 설정 로드 실패:', err)
  }
}
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

/** KIS 일봉 API(6자리 종목코드) — 지수(^KS200)·비표준 .KS 심볼은 야후만 사용 */
function isKoreanSixDigitEquity(ticker: string): boolean {
  return /^\d{6}\.(KS|KQ)$/i.test(ticker)
}

/** 종목 검색용 한국 지수 — KIS 호가·체결 API 대신 Yahoo 시세 */
const KOREA_YAHOO_INDEX_SYMBOLS = new Set(['^KS200', '^KS11'])

function isKoreanYahooIndexTicker(ticker: string): boolean {
  return KOREA_YAHOO_INDEX_SYMBOLS.has(ticker.toUpperCase())
}

const CHART_ANCHOR_YEAR_MIN = 2016

function chartMarketTimezone(ticker: string): string {
  const u = ticker.toUpperCase()
  if (u.endsWith('.KS') || u.endsWith('.KQ')) return 'Asia/Seoul'
  if (u.startsWith('^KS') || u.startsWith('^KQ')) return 'Asia/Seoul'
  return 'America/New_York'
}

/** 거래소 타임존 기준 YYYY-MM-DD */
function ymdInTimeZoneLabel(isoOrNow: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(isoOrNow)
  const y = parts.find((p) => p.type === 'year')?.value ?? '1970'
  const m = parts.find((p) => p.type === 'month')?.value ?? '01'
  const d = parts.find((p) => p.type === 'day')?.value ?? '01'
  return `${y}-${m}-${d}`
}

function padChart2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** 해당 타임존에서 자정 기준 분 (정규장 필터용) */
function minutesSinceMidnightInTz(iso: string, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso))
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0')
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? '0')
  return h * 60 + m
}

/** 정규장 구간에서 가장 최근 봉이 속한 거래일만 남김(야후 말미 봉이 장전이면 빈 배열 방지) */
function filterIntradayQuotesToLastSession(
  sorted: Array<{ date: Date; close: number }>,
  ticker: string,
): Array<{ date: Date; close: number }> {
  if (!sorted.length) return []
  const tz = chartMarketTimezone(ticker)
  const isKr = tz === 'Asia/Seoul'
  const openMin = isKr ? 9 * 60 : 9 * 60 + 30
  const closeMin = isKr ? 15 * 60 + 30 : 16 * 60
  let sessionYmd: string | null = null
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const row = sorted[i]
    const mins = minutesSinceMidnightInTz(row.date.toISOString(), tz)
    if (mins >= openMin && mins <= closeMin) {
      sessionYmd = ymdInTimeZoneLabel(row.date, tz)
      break
    }
  }
  if (!sessionYmd) return []
  return sorted.filter((row) => {
    if (ymdInTimeZoneLabel(row.date, tz) !== sessionYmd) return false
    const mins = minutesSinceMidnightInTz(row.date.toISOString(), tz)
    return mins >= openMin && mins <= closeMin
  })
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

async function awaitKisDataRateSlot(): Promise<void> {
  const prev = kisDataRequestQueue
  let release!: () => void
  kisDataRequestQueue = new Promise<void>((resolve) => {
    release = resolve
  })
  await prev
  try {
    const now = Date.now()
    const waitMs = kisDataLastRequestAtMs + KIS_DATA_MIN_INTERVAL_MS - now
    if (waitMs > 0) await sleep(waitMs)
    kisDataLastRequestAtMs = Date.now()
  } finally {
    release()
  }
}

async function fetchKisDataWithRetry(url: string, init: RequestInit, label: string): Promise<globalThis.Response> {
  let lastError: Error | null = null
  for (let attempt = 1; attempt <= KIS_RETRY_MAX_ATTEMPTS; attempt += 1) {
    try {
      await awaitKisDataRateSlot()
      const response = await fetch(url, init)
      if (response.ok) return response
      const body = await response.text()
      const retryable =
        response.status === 429 || response.status === 500 || response.status === 503 || isKisRetryableErrorMessage(body)
      if (!retryable || attempt >= KIS_RETRY_MAX_ATTEMPTS) {
        throw new Error(`${label} HTTP ${response.status}: ${body}`)
      }
      const waitMs = KIS_RETRY_BASE_MS * 2 ** (attempt - 1)
      await sleep(waitMs)
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
  throw lastError ?? new Error(`${label} failed`)
}

async function getKisAccessToken(): Promise<string> {
  if (!KIS_APP_KEY || !KIS_APP_SECRET) {
    throw new Error('KIS_APP_KEY/KIS_APP_SECRET is not configured')
  }
  const now = Date.now()
  if (kisTokenCache.token && now < kisTokenCache.expiresAtMs) {
    return kisTokenCache.token
  }
  const redisCached = await getRedisJson<{ token?: string; expiresAtMs?: number }>(KIS_TOKEN_REDIS_KEY)
  if (
    redisCached &&
    typeof redisCached.token === 'string' &&
    redisCached.token &&
    typeof redisCached.expiresAtMs === 'number' &&
    now < redisCached.expiresAtMs
  ) {
    kisTokenCache.token = redisCached.token
    kisTokenCache.expiresAtMs = redisCached.expiresAtMs
    return redisCached.token
  }
  if (now < kisTokenRetryNotBeforeMs) {
    const waitSec = Math.ceil((kisTokenRetryNotBeforeMs - now) / 1000)
    throw new Error(`KIS token cooldown in progress. retry after ${waitSec}s`)
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
        const body = await response.text()
        if (response.status === 403 && body.includes('EGW00133')) {
          /** 안내 메시지 기준 1분당 1회 제한 + 안전 여유 */
          kisTokenRetryNotBeforeMs = Date.now() + 65_000
        }
        throw new Error(`KIS token error: ${response.status} ${body}`)
      }
      const json = (await response.json()) as { access_token?: string; expires_in?: number | string }
      if (!json.access_token) throw new Error('KIS token missing in response')
      const expiresInSecRaw =
        typeof json.expires_in === 'number'
          ? json.expires_in
          : typeof json.expires_in === 'string'
            ? Number(json.expires_in)
            : NaN
      const expiresInSec = Number.isFinite(expiresInSecRaw) && expiresInSecRaw > 120 ? expiresInSecRaw : 24 * 60 * 60
      /** 만료 직전 실패를 피하려고 60초 여유를 둠 */
      kisTokenCache.token = json.access_token
      kisTokenCache.expiresAtMs = Date.now() + expiresInSec * 1000 - 60_000
      await setRedisJson(
        KIS_TOKEN_REDIS_KEY,
        { token: kisTokenCache.token, expiresAtMs: kisTokenCache.expiresAtMs },
        Math.max(60, Math.floor(expiresInSec - 60)),
      )
      kisTokenRetryNotBeforeMs = 0
      return json.access_token
    } finally {
      kisTokenPromise = null
    }
  })()
  return kisTokenPromise
}

function parseKisAccountNumber(): { cano: string; acntPrdtCd: string } {
  const [rawCano, rawCode] = KIS_ACCOUNT_NUMBER.split('-')
  const cano = (rawCano || '').trim()
  const acntPrdtCd = (rawCode || '01').trim()
  if (!cano) {
    throw new Error('KIS_ACCOUNT_NUMBER 환경 변수가 필요합니다. 예: 12345678-01')
  }
  return { cano, acntPrdtCd }
}

/** KIS 국내주식 잔고 조회 */
async function fetchKisBalance(): Promise<{ cash: number; holdings: Array<Record<string, unknown>> }> {
  const token = await getKisAccessToken()
  const { cano, acntPrdtCd } = parseKisAccountNumber()
  const params = new URLSearchParams({
    CANO: cano,
    ACNT_PRDT_CD: acntPrdtCd,
    AFHR_FLG: 'N',
    OFL_YN: '',
    INQR_DVSN: '02',
    UNPR_DVSN: '01',
    FUND_STTL_ICLD_YN: 'N',
    FUTS_ICLD_YN: 'N',
  })
  const response = await fetchKisDataWithRetry(
    `${KIS_URL_BASE}/uapi/domestic-stock/v1/trading/inquire-balance?${params.toString()}`,
    {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        authorization: `Bearer ${token}`,
        appkey: KIS_APP_KEY || '',
        appsecret: KIS_APP_SECRET || '',
        tr_id: IS_KIS_PAPER ? 'VTTC8434R' : 'TTTC8434R',
      },
      signal: AbortSignal.timeout(KIS_TIMEOUT_MS),
    },
    'KIS inquire-balance',
  )
  const data = (await response.json()) as {
    rt_cd?: string
    msg1?: string
    output1?: Array<Record<string, unknown>>
    output2?: Array<Record<string, unknown>>
  }
  if (data.rt_cd !== '0') {
    throw new Error(`KIS inquire-balance: ${data.msg1 ?? 'unknown'}`)
  }
  const cashRaw = data.output2?.[0]?.dnca_tot_amt
  const cash = Number(String(cashRaw ?? 0).replace(/,/g, ''))
  return {
    cash: Number.isFinite(cash) ? cash : 0,
    holdings: Array.isArray(data.output1) ? data.output1 : [],
  }
}

/** KIS 국내주식 주문 (시장가) */
async function placeKisOrder(side: 'buy' | 'sell', ticker: string, qty: number): Promise<Record<string, unknown>> {
  if (!KIS_TRADE_PASSWORD) {
    throw new Error('KIS_TRADE_PASSWORD 환경 변수가 필요합니다.')
  }
  const token = await getKisAccessToken()
  const { cano, acntPrdtCd } = parseKisAccountNumber()
  const pdno = ticker.toUpperCase().replace(/\.(KS|KQ)$/i, '')
  const body = {
    CANO: cano,
    ACNT_PRDT_CD: acntPrdtCd,
    PDNO: pdno,
    ORD_DVSN: '01',
    ORD_QTY: String(Math.max(1, Math.floor(qty))),
    ORD_UNPR: '0',
    ORD_PSWD: KIS_TRADE_PASSWORD,
  }
  const trId = IS_KIS_PAPER
    ? side === 'buy'
      ? 'VTTC0802U'
      : 'VTTC0801U'
    : side === 'buy'
      ? 'TTTC0802U'
      : 'TTTC0801U'
  const response = await fetchKisDataWithRetry(
    `${KIS_URL_BASE}/uapi/domestic-stock/v1/trading/order-cash`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        authorization: `Bearer ${token}`,
        appkey: KIS_APP_KEY || '',
        appsecret: KIS_APP_SECRET || '',
        tr_id: trId,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(KIS_TIMEOUT_MS),
    },
    `KIS order-${side}`,
  )
  return (await response.json()) as Record<string, unknown>
}

function getHoldingQty(holdings: Array<Record<string, unknown>>, ticker: string): number {
  const pdno = ticker.toUpperCase().replace(/\.(KS|KQ)$/i, '')
  const found = holdings.find((h) => String(h.pdno ?? '').trim() === pdno)
  if (!found) return 0
  const qty = Number(String(found.hldg_qty ?? found.hold_qty ?? 0).replace(/,/g, ''))
  return Number.isFinite(qty) ? qty : 0
}

function pushAutoTradeLog(log: Omit<AutoTradeLog, 'id'>): void {
  autoTradeLogs.unshift({ id: autoTradeLogSeq++, ...log })
  if (autoTradeLogs.length > 300) autoTradeLogs.length = 300
}

function nowKstYmdHm(): { ymd: string; hour: number; minute: number; iso: string } {
  const now = new Date()
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)
  const y = parts.find((p) => p.type === 'year')?.value ?? '1970'
  const m = parts.find((p) => p.type === 'month')?.value ?? '01'
  const d = parts.find((p) => p.type === 'day')?.value ?? '01'
  const hh = Number(parts.find((p) => p.type === 'hour')?.value ?? '0')
  const mm = Number(parts.find((p) => p.type === 'minute')?.value ?? '0')
  return { ymd: `${y}-${m}-${d}`, hour: hh, minute: mm, iso: now.toISOString() }
}

async function executeAutoTrading(clockDate: string, force = false): Promise<void> {
  if (!autoTradingConfig.isActive && !force) return
  const isDryRun = AUTO_TRADING_DRY_RUN
  const aiTicker = autoTradingConfig.aiTicker.trim()
  const upSymbol = autoTradingConfig.upSymbol.trim().toUpperCase()
  const downSymbol = autoTradingConfig.downSymbol.trim().toUpperCase()
  if (!aiTicker || !upSymbol || !downSymbol) {
    console.error('[AutoTrade] 설정 누락: aiTicker/upSymbol/downSymbol 을 확인하세요.')
    return
  }

  console.log(`\n========== [AutoTrade] 자동 매매 프로세스 시작 (${clockDate}) ==========`)
  console.log(`모드: ${isDryRun ? 'DRY_RUN (모의 테스트, 실제 주문 X)' : 'LIVE (실제 주문 실행!)'}`)

  try {
    const predict = await fetchPredict(aiTicker, undefined, 1)
    const probUp = Number(predict.probability_up) * 100
    const probDown = 100 - probUp
    const threshold = Math.max(50, Math.min(99, Number(autoTradingConfig.threshold) || 60))
    const aiDecision = probUp >= threshold ? '상승' : probDown >= threshold ? '하락' : '관망'
    const aiResultStr = `AI: ${aiDecision} (상승 ${probUp.toFixed(1)}% / 하락 ${probDown.toFixed(1)}%)`
    console.log(`[AutoTrade] ${aiTicker} ${aiResultStr} (기준: ${threshold}%)`)

    let targetSymbol: string | null = null
    if (probUp >= threshold) targetSymbol = upSymbol
    else if (probDown >= threshold) targetSymbol = downSymbol
    if (!targetSymbol) {
      console.log(`[AutoTrade] 확률이 기준치(${threshold}%)를 넘지 않아 관망(Hold)합니다.`)
      pushAutoTradeLog({
        time: nowKstYmdHm().iso,
        action: 'analyze',
        symbol: aiTicker,
        name: `AI 예측: 관망 (${probUp.toFixed(1)}%)`,
        qty: 0,
        price: 0,
        status: `미달 (기준:${threshold}%)`,
      })
      return
    }

    const { cash, holdings } = await fetchKisBalance()
    const nowIso = nowKstYmdHm().iso

    for (const item of holdings) {
      const heldSymbol = `${String(item.pdno ?? '').trim()}.KS`
      const qty = Number(item.hldg_qty ?? item.hold_qty ?? 0)
      if (qty > 0 && heldSymbol !== targetSymbol && (heldSymbol === upSymbol || heldSymbol === downSymbol)) {
        console.log(`[AutoTrade] 반대 포지션 청산: ${heldSymbol} ${qty}주 시장가 매도`)
        if (isDryRun) {
          pushAutoTradeLog({
            time: nowIso,
            action: 'sell',
            symbol: heldSymbol,
            name: `방향 전환 청산 (${aiResultStr})`,
            qty,
            price: 0,
            status: 'DRY_RUN',
          })
        } else {
          const sellRes = await placeKisOrder('sell', heldSymbol, qty)
          pushAutoTradeLog({
            time: nowIso,
            action: 'sell',
            symbol: heldSymbol,
            name: `방향 전환 청산 (${aiResultStr})`,
            qty,
            price: 0,
            status: String(sellRes.msg1 ?? sellRes.rt_cd ?? '매도 전송'),
          })
          await sleep(2000)
        }
      }
    }

    const alreadyHeld = holdings.find((h) => `${String(h.pdno ?? '').trim()}.KS` === targetSymbol)
    if (alreadyHeld && Number(alreadyHeld.hldg_qty ?? alreadyHeld.hold_qty ?? 0) > 0) {
      console.log(`[AutoTrade] 이미 타겟 종목(${targetSymbol})을 보유 중이므로 매수 생략합니다.`)
      return
    }

    const targetPriceData = await fetchKisDomesticInquirePriceOutput(targetSymbol.replace('.KS', ''))
    const currentPrice = Number(targetPriceData.stck_prpr)
    if (!(currentPrice > 0)) {
      console.log(`[AutoTrade] 현재가 조회 실패로 매수 생략 (${targetSymbol})`)
      return
    }
    const investAmount = Math.min(cash, Math.max(1, Number(autoTradingConfig.tradeAmount)))
    const buyQty = Math.floor(investAmount / currentPrice)
    if (buyQty <= 0) {
      const reason = `잔고 부족 (현재가: ${currentPrice.toLocaleString()}원, 가용금액: ${investAmount.toLocaleString()}원)`
      console.log(`[AutoTrade] 매수 실패: ${reason}`)
      pushAutoTradeLog({
        time: nowIso,
        action: 'buy_fail',
        symbol: targetSymbol,
        name: `잔고 부족으로 매수 스킵 (${aiResultStr})`,
        qty: 0,
        price: currentPrice,
        status: '예수금/설정금액 부족',
      })
      return
    }
    console.log(`[AutoTrade] 신규 포지션 진입: ${targetSymbol} ${buyQty}주 시장가 매수 (예상단가: ${currentPrice})`)
    if (isDryRun) {
      pushAutoTradeLog({
        time: nowIso,
        action: 'buy',
        symbol: targetSymbol,
        name: `AI 시그널 진입 (${aiResultStr})`,
        qty: buyQty,
        price: currentPrice,
        status: 'DRY_RUN',
      })
    } else {
      const buyRes = await placeKisOrder('buy', targetSymbol, buyQty)
      pushAutoTradeLog({
        time: nowIso,
        action: 'buy',
        symbol: targetSymbol,
        name: `AI 시그널 진입 (${aiResultStr})`,
        qty: buyQty,
        price: currentPrice,
        status: String(buyRes.msg1 ?? buyRes.rt_cd ?? '매수 전송'),
      })
    }
  } catch (err) {
    console.error('[AutoTrade] 실행 중 오류 발생:', err)
  } finally {
    console.log('=================================================================\n')
  }
}

type KisDailyRow = { date: string; open: number; high: number; low: number; close: number; volume: number }

/** KIS 일봉 차트는 한 번에 최대 약 100건 근처만 반환 → 긴 구간은 쪼개서 병합 */
function addCalendarDaysYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + days)
  return dt.toISOString().slice(0, 10)
}

async function fetchKisDailyClosesOnce(
  ticker: string,
  fromYmd: string,
  toYmd: string,
): Promise<KisDailyRow[]> {
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
        /** 0=수정주가(분할·배당 반영), 1=원주가 — 차트는 시계열 비교를 위해 수정주가 사용 */
        FID_ORG_ADJ_PRC: '0',
      })
      const response = await fetchKisDataWithRetry(
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
        'KIS daily-itemchartprice',
      )
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

async function fetchKisDailyCloses(ticker: string, fromYmd: string, toYmd: string): Promise<KisDailyRow[]> {
  if (fromYmd > toYmd) return []
  /** ~80일씩 요청 시 거래일 수가 100건 제한 아래에 머무르는 경우가 많음 */
  const CHUNK_CAL_DAYS = 80
  const merged = new Map<string, KisDailyRow>()
  let chunkStart = fromYmd
  let guard = 0
  while (chunkStart <= toYmd && guard < 64) {
    guard += 1
    const chunkEndCandidate = addCalendarDaysYmd(chunkStart, CHUNK_CAL_DAYS - 1)
    const chunkEnd = chunkEndCandidate > toYmd ? toYmd : chunkEndCandidate
    const rows = await fetchKisDailyClosesOnce(ticker, chunkStart, chunkEnd)
    for (const r of rows) {
      merged.set(r.date, r)
    }
    chunkStart = addCalendarDaysYmd(chunkEnd, 1)
  }
  return [...merged.values()].sort((a, b) => a.date.localeCompare(b.date))
}

function kisStrNum(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v !== 'string' || v.trim() === '') return null
  const n = Number(v.replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

function seoulHHMMSS(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Seoul',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d)
  const h = parts.find((p) => p.type === 'hour')?.value ?? '00'
  const m = parts.find((p) => p.type === 'minute')?.value ?? '00'
  const s = parts.find((p) => p.type === 'second')?.value ?? '00'
  return `${h}${m}${s}`
}

function hhmmssMinusOneMinute(hhmmss: string): string {
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n))
  const h = Number(hhmmss.slice(0, 2))
  const m = Number(hhmmss.slice(2, 4))
  const s = Number(hhmmss.slice(4, 6))
  if (![h, m, s].every((x) => Number.isFinite(x))) return '090000'
  let total = h * 3600 + m * 60 + s - 60
  if (total < 0) total = 0
  const nh = Math.floor(total / 3600)
  const nm = Math.floor((total % 3600) / 60)
  const ns = total % 60
  return `${pad(nh)}${pad(nm)}${pad(ns)}`
}

function krxMarketStateGuess(): string {
  const { weekday, hour, minute } = getSeoulClock()
  if (weekday === 'Sat' || weekday === 'Sun') return 'CLOSED'
  const mins = hour * 60 + minute
  if (mins >= 9 * 60 && mins <= 15 * 60 + 30) return 'REGULAR'
  if (mins < 9 * 60) return 'PRE'
  return 'POST'
}

function usMarketStateGuess(): string {
  const { weekday, hour, minute } = getNewYorkClock()
  if (weekday === 'Sat' || weekday === 'Sun') return 'CLOSED'
  const mins = hour * 60 + minute
  if (mins >= 9 * 60 + 30 && mins <= 16 * 60) return 'REGULAR'
  if (mins < 9 * 60 + 30) return 'PRE'
  return 'POST'
}

/** 국내주식 주식현재가 시세 output */
async function fetchKisDomesticInquirePriceOutput(iscd: string): Promise<Record<string, unknown>> {
  const token = await getKisAccessToken()
  const params = new URLSearchParams({
    FID_COND_MRKT_DIV_CODE: 'J',
    FID_INPUT_ISCD: iscd,
  })
  const response = await fetchKisDataWithRetry(`${KIS_URL_BASE}/uapi/domestic-stock/v1/quotations/inquire-price?${params.toString()}`, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${token}`,
      appkey: KIS_APP_KEY || '',
      appsecret: KIS_APP_SECRET || '',
      tr_id: 'FHKST01010100',
      custtype: 'P',
    },
    signal: AbortSignal.timeout(KIS_TIMEOUT_MS),
  }, 'KIS inquire-price')
  const payload = (await response.json()) as { rt_cd?: string; msg1?: string; output?: Record<string, unknown> }
  if (payload.rt_cd !== '0' || !payload.output || typeof payload.output !== 'object') {
    throw new Error(`KIS inquire-price: ${payload.msg1 ?? 'unknown'}`)
  }
  return payload.output
}

/** 국내 호가(최우선 매도·매수) — 실패 시 null */
async function fetchKisDomesticAskingOutput1(iscd: string): Promise<Record<string, unknown> | null> {
  try {
    const token = await getKisAccessToken()
    const params = new URLSearchParams({
      FID_COND_MRKT_DIV_CODE: 'J',
      FID_INPUT_ISCD: iscd,
    })
    const response = await fetchKisDataWithRetry(
      `${KIS_URL_BASE}/uapi/domestic-stock/v1/quotations/inquire-asking-price-exp-ccn?${params.toString()}`,
      {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          authorization: `Bearer ${token}`,
          appkey: KIS_APP_KEY || '',
          appsecret: KIS_APP_SECRET || '',
          tr_id: 'FHKST01010200',
          custtype: 'P',
        },
        signal: AbortSignal.timeout(KIS_TIMEOUT_MS),
      },
      'KIS inquire-asking-price',
    )
    const payload = (await response.json()) as { rt_cd?: string; output1?: Record<string, unknown> }
    if (payload.rt_cd !== '0' || !payload.output1 || typeof payload.output1 !== 'object') return null
    return payload.output1
  } catch (err) {
    console.warn('[KIS] inquire-asking-price failed', err)
    return null
  }
}

function signedKisPrdyVrss(o: Record<string, unknown>): number | null {
  const raw = kisStrNum(o.prdy_vrss)
  if (raw == null) return null
  const sign = String(o.prdy_vrss_sign ?? '').trim()
  if (sign === '5' || sign === '4') return -Math.abs(raw)
  if (sign === '2' || sign === '1') return Math.abs(raw)
  return raw
}

async function fetchKisDomesticTimeItemchartpriceRows(
  iscd: string,
  fidInputHour1: string,
): Promise<Array<Record<string, unknown>>> {
  const token = await getKisAccessToken()
  const params = new URLSearchParams({
    FID_COND_MRKT_DIV_CODE: 'J',
    FID_INPUT_ISCD: iscd,
    FID_INPUT_HOUR_1: fidInputHour1,
    FID_PW_DATA_INCU_YN: 'Y',
    FID_ETC_CLS_CODE: '',
  })
  const response = await fetchKisDataWithRetry(
    `${KIS_URL_BASE}/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice?${params.toString()}`,
    {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        authorization: `Bearer ${token}`,
        appkey: KIS_APP_KEY || '',
        appsecret: KIS_APP_SECRET || '',
        tr_id: 'FHKST03010200',
        custtype: 'P',
      },
      signal: AbortSignal.timeout(KIS_TIMEOUT_MS),
    },
    'KIS inquire-time-itemchartprice',
  )
  const payload = (await response.json()) as { rt_cd?: string; msg1?: string; output2?: unknown }
  if (payload.rt_cd !== '0' || !Array.isArray(payload.output2)) {
    throw new Error(`KIS time-itemchartprice: ${payload.msg1 ?? 'unknown'}`)
  }
  return payload.output2.filter((r): r is Record<string, unknown> => r != null && typeof r === 'object')
}

/** 당일 분봉(최대 30건×반복) — KIS 당일분봉 API 규격 */
async function fetchKisDomesticIntradayPoints(iscd: string): Promise<{ points: Array<{ t: string; c: number }>; sessionDate: string | null }> {
  const merged = new Map<string, number>()
  let hourCursor = seoulHHMMSS(new Date())
  let prevEarliest: string | null = null
  for (let page = 0; page < 48; page += 1) {
    const rows = await fetchKisDomesticTimeItemchartpriceRows(iscd, hourCursor)
    if (!rows.length) break
    const times: string[] = []
    for (const row of rows) {
      const dateCompact = String(row.stck_bsop_date ?? '').replace(/\D/g, '')
      const hhmmss = String(row.stck_cntg_hour ?? '')
        .replace(/\D/g, '')
        .padStart(6, '0')
      if (dateCompact.length !== 8) continue
      const close = kisStrNum(row.stck_prpr)
      if (close == null) continue
      const iso = `${dateCompact.slice(0, 4)}-${dateCompact.slice(4, 6)}-${dateCompact.slice(6, 8)}T${hhmmss.slice(0, 2)}:${hhmmss.slice(2, 4)}:${hhmmss.slice(4, 6)}+09:00`
      merged.set(iso, close)
      times.push(hhmmss)
    }
    if (!times.length) break
    const earliest = times.reduce((a, b) => (a < b ? a : b))
    if (earliest === prevEarliest) break
    prevEarliest = earliest
    const nextCursor = hhmmssMinusOneMinute(earliest)
    if (nextCursor === hourCursor) break
    hourCursor = nextCursor
    if (earliest <= '090100') break
    await sleep(Math.max(80, Math.floor(KIS_DATA_MIN_INTERVAL_MS / 2)))
  }
  const points = [...merged.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([t, c]) => ({ t, c }))
  const sessionDate = points.length > 0 ? points[points.length - 1].t.slice(0, 10) : null
  return { points, sessionDate }
}

async function fetchKisOverseasPriceOutput(
  excd: string,
  symb: string,
): Promise<Record<string, unknown> | null> {
  const token = await getKisAccessToken()
  const params = new URLSearchParams({ AUTH: '', EXCD: excd, SYMB: symb })
  const response = await fetchKisDataWithRetry(`${KIS_URL_BASE}/uapi/overseas-price/v1/quotations/price?${params.toString()}`, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${token}`,
      appkey: KIS_APP_KEY || '',
      appsecret: KIS_APP_SECRET || '',
      tr_id: 'HHDFS00000300',
      custtype: 'P',
    },
    signal: AbortSignal.timeout(KIS_TIMEOUT_MS),
  }, 'KIS overseas-price')
  const payload = (await response.json()) as { rt_cd?: string; output?: Record<string, unknown> }
  if (payload.rt_cd !== '0' || !payload.output || typeof payload.output !== 'object') return null
  return payload.output
}

function pickOverseasNum(o: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const n = kisStrNum(o[k])
    if (n != null) return n
  }
  return null
}

async function buildKisLiveQuoteDomestic(tickerKey: string, iscd: string): Promise<Record<string, unknown>> {
  const [o, ask1] = await Promise.all([
    fetchKisDomesticInquirePriceOutput(iscd),
    fetchKisDomesticAskingOutput1(iscd),
  ])
  const name =
    typeof o.hts_kor_isnm === 'string'
      ? o.hts_kor_isnm
      : typeof o.bstp_kor_isnm === 'string'
        ? o.bstp_kor_isnm
        : null
  let bid: number | null = null
  let ask: number | null = null
  let bidSize: number | null = null
  let askSize: number | null = null
  if (ask1) {
    bid = kisStrNum(ask1.bidp1)
    ask = kisStrNum(ask1.askp1)
    bidSize = kisStrNum(ask1.bidp_rsqn1)
    askSize = kisStrNum(ask1.askp_rsqn1)
    if (bid === 0) bid = null
    if (ask === 0) ask = null
    if (bidSize === 0) bidSize = null
    if (askSize === 0) askSize = null
  }
  return {
    symbol: tickerKey,
    shortName: name,
    longName: name,
    fullExchangeName: typeof o.rprs_mrkt_kor_name === 'string' ? o.rprs_mrkt_kor_name : 'KRX',
    exchangeTimezoneName: 'Asia/Seoul',
    currency: 'KRW',
    marketState: krxMarketStateGuess(),
    regularMarketPrice: kisStrNum(o.stck_prpr),
    regularMarketChange: signedKisPrdyVrss(o),
    regularMarketChangePercent: kisStrNum(o.prdy_ctrt),
    regularMarketPreviousClose: kisStrNum(o.stck_sdpr),
    regularMarketOpen: kisStrNum(o.stck_oprc),
    regularMarketDayHigh: kisStrNum(o.stck_hgpr),
    regularMarketDayLow: kisStrNum(o.stck_lwpr),
    regularMarketVolume: kisStrNum(o.acml_vol),
    bid,
    ask,
    bidSize,
    askSize,
    asOf: new Date().toISOString(),
    dataSource: 'kis',
  }
}

/** 미국 등 해외 상장(심볼만) — 거래소 코드 순으로 조회 */
async function buildKisLiveQuoteOverseas(tickerKey: string, symb: string): Promise<Record<string, unknown> | null> {
  const US_EX = ['NASD', 'NYSE', 'AMEX'] as const
  for (const excd of US_EX) {
    const o = await fetchKisOverseasPriceOutput(excd, symb)
    if (!o) continue
    const last = pickOverseasNum(o, ['last', 'ovrs_nmix_prpr', 'stck_prpr'])
    if (last == null) continue
    const base = pickOverseasNum(o, ['base', 'pddy_clpr_prpr', 'ovrs_nmix_prdy_clpr', 'prdy_clpr'])
    const chg =
      pickOverseasNum(o, ['diff', 'prdy_vrss', 'ovrs_nmix_prdy_vrss']) ?? (base != null ? last - base : null)
    const chgPct = pickOverseasNum(o, ['tday_risefall_rate', 'prdy_ctrt', 'ovrs_exhg_chg_rt'])
    const nm =
      typeof o.ovrs_excg_name === 'string'
        ? o.ovrs_excg_name
        : typeof o.hts_kor_isnm === 'string'
          ? o.hts_kor_isnm
          : typeof o.stck_name === 'string'
            ? o.stck_name
            : null
    return {
      symbol: tickerKey,
      shortName: nm,
      longName: nm,
      fullExchangeName: excd,
      exchangeTimezoneName: 'America/New_York',
      currency: 'USD',
      marketState: usMarketStateGuess(),
      regularMarketPrice: last,
      regularMarketChange: chg,
      regularMarketChangePercent: chgPct,
      regularMarketPreviousClose: base,
      regularMarketOpen: pickOverseasNum(o, ['open', 'ovrs_nmix_oprc']),
      regularMarketDayHigh: pickOverseasNum(o, ['high', 'ovrs_nmix_hgpr']),
      regularMarketDayLow: pickOverseasNum(o, ['low', 'ovrs_nmix_lwpr']),
      regularMarketVolume: pickOverseasNum(o, ['tvol', 'acml_vol', 'cntg_vol']),
      bid: pickOverseasNum(o, ['bidp', 'bid', 'ovrs_nmix_bidp']),
      ask: pickOverseasNum(o, ['askp', 'ask', 'ovrs_nmix_askp']),
      bidSize: pickOverseasNum(o, ['bidp_rsqn', 'bidp_rsqn1']),
      askSize: pickOverseasNum(o, ['askp_rsqn', 'askp_rsqn1']),
      asOf: new Date().toISOString(),
      dataSource: 'kis',
    }
  }
  return null
}

/** KOSPI·KOSPI 200 등 — `koreaSymbols`에 올라 있는 ^KS… 지수만 */
async function buildYahooLiveQuoteKrIndex(tickerKey: string): Promise<Record<string, unknown>> {
  const raw = await yahooFinance.quote(tickerKey)
  const row = (Array.isArray(raw) ? raw[0] : raw) as {
    symbol?: string
    shortName?: string | null
    longName?: string | null
    fullExchangeName?: string | null
    exchangeTimezoneName?: string | null
    currency?: string | null
    marketState?: string | null
    regularMarketPrice?: number | null
    regularMarketChange?: number | null
    regularMarketChangePercent?: number | null
    regularMarketPreviousClose?: number | null
    regularMarketOpen?: number | null
    regularMarketDayHigh?: number | null
    regularMarketDayLow?: number | null
    regularMarketVolume?: number | null
  } | undefined
  if (!row || row.regularMarketPrice == null || !Number.isFinite(Number(row.regularMarketPrice))) {
    throw new Error(`Yahoo 지수 시세 없음: ${tickerKey}`)
  }
  return {
    symbol: tickerKey,
    shortName: row.shortName ?? row.longName ?? tickerKey,
    longName: row.longName ?? row.shortName ?? tickerKey,
    fullExchangeName: row.fullExchangeName ?? 'KRX',
    exchangeTimezoneName: row.exchangeTimezoneName ?? 'Asia/Seoul',
    currency: row.currency ?? 'KRW',
    marketState: row.marketState ?? null,
    regularMarketPrice: row.regularMarketPrice ?? null,
    regularMarketChange: row.regularMarketChange ?? null,
    regularMarketChangePercent: row.regularMarketChangePercent ?? null,
    regularMarketPreviousClose: row.regularMarketPreviousClose ?? null,
    regularMarketOpen: row.regularMarketOpen ?? null,
    regularMarketDayHigh: row.regularMarketDayHigh ?? null,
    regularMarketDayLow: row.regularMarketDayLow ?? null,
    regularMarketVolume: row.regularMarketVolume ?? null,
    bid: null,
    ask: null,
    bidSize: null,
    askSize: null,
    asOf: new Date().toISOString(),
    dataSource: 'yahoo',
  }
}

/** KIS 해외 시세 실패 시에만 사용 — 기존 KIS 조회 로직은 변경하지 않음 */
async function buildYahooLiveQuoteOverseasFallback(tickerKey: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await yahooFinance.quote(tickerKey)
    const row = (Array.isArray(raw) ? raw[0] : raw) as {
      shortName?: string | null
      longName?: string | null
      fullExchangeName?: string | null
      exchangeTimezoneName?: string | null
      currency?: string | null
      marketState?: string | null
      regularMarketPrice?: number | null
      regularMarketChange?: number | null
      regularMarketChangePercent?: number | null
      regularMarketPreviousClose?: number | null
      regularMarketOpen?: number | null
      regularMarketDayHigh?: number | null
      regularMarketDayLow?: number | null
      regularMarketVolume?: number | null
      bid?: number | null
      ask?: number | null
      bidSize?: number | null
      askSize?: number | null
    } | undefined
    if (!row || row.regularMarketPrice == null || !Number.isFinite(Number(row.regularMarketPrice))) return null
    const n = (v: unknown): number | null => {
      if (v == null) return null
      const x = typeof v === 'number' ? v : Number(v)
      return Number.isFinite(x) ? x : null
    }
    return {
      symbol: tickerKey,
      shortName: row.shortName ?? row.longName ?? tickerKey,
      longName: row.longName ?? row.shortName ?? tickerKey,
      fullExchangeName: row.fullExchangeName ?? null,
      exchangeTimezoneName: row.exchangeTimezoneName ?? 'America/New_York',
      currency: row.currency ?? 'USD',
      marketState: row.marketState ?? null,
      regularMarketPrice: row.regularMarketPrice ?? null,
      regularMarketChange: row.regularMarketChange ?? null,
      regularMarketChangePercent: row.regularMarketChangePercent ?? null,
      regularMarketPreviousClose: row.regularMarketPreviousClose ?? null,
      regularMarketOpen: row.regularMarketOpen ?? null,
      regularMarketDayHigh: row.regularMarketDayHigh ?? null,
      regularMarketDayLow: row.regularMarketDayLow ?? null,
      regularMarketVolume: row.regularMarketVolume ?? null,
      bid: n(row.bid),
      ask: n(row.ask),
      bidSize: n(row.bidSize),
      askSize: n(row.askSize),
      asOf: new Date().toISOString(),
      dataSource: 'yahoo',
    }
  } catch (err) {
    console.warn('[Yahoo] overseas quote fallback failed', tickerKey, err)
    return null
  }
}

/** 미국 티커 당일 1분봉 보조 — KIS REST 미제공 구간용 (기존 국내·KIS 분기는 그대로) */
async function fetchYahooUsIntraday1mForLiveChart(
  symb: string,
  tickerForTz: string,
): Promise<{ points: Array<{ t: string; c: number }>; sessionDate: string | null }> {
  const period2 = new Date()
  const period1 = new Date(period2.getTime() - 3 * 24 * 60 * 60 * 1000)
  const chart = await yahooFinance.chart(symb, {
    period1,
    period2,
    interval: '1m',
  })
  const rows =
    chart.quotes
      ?.filter((q) => q.date != null && q.close != null && Number.isFinite(Number(q.close)))
      .map((q) => ({ date: q.date as Date, close: Number(q.close) }))
      .sort((a, b) => a.date.getTime() - b.date.getTime()) ?? []
  if (!rows.length) return { points: [], sessionDate: null }
  const tz = chartMarketTimezone(tickerForTz)
  let session = filterIntradayQuotesToLastSession(rows, tickerForTz)
  const useRows = session.length > 0 ? session : rows
  const points = useRows.map((r) => ({ t: r.date.toISOString(), c: r.close }))
  const sessionDate =
    points.length > 0 ? ymdInTimeZoneLabel(new Date(points[points.length - 1].t), tz) : null
  return { points, sessionDate }
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
  const source = market === 'kr' ? koreaSymbols : getUsSymbolsSnapshot()
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
  const uniqueTitles = Array.from(new Set(items.map((item) => item.title).filter((title) => title.length > 0)))
  const missingTitles: string[] = []
  for (const title of uniqueTitles) {
    const cached = sentimentCache.get(title)
    if (cached && now - cached.analyzedAt < SENTIMENT_CACHE_TTL_MS) {
      result.set(title, cached)
    } else {
      missingTitles.push(title)
    }
  }
  if (missingTitles.length > 0) {
    const redisLoaded = await Promise.all(
      missingTitles.map(async (title) => {
        const redisCached = await getRedisJson<SentimentCacheValue>(`sentiment:${encodeURIComponent(title)}`)
        return { title, redisCached }
      }),
    )
    for (const { title, redisCached } of redisLoaded) {
      if (redisCached && now - redisCached.analyzedAt < SENTIMENT_CACHE_TTL_MS) {
        sentimentCache.set(title, redisCached)
        result.set(title, redisCached)
      }
    }
  }

  const uncachedTitles = uniqueTitles.filter((title) => !result.has(title))
  if (uncachedTitles.length === 0) return result
  if (now < sentimentApiBackoffUntil) return result

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
    const redisWrites: Promise<void>[] = []
    for (const d of parsed.data ?? []) {
      const normalized: SentimentCacheValue = {
        label: toKoreanSentimentLabel(d.label),
        score: Number.isFinite(d.score) ? Math.max(-100, Math.min(100, Math.round(d.score))) : 0,
        analyzedAt: now,
      }
      sentimentCache.set(d.title, normalized)
      result.set(d.title, normalized)
      redisWrites.push(setRedisJson(`sentiment:${encodeURIComponent(d.title)}`, normalized, SENTIMENT_REDIS_TTL_SECONDS))
    }
    if (redisWrites.length > 0) {
      await Promise.all(redisWrites)
    }
    sentimentApiBackoffUntil = 0
  } catch (err) {
    console.error('FinBERT 연동 실패, 점수 fallback 사용', err)
    sentimentApiBackoffUntil = Date.now() + SENTIMENT_API_RETRY_COOLDOWN_MS
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

/** 종목 검색: 티커·영문명(대소문자 무시)·한글 통용명(nameKr 또는 한글 name) 부분 일치 */
function symbolItemMatchesQuery(item: SymbolItem, queryRaw: string): boolean {
  const q = queryRaw.trim()
  if (!q) return true
  const qLower = q.toLowerCase()
  const qUpper = q.toUpperCase()
  if (item.symbol.toUpperCase().includes(qUpper)) return true
  if (item.name.toLowerCase().includes(qLower)) return true
  if (item.nameKr && item.nameKr.includes(q)) return true

  /**
   * 검색 보정:
   * - 공백/특수문자 차이 무시 (예: "tiger200 인버스x2")
   * - 레버리지/인버스 접미의 2X/X2 순서 차이 허용
   */
  const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9가-힣]/g, '')
  const qCompact = compact(q)
  if (!qCompact) return true
  const namesCompact = [item.symbol, item.name, item.nameKr ?? ''].map(compact)
  if (namesCompact.some((v) => v.includes(qCompact))) return true
  const qSwap = qCompact.replace(/2x/g, '__x2__').replace(/x2/g, '2x').replace(/__x2__/g, 'x2')
  if (qSwap !== qCompact && namesCompact.some((v) => v.includes(qSwap))) return true
  return false
}

function isKoreanEtfSymbol(item: SymbolItem): boolean {
  const text = `${item.name} ${item.nameKr ?? ''}`.toUpperCase()
  return (
    text.includes('ETF') ||
    text.includes('KODEX') ||
    text.includes('TIGER') ||
    text.includes('ACE ') ||
    text.includes('KOSEF') ||
    text.includes('KBSTAR') ||
    text.includes('ARIRANG') ||
    text.includes('SOL ') ||
    text.includes('TIMEFOLIO') ||
    text.includes('HANARO') ||
    text.includes('RISE ')
  )
}

/** 미국 종목 API용 — 네트워크 대기 없이 즉시 반환(캐시·만료 캐시·fallback) */
function getUsSymbolsSnapshot(): SymbolItem[] {
  if (cachedSp500?.data?.length) return cachedSp500.data
  return fallbackSymbols
}

async function downloadSp500CsvIntoCache(): Promise<void> {
  const now = Date.now()
  try {
    const response = await fetch(S_AND_P_500_CSV_URL)
    if (!response.ok) {
      throw new Error(`S&P500 목록 다운로드 실패: ${response.status}`)
    }
    const csv = await response.text()
    const rows = csv.trim().split('\n').slice(1)
    const parsed = rows
      .map((row) => parseCsvRow(row))
      .map((cells) => {
        const symbol = (cells[0] ?? '').replace(/\./g, '-').toUpperCase()
        const name = cells[1] ?? cells[0] ?? '이름 없음'
        const nameKr = SP500_KR_NAMES[symbol]
        return nameKr ? { symbol, name, nameKr } : { symbol, name }
      })
      .filter((item) => item.symbol.length > 0)
    const unique = Array.from(new Map(parsed.map((item) => [item.symbol, item])).values())
    cachedSp500 = { data: unique, expiresAt: now + SP500_CACHE_TTL_MS }
  } catch (err) {
    console.error('S&P500 목록 로딩 실패. fallback 목록 사용', err)
  }
}

function startOrJoinSp500Refresh(): Promise<void> {
  if (sp500RefreshPromise) return sp500RefreshPromise
  sp500RefreshPromise = (async () => {
    try {
      await downloadSp500CsvIntoCache()
    } finally {
      sp500RefreshPromise = null
    }
  })()
  return sp500RefreshPromise
}

/** TTL 만료 시 백그라운드로 CSV 재수집 — 응답은 스냅샷으로 즉시 */
function scheduleSp500BackgroundRefresh(): void {
  const now = Date.now()
  if (cachedSp500 && cachedSp500.expiresAt > now) return
  void startOrJoinSp500Refresh().catch((e) => console.error('S&P500 background refresh', e))
}

/** 배치·뉴스 등 전체 목록이 필요할 때만 네트워크 완료까지 대기 */
async function getSp500Symbols(): Promise<SymbolItem[]> {
  const now = Date.now()
  if (cachedSp500 && cachedSp500.expiresAt > now) {
    return cachedSp500.data
  }
  await startOrJoinSp500Refresh()
  return cachedSp500?.data?.length ? cachedSp500.data : fallbackSymbols
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

  if (isKoreanSixDigitEquity(ticker) && KIS_APP_KEY && KIS_APP_SECRET) {
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
  if (isKoreanSixDigitEquity(record.ticker) && KIS_APP_KEY && KIS_APP_SECRET) {
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
      '/api/quote/:ticker',
      '/api/quote/:ticker/intraday',
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

app.get('/api/quote/:ticker', async (req: Request, res: Response) => {
  const tickerRaw = normalizeSingle(req.params.ticker)?.trim()
  if (!tickerRaw) {
    return res.status(400).json({ error: '티커(symbol) 값이 필요합니다.' })
  }
  const ticker = tickerRaw
  const key = ticker.toUpperCase()
  const now = Date.now()
  const hit = quoteLiveCache.get(key)
  if (hit && now - hit.cachedAt < QUOTE_LIVE_CACHE_TTL_MS) {
    return res.json(hit.payload)
  }
  const inFlight = quoteInFlight.get(key)
  if (inFlight) {
    try {
      return res.json(await inFlight)
    } catch {
      // fall through and retry once as a fresh request
    }
  }

  const loadPromise: Promise<Record<string, unknown>> = (async () => {
    if (isKoreanYahooIndexTicker(ticker)) {
      try {
        const payload = await buildYahooLiveQuoteKrIndex(key)
        quoteLiveCache.set(key, { payload, cachedAt: Date.now() })
        return payload
      } catch (err) {
        console.error('yahoo kr index quote', err)
        throw { status: 502, message: '지수 시세를 가져오지 못했습니다. 잠시 후 다시 시도해 주세요.' }
      }
    }

    if ((!KIS_APP_KEY || !KIS_APP_SECRET) && /^[A-Z0-9.-]{1,20}$/i.test(ticker) && !isKoreanTicker(ticker)) {
      const yOnly = await buildYahooLiveQuoteOverseasFallback(key)
      if (yOnly) {
        quoteLiveCache.set(key, { payload: yOnly, cachedAt: Date.now() })
        return yOnly
      }
    }
    if (!KIS_APP_KEY || !KIS_APP_SECRET) {
      throw { status: 503, message: '한국투자증권 실시간 시세를 쓰려면 KIS_APP_KEY·KIS_APP_SECRET 환경 변수를 설정하세요.' }
    }

    let payload: Record<string, unknown>
    if (isKoreanSixDigitEquity(ticker)) {
      const iscd = ticker.toUpperCase().split('.')[0]
      payload = await buildKisLiveQuoteDomestic(key, iscd)
    } else if (/^[A-Z0-9.-]{1,20}$/i.test(ticker) && !isKoreanTicker(ticker)) {
      const symb = ticker.toUpperCase()
      let built: Record<string, unknown> | null = await buildKisLiveQuoteOverseas(key, symb)
      if (!built) built = await buildYahooLiveQuoteOverseasFallback(key)
      if (!built) {
        throw { status: 404, message: '해외 종목 시세를 한국투자증권·Yahoo Finance에서 찾지 못했습니다.' }
      }
      payload = built
    } else {
      throw {
        status: 400,
        message: '한국투자증권 시세는 국내 6자리·코스피/코스닥(예: 005930.KS) 또는 미국 티커(예: AAPL)만 지원합니다.',
      }
    }
    quoteLiveCache.set(key, { payload, cachedAt: Date.now() })
    return payload
  })()
  quoteInFlight.set(key, loadPromise)
  try {
    return res.json(await loadPromise)
  } catch (err) {
    console.error(err)
    const status = typeof err === 'object' && err && 'status' in err ? Number((err as { status?: number }).status) : 500
    const message =
      typeof err === 'object' && err && 'message' in err
        ? String((err as { message?: string }).message)
        : '실시간 시세를 가져오지 못했습니다.'
    return res.status(status || 500).json({ error: message })
  } finally {
    quoteInFlight.delete(key)
  }
})

/** 당일 1분봉 — 국내: KIS 당일분봉 반복 조회 / 미국 등 해외: Yahoo 1분봉 보조 */
app.get('/api/quote/:ticker/intraday', async (req: Request, res: Response) => {
  const tickerRaw = normalizeSingle(req.params.ticker)?.trim()
  if (!tickerRaw) {
    return res.status(400).json({ error: '티커(symbol) 값이 필요합니다.' })
  }
  const ticker = tickerRaw
  const key = ticker.toUpperCase()
  const now = Date.now()
  const hit = intradayLiveCache.get(key)
  if (hit && now - hit.cachedAt < INTRADAY_CHART_CACHE_TTL_MS) {
    return res.json(hit.payload)
  }
  const inFlight = intradayInFlight.get(key)
  if (inFlight) {
    try {
      return res.json(await inFlight)
    } catch {
      // fall through and retry once as a fresh request
    }
  }

  const loadPromise: Promise<Record<string, unknown>> = (async () => {
    const tz = chartMarketTimezone(ticker)
    if (isKoreanYahooIndexTicker(ticker)) {
      const payload = {
        symbol: key,
        timezone: tz,
        interval: '1m' as const,
        sessionDate: null as string | null,
        points: [] as Array<{ t: string; c: number }>,
        asOf: new Date().toISOString(),
        dataSource: 'yahoo',
        note: 'KOSPI·KOSPI 200 등 지수의 당일 분봉은 이 API에서 제공되지 않습니다.',
      }
      intradayLiveCache.set(key, { payload, cachedAt: Date.now() })
      return payload
    }
    if (/^[A-Z0-9.-]{1,20}$/i.test(ticker) && !isKoreanTicker(ticker)) {
      let points: Array<{ t: string; c: number }> = []
      let sessionDate: string | null = null
      try {
        const r = await fetchYahooUsIntraday1mForLiveChart(key, ticker)
        points = r.points
        sessionDate = r.sessionDate
      } catch (err) {
        console.warn('[Yahoo] us intraday chart failed', key, err)
      }
      const payload = {
        symbol: key,
        timezone: tz,
        interval: '1m' as const,
        sessionDate,
        points,
        asOf: new Date().toISOString(),
        dataSource: 'yahoo' as const,
        ...(points.length > 0
          ? {
              note: '미국 당일 분봉은 Yahoo Finance 데이터입니다. 한국투자증권·거래소와 시세·시간이 다를 수 있습니다.',
            }
          : {
              note: '미국 등 해외 종목의 당일 분봉은 한국투자증권 REST로는 제공되지 않습니다. 국내 종목은 분봉이 표시됩니다.',
            }),
      }
      intradayLiveCache.set(key, { payload, cachedAt: Date.now() })
      return payload
    }
    if (!KIS_APP_KEY || !KIS_APP_SECRET) {
      throw { status: 503, message: '한국투자증권 분봉을 쓰려면 KIS_APP_KEY·KIS_APP_SECRET 환경 변수를 설정하세요.' }
    }
    if (!isKoreanSixDigitEquity(ticker)) {
      throw { status: 400, message: '분봉은 국내 6자리·코스피/코스닥(예: 005930.KS)만 지원합니다.' }
    }
    const iscd = ticker.toUpperCase().split('.')[0]
    const { points: rawPoints, sessionDate: rawSession } = await fetchKisDomesticIntradayPoints(iscd)
    const withDates = rawPoints.map((p) => ({ date: new Date(p.t), close: p.c }))
    const session = filterIntradayQuotesToLastSession(withDates, ticker)
    const points = session.map((row) => ({ t: row.date.toISOString(), c: row.close }))
    const sessionDate = points.length > 0 ? ymdInTimeZoneLabel(new Date(points[points.length - 1].t), tz) : rawSession
    const payload = {
      symbol: key,
      timezone: tz,
      interval: '1m' as const,
      sessionDate,
      points,
      asOf: new Date().toISOString(),
      dataSource: 'kis',
    }
    intradayLiveCache.set(key, { payload, cachedAt: Date.now() })
    return payload
  })()
  intradayInFlight.set(key, loadPromise)
  try {
    return res.json(await loadPromise)
  } catch (err) {
    console.error('intraday chart', err)
    const status = typeof err === 'object' && err && 'status' in err ? Number((err as { status?: number }).status) : 500
    const message =
      typeof err === 'object' && err && 'message' in err
        ? String((err as { message?: string }).message)
        : '분봉 차트 데이터를 가져오지 못했습니다.'
    return res.status(status || 500).json({ error: message })
  } finally {
    intradayInFlight.delete(key)
  }
})

app.get('/api/stock/:ticker', async (req: Request, res: Response) => {
  const ticker = normalizeSingle(req.params.ticker)?.toUpperCase()
  if (!ticker) {
    return res.status(400).json({ error: '티커(symbol) 값이 필요합니다.' })
  }
  const timeframe = (normalizeSingle(req.query.timeframe as string | string[] | undefined) ?? 'month').toLowerCase()
  const tz = chartMarketTimezone(ticker)
  const todayYmd = ymdInTimeZoneLabel(new Date(), tz)
  const ty = Number(todayYmd.slice(0, 4))
  const tm = Number(todayYmd.slice(5, 7))

  const calYearRaw = normalizeSingle(req.query.calYear as string | string[] | undefined)
  const calMonthRaw = normalizeSingle(req.query.calMonth as string | string[] | undefined)
  const calDateRaw = normalizeSingle(req.query.calDate as string | string[] | undefined)

  let calYear = calYearRaw != null && calYearRaw !== '' ? Number(calYearRaw) : ty
  if (!Number.isFinite(calYear)) calYear = ty
  let calMonth = calMonthRaw != null && calMonthRaw !== '' ? Number(calMonthRaw) : tm
  if (!Number.isFinite(calMonth) || calMonth < 1 || calMonth > 12) calMonth = tm

  let calDate =
    calDateRaw && /^\d{4}-\d{2}-\d{2}$/.test(calDateRaw) ? calDateRaw : todayYmd
  if (calDate > todayYmd) calDate = todayYmd

  type StockInterval = '1d' | '5m'
  let interval: StockInterval = '1d'
  let period1: Date
  let period2: Date
  let kisFrom: string | null = null
  let kisTo: string | null = null

  if (timeframe === 'year') {
    interval = '1d'
    kisFrom = `${CHART_ANCHOR_YEAR_MIN}-01-01`
    kisTo = todayYmd
    period1 = new Date(`${kisFrom}T00:00:00.000Z`)
    period2 = new Date()
  } else if (timeframe === 'month') {
    interval = '1d'
    const yM = Math.min(Math.max(calYear, CHART_ANCHOR_YEAR_MIN), ty)
    const endYm = yM < ty ? `${yM}-12-31` : todayYmd
    kisFrom = `${yM}-01-01`
    kisTo = endYm
    period1 = new Date(`${kisFrom}T00:00:00.000Z`)
    period2 = new Date(`${kisTo}T23:59:59.999Z`)
  } else if (timeframe === 'day') {
    interval = '1d'
    let yD = Math.min(Math.max(calYear, CHART_ANCHOR_YEAR_MIN), ty)
    let mD = Math.min(Math.max(calMonth, 1), 12)
    if (yD === ty && mD > tm) {
      mD = tm
    }
    const ld = new Date(yD, mD, 0).getDate()
    const startM = `${yD}-${padChart2(mD)}-01`
    const endMRaw = `${yD}-${padChart2(mD)}-${padChart2(ld)}`
    let endM = endMRaw
    if (yD === ty && mD === tm) {
      endM = todayYmd < endMRaw ? todayYmd : endMRaw
    }
    kisFrom = startM
    kisTo = endM
    period1 = new Date(`${kisFrom}T00:00:00.000Z`)
    period2 = new Date(`${kisTo}T23:59:59.999Z`)
  } else if (timeframe === 'hour') {
    interval = '5m'
    kisFrom = null
    kisTo = null
    const base = new Date(`${calDate}T12:00:00.000Z`)
    period1 = new Date(base.getTime() - 2 * 24 * 60 * 60 * 1000)
    period2 = new Date(base.getTime() + 2 * 24 * 60 * 60 * 1000)
  } else {
    interval = '1d'
    const yM = Math.min(Math.max(calYear, CHART_ANCHOR_YEAR_MIN), ty)
    kisFrom = `${yM}-01-01`
    kisTo = todayYmd
    period1 = new Date(`${kisFrom}T00:00:00.000Z`)
    period2 = new Date(`${kisTo}T23:59:59.999Z`)
  }

  const stockCacheKey = `${ticker}:${timeframe}:y${calYear}:m${calMonth}:d${calDate}:${interval}:ohlc-v5`
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
    let result: Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }> = []

    if (interval === '1d' && kisFrom && kisTo && isKoreanSixDigitEquity(ticker) && KIS_APP_KEY && KIS_APP_SECRET) {
      try {
        const kisData = await fetchKisDailyCloses(ticker, kisFrom, kisTo)
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
      const candles = await yahooFinance.chart(ticker, {
        period1,
        period2,
        interval,
      })

      result =
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
              volume: q.volume ?? 0,
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

    if (timeframe === 'hour' && result.length > 0) {
      const dH = calDate
      result = result.filter((q) => ymdInTimeZoneLabel(new Date(q.date), tz) === dH)
      const isKrSession = chartMarketTimezone(ticker) === 'Asia/Seoul'
      const openMin = isKrSession ? 9 * 60 : 9 * 60 + 30
      const closeMin = isKrSession ? 15 * 60 + 30 : 16 * 60
      result = result.filter((q) => {
        const mins = minutesSinceMidnightInTz(q.date, tz)
        return mins >= openMin && mins <= closeMin
      })
      result.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
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
    const query = (req.query.q as string | undefined)?.trim() ?? ''
    const limitRaw = Number(req.query.limit ?? 40)
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 40
    scheduleSp500BackgroundRefresh()
    const symbols = getUsSymbolsSnapshot()
    const filtered = symbols.filter((item) => symbolItemMatchesQuery(item, query))
    return res.json({ total: filtered.length, items: filtered.slice(0, limit) })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'S&P500 종목 목록을 가져오지 못했습니다.' })
  }
})

app.get('/api/symbols/kr-etf', (req: Request, res: Response) => {
  try {
    const query = (normalizeSingle(req.query.q as string | string[] | undefined) ?? '').trim()
    const limitRaw = Number(req.query.limit ?? 500)
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 2000) : 500
    const source = Array.from(new Map(koreaSymbols.map((item) => [item.symbol, item])).values())
    const filtered = source.filter((item) => isKoreanEtfSymbol(item) && symbolItemMatchesQuery(item, query))
    return res.json({ market: 'kr', total: filtered.length, items: filtered.slice(0, limit) })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: '국내 ETF 목록을 가져오지 못했습니다.' })
  }
})

app.get('/api/symbols', async (req: Request, res: Response) => {
  try {
    const market = (normalizeSingle(req.query.market as string | string[] | undefined) ?? 'us').toLowerCase()
    const query = (normalizeSingle(req.query.q as string | string[] | undefined) ?? '').trim()
    const limitRaw = Number(req.query.limit ?? 40)
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 40

    if (market !== 'kr') {
      scheduleSp500BackgroundRefresh()
    }
    const source = market === 'kr' ? koreaSymbols : getUsSymbolsSnapshot()
    const filtered = source.filter((item) => symbolItemMatchesQuery(item, query))

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
    const settled = await Promise.allSettled(
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
    const summary = settled
      .filter(
        (row): row is PromiseFulfilledResult<{ strategy: StrategyMode; metrics: BacktestResult['metrics']; latestSignal: BacktestResult['latestSignal'] }> =>
          row.status === 'fulfilled',
      )
      .map((row) => row.value)
    for (const row of settled) {
      if (row.status === 'rejected') {
        console.warn(`[backtest summary] strategy failed for ${ticker}`, row.reason)
      }
    }
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
      sync: {
        mode: 'disabled',
        checkedPending: 0,
        resolvedNow: 0,
        syncedAt: new Date().toISOString(),
      },
      warning: 'Firestore 미설정으로 예측 이력이 비어 있습니다.',
      detail: firestoreDisabledReason ?? 'FIREBASE_SERVICE_ACCOUNT_JSON 또는 GOOGLE_CLOUD_PROJECT 설정을 확인하세요.',
    })
  }
  try {
    const docRef = db.collection('predictions_v2').doc(ticker)
    const doc = await docRef.get()
    if (!doc.exists) {
      return res.json({
        ticker,
        items: [],
        sync: {
          mode: 'api',
          checkedPending: 0,
          resolvedNow: 0,
          syncedAt: new Date().toISOString(),
        },
      })
    }

    const data = doc.data() as Record<string, unknown>
    const candidateDates = Object.keys(data)
      .filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k))
      .sort((a, b) => b.localeCompare(a))
      .slice(0, Math.max(limit, 40))
    const updates: Record<string, unknown> = {}
    let hasOutcomeUpdate = false
    let checkedPending = 0
    let resolvedNow = 0
    for (const date of candidateDates) {
      const record = data[date]
      if (!record || typeof record !== 'object') continue
      const row = record as PredictionRecord
      if (row.outcomeStatus !== 'pending') continue
      checkedPending += 1
      const outcome = await resolveOutcomeForPrediction(row)
      if (!outcome) continue

      updates[`${date}.outcomeStatus`] = 'resolved'
      updates[`${date}.actualDate`] = outcome.actualDate
      updates[`${date}.actualDirection`] = outcome.actualDirection
      updates[`${date}.actualClose`] = outcome.actualClose
      updates[`${date}.isCorrect`] = outcome.isCorrect
      updates[`${date}.resolvedAt`] = admin.firestore.FieldValue.serverTimestamp()
      hasOutcomeUpdate = true
      resolvedNow += 1

      data[date] = {
        ...(data[date] as Record<string, unknown>),
        outcomeStatus: 'resolved',
        actualDate: outcome.actualDate,
        actualDirection: outcome.actualDirection,
        actualClose: outcome.actualClose,
        isCorrect: outcome.isCorrect,
      }
    }
    if (hasOutcomeUpdate) {
      await docRef.update(updates)
    }

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
    return res.json({
      ticker,
      items: withDelta.slice().reverse(),
      sync: {
        mode: 'api',
        checkedPending,
        resolvedNow,
        syncedAt: new Date().toISOString(),
      },
    })
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

app.get('/api/trading/status', async (_req: Request, res: Response) => {
  try {
    const balance = await fetchKisBalance()
    return res.json({
      config: autoTradingConfig,
      dryRun: AUTO_TRADING_DRY_RUN,
      enabled: AUTO_TRADING_ENABLED,
      balance,
      logs: autoTradeLogs.slice(0, 50),
    })
  } catch (err) {
    console.error('[Trading] status', err)
    return res.status(500).json({ error: '계좌 정보를 가져오지 못했습니다.' })
  }
})

app.get('/api/trading/logs', (_req: Request, res: Response) => {
  return res.json({ logs: autoTradeLogs.slice(0, 100) })
})

app.post('/api/trading/config', async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as Partial<AutoTradingConfig>
    autoTradingConfig = {
      ...autoTradingConfig,
      ...body,
      threshold: Math.max(50, Math.min(99, Number(body.threshold ?? autoTradingConfig.threshold))),
      tradeAmount: Math.max(1, Number(body.tradeAmount ?? autoTradingConfig.tradeAmount)),
    }
    const db = getFirestore()
    if (db) {
      await db.collection('system_config').doc('auto_trading').set(autoTradingConfig, { merge: true })
    }
    return res.json({ ok: true, config: autoTradingConfig, dryRun: AUTO_TRADING_DRY_RUN, enabled: AUTO_TRADING_ENABLED })
  } catch (err) {
    console.error('[Trading] config save', err)
    return res.status(500).json({ error: '설정 저장에 실패했습니다.' })
  }
})

app.post('/api/trading/run-now', async (_req: Request, res: Response) => {
  try {
    const clockDate = getSeoulClock().date
    void executeAutoTrading(clockDate, true)
    return res.json({
      ok: true,
      message: '수동 매매 프로세스를 백그라운드에서 시작했습니다. 터미널 로그를 확인하세요.',
    })
  } catch (err) {
    console.error('[Trading] run-now', err)
    return res.status(500).json({ error: '수동 실행 호출 실패' })
  }
})

/** 프로덕션: 같은 오리진에서 프론트(Vite 빌드) + /api 제공. `npm run build` 후 저장소 루트에서 서버 실행 시 `frontend/dist` 사용. */
const frontendDist = process.env.FRONTEND_DIST || path.join(process.cwd(), 'frontend', 'dist')
if (process.env.NODE_ENV === 'production' && fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist))
  // Express 5 / path-to-regexp v8: bare '*' is invalid; use a named catch-all.
  app.get('/{*path}', (req, res, next) => {
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
    void loadAutoTradingConfig()
    scheduleSp500BackgroundRefresh()
    void runStartupDailyCloseCatchUp()
  })
  setInterval(() => {
    void runDailyCloseJob('us', false)
    void runDailyCloseJob('kr', false)
  }, DAILY_CLOSE_SCHEDULER_MS)
  setInterval(() => {
    if (!AUTO_TRADING_ENABLED) return
    const clock = getSeoulClock()
    if (clock.weekday === 'Sat' || clock.weekday === 'Sun') return
    if (clock.hour === AUTO_TRADING_RUN_HOUR_KST && clock.minute === AUTO_TRADING_RUN_MINUTE_KST) {
      if (autoTradingLastRunDate !== clock.date) {
        autoTradingLastRunDate = clock.date
        void executeAutoTrading(clock.date)
      }
    }
  }, AUTO_TRADING_CHECK_MS)
})

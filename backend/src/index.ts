import cors from 'cors'
import dotenv from 'dotenv'
import express, { Request, Response } from 'express'
import Parser from 'rss-parser'
import YahooFinance from 'yahoo-finance2'
import { z } from 'zod'
import OpenAI from 'openai'

dotenv.config()

const app = express()
const port = process.env.PORT || 4000
const predictBase = process.env.PREDICT_URL || 'http://localhost:8001'
const yahooFinance = new YahooFinance()
const openaiApiKey = process.env.OPENAI_API_KEY
const openai = openaiApiKey
  ? new OpenAI({
      apiKey: openaiApiKey,
    })
  : null

app.use(cors())
app.use(express.json())

const CandleSchema = z.object({
  date: z.date(),
  close: z.number(),
})

const rssParser = new Parser()
type SentimentCacheValue = { label: string; score: number; analyzedAt: number }
const sentimentCache = new Map<string, SentimentCacheValue>()
const SENTIMENT_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 7

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

app.get('/', (_req: Request, res: Response) => {
  res.json({
    name: 'AlphaPulse 백엔드',
    endpoints: ['/api/stock/:ticker', '/api/news', '/health'],
  })
})

app.get('/api/stock/:ticker', async (req: Request, res: Response) => {
  const ticker = req.params.ticker?.toUpperCase()
  if (!ticker) {
    return res.status(400).json({ error: '티커(symbol) 값이 필요합니다.' })
  }

  try {
    const end = new Date()
    const start = new Date()
    start.setMonth(end.getMonth() - 1)

    const candles = await yahooFinance.chart(ticker, {
      period1: start,
      period2: end,
      interval: '1d',
    })

    const result =
      candles?.quotes
        ?.filter((q) => q.close != null && q.date != null)
        .map((q) => CandleSchema.parse({ date: q.date, close: q.close }))
        .map((q) => ({ date: q.date.toISOString(), close: q.close })) ?? []

    res.json(result)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '주가 데이터를 가져오지 못했습니다.' })
  }
})

app.get('/api/news', async (_req: Request, res: Response) => {
  try {
    const feed = await rssParser.parseURL(
      'https://news.google.com/rss/search?q=US+stock+market+OR+federal+reserve+OR+interest+rate&hl=en-US&gl=US&ceid=US:en',
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
          response_format: { type: 'json_object' },
        })

        const raw = completion.output[0].content[0]
        if (raw.type === 'output_text') {
          const parsed = JSON.parse(raw.text) as { data?: { title: string; label: string; score: number }[] }
            for (const d of parsed.data ?? []) {
              sentimentCache.set(d.title, { label: d.label, score: d.score, analyzedAt: now })
            }
          }
        }

        const enriched = items.map((item) => {
            const found = cachedMap.get(item.title) ?? sentimentCache.get(item.title)
            return found
              ? { ...item, sentiment: { label: found.label, score: found.score } }
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

app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  })
})

app.get('/api/predict/:ticker', async (req: Request, res: Response) => {
  const ticker = req.params.ticker?.toUpperCase()
  if (!ticker) {
    return res.status(400).json({ error: '티커(symbol) 값이 필요합니다.' })
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
    return res.json(json)
  } catch (err) {
    console.error('Predict proxy failed', err)
    return res.status(502).json({
      error: '예측 서버에 연결할 수 없습니다.',
      detail: 'FastAPI 서버가 http://localhost:8001 에서 실행 중인지 확인하세요.',
    })
  }
})

app.listen(port, () => {
  console.log(`Backend server running on http://localhost:${port}`)
})

import cors from 'cors'
import dotenv from 'dotenv'
import express, { Request, Response } from 'express'
import Parser from 'rss-parser'
import yahooFinance from 'yahoo-finance2'
import { z } from 'zod'
import OpenAI from 'openai'

dotenv.config()

const app = express()
const port = process.env.PORT || 4000
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

app.get('/', (_req: Request, res: Response) => {
  res.json({
    name: 'AlphaPulse backend',
    endpoints: ['/api/stock/:ticker', '/api/news', '/health'],
  })
})

app.get('/api/stock/:ticker', async (req: Request, res: Response) => {
  const ticker = req.params.ticker?.toUpperCase()
  if (!ticker) {
    return res.status(400).json({ error: 'ticker is required' })
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
    res.status(500).json({ error: 'Failed to fetch stock data' })
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
          title: item.title ?? 'Untitled',
          link: item.link,
          source: item.source?.title ?? 'Google News',
        }))
        .filter((i) => i.title) ?? []

    // Optional sentiment enrichment when API key provided
    if (openai) {
      try {
        const prompt = `You are a financial sentiment classifier for stock market impact.
Respond with JSON array. For each title, return an object {title, label, score}.
label is one of Positive, Negative, Neutral. score is integer -100..100.
Titles:
${items.map((i, idx) => `${idx + 1}. ${i.title}`).join('\n')}`

        const completion = await openai.responses.create({
          model: 'gpt-4.1-mini',
          input: prompt,
          response_format: { type: 'json_object' },
        })

        const raw = completion.output[0].content[0]
        if (raw.type === 'output_text') {
          const parsed = JSON.parse(raw.text) as { data?: { title: string; label: string; score: number }[] }
          const map = new Map(parsed.data?.map((d) => [d.title, d]) ?? [])
          const enriched = items.map((item) => {
            const found = map.get(item.title)
            return found
              ? { ...item, sentiment: { label: found.label, score: found.score } }
              : { ...item, sentiment: { label: 'Neutral', score: 0 } }
          })
          return res.json(enriched)
        }
      } catch (err) {
        console.error('OpenAI sentiment error, falling back without sentiment', err)
      }
    }

    res.json(items)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to fetch news feed' })
  }
})

app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  })
})

app.listen(port, () => {
  console.log(`Backend server running on http://localhost:${port}`)
})

import { doc, getDoc } from 'firebase/firestore'
import { db } from './firebase'

/** Client-side read of `predictions_v2` when the API has no Firestore Admin (same DB, rules permitting). */
export type PredictionHistoryItem = {
  ticker: string
  predictionDate: string
  predictedDirection: 'Up' | 'Down'
  probabilityUp: number
  baseClose: number
  probabilityDelta: number | null
  directionChanged: boolean
  actualDirection: 'Up' | 'Down' | null
  actualDate: string | null
  actualClose: number | null
  isCorrect: boolean | null
}

type RawPredictionRow = {
  predictionDate?: string
  predictedDirection?: string
  direction?: string
  probabilityUp?: number
  probability_up?: number
  baseClose?: number
  base_close?: number
  actualDirection?: string | null
  actual_direction?: string | null
  actualDate?: string | null
  actual_date?: string | null
  actualClose?: number | null
  actual_close?: number | null
  isCorrect?: boolean | null
  is_correct?: boolean | null
}

function normalizeDirection(v: unknown): 'Up' | 'Down' | null {
  if (v === 'Up' || v === 'Down') return v
  if (typeof v === 'string') {
    const u = v.trim().toLowerCase()
    if (u === 'up') return 'Up'
    if (u === 'down') return 'Down'
  }
  return null
}

function readProbability(row: RawPredictionRow): number | null {
  if (typeof row.probabilityUp === 'number' && Number.isFinite(row.probabilityUp)) {
    return row.probabilityUp
  }
  if (typeof row.probability_up === 'number' && Number.isFinite(row.probability_up)) {
    return row.probability_up
  }
  return null
}

/** Matches backend `GET /api/predictions/history` sort and delta fields. */
export function buildHistoryItemsFromPredictionsDoc(
  data: Record<string, unknown>,
  ticker: string,
  limit: number,
): PredictionHistoryItem[] {
  const upper = ticker.toUpperCase()
  const records = Object.keys(data)
    .filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k))
    .map((k) => {
      const row = data[k] as RawPredictionRow
      if (row == null || typeof row !== 'object') return null
      const predictionDate =
        typeof row.predictionDate === 'string' ? row.predictionDate : k
      const probabilityUp = readProbability(row)
      if (probabilityUp == null) return null
      const predictedDirection = normalizeDirection(row.predictedDirection ?? row.direction)
      if (!predictedDirection) return null
      let baseClose = 0
      if (typeof row.baseClose === 'number' && Number.isFinite(row.baseClose)) {
        baseClose = row.baseClose
      } else if (typeof row.base_close === 'number' && Number.isFinite(row.base_close)) {
        baseClose = row.base_close
      }
      const actDirRaw = row.actualDirection ?? row.actual_direction
      const actualDirection = normalizeDirection(actDirRaw)
      const actualDate =
        typeof row.actualDate === 'string'
          ? row.actualDate
          : typeof row.actual_date === 'string'
            ? row.actual_date
            : null
      let actualClose: number | null = null
      if (typeof row.actualClose === 'number' && Number.isFinite(row.actualClose)) {
        actualClose = row.actualClose
      } else if (typeof row.actual_close === 'number' && Number.isFinite(row.actual_close)) {
        actualClose = row.actual_close
      }
      let isCorrect: boolean | null = null
      if (typeof row.isCorrect === 'boolean') isCorrect = row.isCorrect
      else if (typeof row.is_correct === 'boolean') isCorrect = row.is_correct
      return {
        ticker: upper,
        predictionDate,
        predictedDirection,
        probabilityUp,
        baseClose,
        actualDirection,
        actualDate,
        actualClose,
        isCorrect,
      }
    })
    .filter((r): r is NonNullable<typeof r> => r != null)

  const sortedDesc = [...records]
    .sort((a, b) => b.predictionDate.localeCompare(a.predictionDate))
    .slice(0, limit)
  const chronological = sortedDesc.slice().reverse()
  const withDelta = chronological.map((item, idx) => {
    const prev = idx > 0 ? chronological[idx - 1] : null
    return {
      ...item,
      probabilityDelta: prev ? Number((item.probabilityUp - prev.probabilityUp).toFixed(4)) : null,
      directionChanged: prev ? item.predictedDirection !== prev.predictedDirection : false,
    }
  })
  return withDelta.slice().reverse()
}

export async function fetchPredictionHistoryFromClientFirestore(
  ticker: string,
  limit: number,
): Promise<{ ticker: string; items: PredictionHistoryItem[] } | null> {
  const upper = ticker.toUpperCase()
  try {
    const ref = doc(db, 'predictions_v2', upper)
    const snap = await getDoc(ref)
    const raw = snap.data()
    if (raw == null) {
      return { ticker: upper, items: [] }
    }
    const items = buildHistoryItemsFromPredictionsDoc(raw as Record<string, unknown>, ticker, limit)
    return { ticker: upper, items }
  } catch (err) {
    console.warn('[predictionHistoryFromFirestore] client read failed', err)
    return null
  }
}

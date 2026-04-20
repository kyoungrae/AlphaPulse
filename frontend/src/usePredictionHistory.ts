import { useEffect, useMemo, useState } from 'react'
import { apiUrl } from './apiBase'
import {
  fetchPredictionHistoryFromClientFirestore,
  type PredictionHistoryItem,
} from './predictionHistoryFromFirestore'

export type PredictionHistoryResponse = {
  ticker: string
  items: PredictionHistoryItem[]
  sync?: {
    mode: 'api' | 'client' | 'disabled'
    checkedPending: number
    resolvedNow: number
    syncedAt: string
  }
  warning?: string
  detail?: string
}

/**
 * Load history with client Firestore first so prediction history works even when backend
 * Firestore Admin is not configured. Fall back to API response when client data is empty or blocked.
 */
export function usePredictionHistory(ticker: string, limit: number) {
  const url = useMemo(() => {
    const t = ticker.trim()
    if (!t) return ''
    return apiUrl(`/api/predictions/history/${encodeURIComponent(t)}?limit=${limit}`)
  }, [ticker, limit])

  const [data, setData] = useState<PredictionHistoryResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!url) {
      setData(null)
      setLoading(false)
      setError(null)
      return
    }

    let mounted = true
    setLoading(true)
    setError(null)
    setData(null)

    ;(async () => {
      const fb = await fetchPredictionHistoryFromClientFirestore(ticker, limit)
      if (!mounted) return
      if (fb && fb.items.length > 0) {
        setData({
          ticker: fb.ticker,
          items: fb.items,
          sync: {
            mode: 'client',
            checkedPending: 0,
            resolvedNow: 0,
            syncedAt: new Date().toISOString(),
          },
        })
        setLoading(false)
        return
      }

      try {
        const res = await fetch(url)
        const bodyText = await res.text()
        if (!res.ok) {
          throw new Error(`요청 실패: ${res.status} ${bodyText}`)
        }
        const ctype = res.headers.get('content-type') ?? ''
        if (!ctype.includes('application/json')) {
          throw new Error(`Non-JSON response: ${bodyText.slice(0, 200)}`)
        }
        if (!bodyText.trim()) {
          throw new Error('Empty response from server.')
        }
        const json = JSON.parse(bodyText) as PredictionHistoryResponse
        if (!mounted) return

        setData(json)
        setLoading(false)
      } catch (e) {
        if (!mounted) return
        if (fb && fb.items.length > 0) {
          setData({
            ticker: fb.ticker,
            items: fb.items,
            sync: {
              mode: 'client',
              checkedPending: 0,
              resolvedNow: 0,
              syncedAt: new Date().toISOString(),
            },
          })
          setLoading(false)
          return
        }
        setError((e as Error).message)
        setLoading(false)
      }
    })()

    return () => {
      mounted = false
    }
  }, [url, ticker, limit])

  return { data, loading, error }
}

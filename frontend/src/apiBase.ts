/** `vite build` 결과물에서만 사용. 개발 서버(`npm run dev`)는 항상 로컬(상대 경로). */
export type ApiMode = 'local' | 'production'

function resolveApiMode(): ApiMode {
  if (import.meta.env.DEV) return 'local'
  const m = import.meta.env.VITE_API_MODE
  return m === 'production' ? 'production' : 'local'
}

/**
 * API 요청 URL.
 * - 개발: 항상 `/api/...` (Vite proxy → localhost:4001).
 * - 프로덕션 빌드 + 로컬 모드: `/api/...` (같은 오리진·역프록시 등).
 * - 프로덕션 빌드 + 운영 모드: `VITE_API_BASE_URL` + `/api/...`.
 */
export function apiUrl(path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`
  if (import.meta.env.DEV) return normalized

  if (resolveApiMode() === 'local') return normalized

  const raw = import.meta.env.VITE_API_BASE_URL
  const base = typeof raw === 'string' ? raw.trim().replace(/\/+$/, '') : ''
  if (!base) {
    console.warn(
      '[AlphaPulse] VITE_API_MODE=production 인데 VITE_API_BASE_URL 이 없습니다. .env 또는 빌드 명령에 API URL을 넣어 주세요.',
    )
    return normalized
  }
  return `${base}${normalized}`
}

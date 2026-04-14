/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * 운영 API 베이스 URL (끝 슬래시 없이). `VITE_API_MODE=production` 일 때만 사용.
   * 예: https://api.example.com
   */
  readonly VITE_API_BASE_URL?: string
  /**
   * 프로덕션 빌드에서만 적용. `local` = 상대 경로 `/api` (기본값), `production` = `VITE_API_BASE_URL` 사용.
   * 개발 서버(`npm run dev`)는 항상 로컬(프록시)이며 이 값과 무관.
   */
  readonly VITE_API_MODE?: 'local' | 'production'
  /** Firebase 웹 앱 설정 (선택). 비우면 `firebase.ts` 기본값 사용. 로컬·운영 동일 프로젝트 유지 시 생략 가능. */
  readonly VITE_FIREBASE_API_KEY?: string
  readonly VITE_FIREBASE_AUTH_DOMAIN?: string
  readonly VITE_FIREBASE_PROJECT_ID?: string
  readonly VITE_FIREBASE_STORAGE_BUCKET?: string
  readonly VITE_FIREBASE_MESSAGING_SENDER_ID?: string
  readonly VITE_FIREBASE_APP_ID?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

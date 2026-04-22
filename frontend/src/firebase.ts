import { getApp, getApps, initializeApp, type FirebaseApp } from 'firebase/app'
import { getAuth } from 'firebase/auth'
import { getFirestore } from 'firebase/firestore'

/**
 * 빈 문자열이면 기본값 사용 (`VITE_FIREBASE_API_KEY=` 만 두면 ?? 로는 못 막아서 auth 설정 깨짐 방지)
 */
function viteFirebaseVar(key: keyof ImportMetaEnv, fallback: string): string {
  const v = import.meta.env[key]
  if (v == null || String(v).trim() === '') return fallback
  return String(v)
}

/**
 * 웹 클라이언트 설정. `VITE_FIREBASE_*` 가 있으면 사용하고, 없으면 아래 기본값(동일 프로젝트).
 * 로컬(`npm run dev`)·운영 빌드 모두 같은 방식으로 초기화되며 `VITE_API_MODE` 와 무관합니다.
 */
const firebaseConfig = {
  apiKey: viteFirebaseVar('VITE_FIREBASE_API_KEY', 'AIzaSyCYIdkp4--T54Ip2HdWRAGg03fK_4UZD-8'),
  authDomain: viteFirebaseVar('VITE_FIREBASE_AUTH_DOMAIN', 'alphapulse-2083b.firebaseapp.com'),
  projectId: viteFirebaseVar('VITE_FIREBASE_PROJECT_ID', 'alphapulse-2083b'),
  storageBucket: viteFirebaseVar(
    'VITE_FIREBASE_STORAGE_BUCKET',
    'alphapulse-2083b.firebasestorage.app',
  ),
  messagingSenderId: viteFirebaseVar('VITE_FIREBASE_MESSAGING_SENDER_ID', '218866825385'),
  appId: viteFirebaseVar('VITE_FIREBASE_APP_ID', '1:218866825385:web:7918799fbea66937c711b8'),
}

function getOrInitApp(): FirebaseApp {
  return getApps().length > 0 ? getApp() : initializeApp(firebaseConfig)
}

export const firebaseApp = getOrInitApp()

/** Firebase Authentication — 이메일·비밀번호 등은 Auth에 저장되며 Firestore와 별도입니다. */
export const auth = getAuth(firebaseApp)

/** Cloud Firestore 클라이언트. 백엔드와 동일 DB — 콘솔 보안 규칙이 허용한 범위에서만 읽기/쓰기 가능. */
export const db = getFirestore(firebaseApp)

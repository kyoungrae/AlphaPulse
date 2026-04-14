import { initializeApp } from 'firebase/app'
import { getFirestore } from 'firebase/firestore'

const firebaseConfig = {
  apiKey: 'AIzaSyCYIdkp4--T54Ip2HdWRAGg03fK_4UZD-8',
  authDomain: 'alphapulse-2083b.firebaseapp.com',
  projectId: 'alphapulse-2083b',
  storageBucket: 'alphapulse-2083b.firebasestorage.app',
  messagingSenderId: '218866825385',
  appId: '1:218866825385:web:7918799fbea66937c711b8',
}

export const firebaseApp = initializeApp(firebaseConfig)

/** Cloud Firestore 클라이언트 (백엔드 `predictions_v2` 등과 동일 DB). 브라우저에서 직접 읽기/쓰기 시 콘솔 Firestore 보안 규칙이 허용해야 합니다. */
export const db = getFirestore(firebaseApp)

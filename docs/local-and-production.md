# 로컬 / 운영 모드 (프론트 API 연결)

## 한 줄 요약

| 하고 싶은 것 | 설정 |
|-------------|------|
| **로컬에서 개발** (`npm run dev`) | 설정 없음. 백엔드는 `http://localhost:4000` 이 떠 있으면 됨. |
| **배포용 빌드 — 아직 운영 API 없음** | `frontend` 폴더에 `VITE_API_MODE=local` (또는 생략, 기본이 local) |
| **배포용 빌드 — 운영 API 쓸 때** | `VITE_API_MODE=production` + `VITE_API_BASE_URL=백엔드 URL` |

---

## 어디에 무엇을 넣나

1. **파일 위치 (선택)**  
   `frontend/.env` 또는 `frontend/.env.production`  
   (저장소에 올리지 말 것 — `.gitignore`에 `.env` 포함 권장)

2. **넣을 값**

   **로컬 모드 (배포 빌드)**  
   - `VITE_API_MODE=local`  
   - `VITE_API_BASE_URL` 은 비워 두거나 안 쓰면 됨.  
   - 브라우저는 같은 사이트 기준으로 `/api/...` 만 호출합니다.

   **운영 모드 (배포 빌드)**  
   - `VITE_API_MODE=production`  
   - `VITE_API_BASE_URL=https://실제-백엔드-도메인` (끝에 `/` 없이)

3. **경로 입력 예**  
   - 백엔드가 `https://alphapulse-api.onrender.com` 이면  
     `VITE_API_BASE_URL=https://alphapulse-api.onrender.com`  
   - 프론트는 `https://alphapulse-api.onrender.com/api/...` 로 요청합니다.

---

## 빌드 명령 예 (파일 없이 한 번에)

로컬 모드:

```bash
cd frontend && npm run build:local
```

운영 모드 (`VITE_API_BASE_URL` 은 터미널 환경변수 또는 `.env.production`):

```bash
cd frontend && VITE_API_BASE_URL=https://백엔드주소 npm run build:prod
```

Windows CMD 는 `set VITE_API_MODE=production&& set VITE_API_BASE_URL=...&& npm run build` 식으로 나누면 됩니다.

---

## 참고

- **`npm run dev`** 는 항상 **로컬 모드**와 같이 동작합니다 (`vite.config` 의 `/api` → `localhost:4000` 프록시). `.env` 의 `VITE_API_MODE` 로 바꿀 수 없습니다.
- 운영 모드로 빌드했는데 `VITE_API_BASE_URL` 을 빼먹으면, 콘솔에 경고가 나고 상대 경로로만 요청합니다 (의도와 다를 수 있음).

---

## Backend: daily close catch-up (once on start)

If the server was off when the scheduled job should run, after **each process start** it scans the last **N** calendar days (**today excluded**) per market timezone (US `America/New_York`, KR `Asia/Seoul`). Weekends are skipped. Default **N** is 7 (max 14): set `STARTUP_CATCHUP_DAYS`.

For each candidate date, if `analysis_daily/{market}_{YYYY-MM-DD}` is missing or `generatedCount` is 0, it runs the **same pipeline** as the scheduled daily close (predict → Firestore → reconcile outcomes → summary). It **does not** update `job_meta` (today’s scheduled run still controls that).

Turn off with `DISABLE_STARTUP_CATCHUP=1` or `true`. See `backend/.env.example`.

## Firebase (Firestore 등)

- **코드**: `frontend/src/firebase.ts` 가 로컬·운영 빌드 모두에서 **항상** 같은 방식으로 앱을 초기화합니다 (`VITE_API_MODE` 와 무관).
- **설정**: 별도로 안 넣어도 됩니다. 다른 Firebase 프로젝트를 쓰려면 `frontend/.env` 에 `VITE_FIREBASE_*` 를 채우면 됩니다 (`frontend/.env.example` 참고).
- **콘솔에서 한 번 확인**  
  - **Authentication → 설정 → 승인된 도메인**: `localhost`, 배포 도메인(예: `xxx.web.app`)이 있어야 로그인 등을 쓸 때 문제가 없습니다.  
  - **Firestore → 규칙**: 브라우저에서 읽기/쓰기 허용 범위를 여기서 정합니다 (조회가 막히면 규칙을 확인).

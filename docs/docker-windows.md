# Docker로 AlphaPulse 실행하기 (Windows / LAN)

LAN에 있는 Windows PC(예: `192.168.0.232`)에 Docker Desktop이 설치되어 있다고 가정합니다.

## 구성 요약

| 서비스 | 설명 | 기본 포트 |
|--------|------|-----------|
| **api** | Node 백엔드 + 빌드된 프론트 정적 파일 | **4001** |
| **predict** | Python FastAPI 예측 서버 | **8001** |

컨테이너 간 통신:

- 백엔드 → 예측: `PREDICT_URL=http://predict:8001`
- 예측 → 백엔드(뉴스 피처 등): `BACKEND_BASE_URL=http://api:4001`

브라우저에서는 **한 주소**만 쓰면 됩니다.

- UI + API: `http://<PC의-LAN-IP>:4001`  
  예: `http://192.168.0.232:4001`

## 1. 소스 코드 준비

- Git 사용: 해당 PC에서 저장소를 clone 한 뒤 프로젝트 루트로 이동합니다.
- 또는: 개발 중인 PC에서 프로젝트 폴더 전체를 복사합니다.

## 2. Docker Desktop (Windows)

- Docker Desktop을 실행합니다.
- 가능하면 **WSL2 백엔드**를 사용합니다(설정에서 확인).

## 3. 빌드 및 기동

PowerShell 또는 CMD에서 **프로젝트 루트**에서:

```powershell
cd C:\path\to\AlphaPulse
docker compose build
docker compose up -d
```

### 접속 확인

- 웹 앱: `http://192.168.0.232:4001` (본인 PC IP로 변경)
- 예측 서버 헬스: `http://192.168.0.232:8001/health`

같은 Wi‑Fi의 스마트폰·다른 PC에서도 `http://192.168.0.232:4001` 형태로 접속할 수 있습니다.

## 4. Windows 방화벽

다른 기기에서 접속이 안 되면 **인바운드**로 TCP **4001**(필요 시 **8001**)을 허용하는 규칙을 추가하세요.

## 5. Firestore / Firebase (선택)

예측 이력(`predictions_v2`)·일일 배치 등을 쓰려면 백엔드에 Firebase Admin 자격 증명이 필요합니다.

1. `backend/.env.example`을 참고해 `backend/.env`를 만듭니다.
2. `docker-compose.yml`의 `api` 서비스에 예시처럼 **키 파일 마운트**와 환경 변수를 추가합니다.

```yaml
    environment:
      GOOGLE_APPLICATION_CREDENTIALS: /run/secrets/firebase-adminsdk.json
    volumes:
      - C:/Users/YourName/secrets/firebase-adminsdk.json:/run/secrets/firebase-adminsdk.json:ro
```

`C:/Users/...` 경로는 본인 PC의 서비스 계정 JSON 실제 경로로 바꿉니다.

환경 변수만 쓰는 방식(`FIREBASE_SERVICE_ACCOUNT_JSON` 등)은 `backend/.env.example` 및 `backend/src/firebaseCredential.ts` 동작을 참고하세요.

## 6. 저장소에 포함된 Docker 관련 파일

| 파일 | 역할 |
|------|------|
| `Dockerfile` | 프론트 `npm run build:local` → 백엔드 빌드 → `frontend/dist`를 이미지에 포함, 포트 4001 |
| `ai_model/Dockerfile` | Python 예측 API, 포트 8001 |
| `docker-compose.yml` | `api` + `predict` 오케스트레이션, LAN용 `0.0.0.0:4001` 바인딩 |
| `ai_model/requirements.txt` | 예측 서버 pip 의존성 |
| `.dockerignore` | 이미지에 넣지 않을 경로 제외 |

## 7. 환경 변수 (선택)

백엔드 전용 설정은 `backend/.env`에 두고, Compose에서 읽게 하려면 `docker-compose.yml`의 `api`에 다음을 추가할 수 있습니다.

```yaml
    env_file:
      - ./backend/.env
```

`backend/.env`가 없으면 Compose가 실패할 수 있으므로, 파일을 만들기 전에는 `env_file` 줄을 두지 않거나, 빈 파일을 두지 마세요.

## 8. 자주 겪는 이슈

- **첫 `docker compose build`가 오래 걸림**  
  `npm ci`, 프론트 TypeScript+Vite 빌드, pip 패키지(특히 `lightgbm`, `shap`) 때문입니다.

- **FinBERT(뉴스 감성)**  
  기본 AI 이미지에서는 `FINBERT_ENABLED=false`로 두어 이미지 크기와 의존성을 줄였습니다.  
  켜려면 `torch` + `transformers` 등을 포함한 별도 이미지/레이어가 필요합니다.

- **Redis**  
  현재 `docker-compose.yml`에는 Redis 서비스가 없습니다. 사용하려면 `redis` 컨테이너와 `REDIS_URL` 환경 변수를 `api`에 추가하면 됩니다.

## 9. 중지·재시작

```powershell
docker compose down
docker compose up -d
```

로그 확인:

```powershell
docker compose logs -f api
docker compose logs -f predict
```

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
| `docker-compose.yml` | `api` + `predict` 오케스트레이션, LAN용 `0.0.0.0:4001` 바인딩, 이미지 태그 `alphapulse/*:local`, 플랫폼 `linux/amd64` |
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

---

## 10. 맥에서 이미지 빌드 → Windows에서는 실행만

Windows PC가 대부분 **Intel/AMD 64비트**이고, 맥이 **Apple Silicon(M1/M2/M3)**이면 맥에서 기본으로 만들어진 이미지는 `arm64`라서 Windows에서 그대로 쓰기 어렵습니다.  
그래서 **항상 `linux/amd64`용으로 빌드**한 뒤, 이미지 파일만 옮기는 방식을 권장합니다.

이 저장소의 `docker-compose.yml`에는 이미 다음이 들어 있습니다.

- 고정 태그: `alphapulse/api:local`, `alphapulse/predict:local`
- 플랫폼: `platform: linux/amd64` (맥·윈도우 공통으로 Windows Docker와 맞춤)

### 10.1 맥에서 할 일

프로젝트 루트에서:

```bash
cd /path/to/AlphaPulse

# (선택, 한 번만) buildx 사용 가능하게
docker buildx create --name alphapulse-cross --use 2>/dev/null || docker buildx use alphapulse-cross

# amd64 이미지 빌드 (Apple Silicon 맥은 여기서 시간이 다소 걸릴 수 있음)
docker compose build

# 두 이미지를 하나의 tar로 저장
docker save -o alphapulse-images.tar \
  alphapulse/api:local \
  alphapulse/predict:local
```

생성된 **`alphapulse-images.tar`** 를 USB·네트워크 공유·클라우드 등으로 Windows PC로 복사합니다.

**함께 복사할 파일(Windows에서 `up`만 할 때 필요)**

- `docker-compose.yml` (필수)
- Firestore 등을 쓸 경우: `backend/.env` 및 Firebase 키 파일(Compose에 마운트한 경로와 맞출 것)

소스 코드(`Dockerfile`, `frontend/` …)는 **이미지 안에 이미 들어가 있으므로** Windows에 꼭 둘 필요는 없습니다. 다만 나중에 다시 빌드할 계획이 있으면 저장소 전체를 두는 편이 좋습니다.

### 10.2 Windows에서 할 일

PowerShell에서 `docker-compose.yml`과 `alphapulse-images.tar`가 있는 폴더로 이동한 뒤:

```powershell
cd C:\path\to\AlphaPulse

docker load -i alphapulse-images.tar

docker compose up -d --no-build
```

`--no-build`는 로컬에 방금 `load`한 이미지를 쓰고, 다시 빌드하지 않게 합니다.

접속은 기존과 동일합니다.

- `http://<Windows-LAN-IP>:4001`

### 10.3 맥이 Intel인 경우

맥도 **amd64**이면 Windows와 아키텍처가 같아서, 위 `docker compose build`만으로도 보통 문제 없습니다. 그래도 `linux/amd64`를 명시해 두었으므로 동일 절차를 쓰면 됩니다.

### 10.4 용량·보안 참고

- `alphapulse-images.tar`는 **수 GB**가 될 수 있습니다.
- tar 안에는 코드·의존성이 포함되므로, **공유 위치·백업 정책**을 신경 쓰세요.

### 10.5 대안: 소스만 옮기고 Windows에서 빌드

이미지를 옮기기 부담되면, **저장소 폴더 전체**만 Windows로 복사한 뒤 그 PC에서 `docker compose build && docker compose up -d` 하는 방식이 가장 단순합니다(맥에서 빌드는 하지 않음).

---

## 11. Blueprint Lab 스타일: 맥에서 개별 빌드 → tar 전송 → Podman으로 교체

다른 프로젝트에서 쓰던 것처럼 **`docker build`를 이미지마다 명시**하고, **tar로 저장한 뒤 `scp`로 올리고**, 운영 서버에서 **`podman load` + `podman run`** 으로 컨테이너만 갈아끼우는 방식으로도 동일하게 할 수 있습니다.

### AlphaPulse와 Blueprint의 차이(한 줄)

| Blueprint Lab | AlphaPulse |
|---------------|------------|
| `Dockerfile.frontend` + `server/Dockerfile` → 이미지 2개 | **프론트 빌드 결과가 API 이미지 안에 포함** (`Dockerfile` 멀티 스테이지). 별도 Nginx 프론트 이미지는 없음 |
| 프론트 / 백엔드 | **api**(Node + 정적 UI) + **predict**(Python FastAPI) **이미지 2개** |

즉, **“프론트 tar + 백엔드 tar”가 아니라 “predict tar + api tar”** 두 장이 됩니다.

### 11.1 1단계: 로컬(Mac)에서 이미지 재빌드 및 추출

저장소 루트에서 태그는 `docker-compose.yml`과 맞춥니다(`alphapulse/predict:local`, `alphapulse/api:local`).

```bash
cd ~/Documents/coding/AlphaPulse   # 본인 경로로 변경

# predict (컨텍스트는 ai_model/)
docker build --platform linux/amd64 \
  -t alphapulse/predict:local \
  -f ai_model/Dockerfile ./ai_model

# api (프론트 빌드 포함, 루트 Dockerfile)
docker build --platform linux/amd64 \
  -t alphapulse/api:local \
  -f Dockerfile .

# .tar 로 저장 (Blueprint처럼 파일을 나눠도 됨)
docker save -o alphapulse-predict.tar alphapulse/predict:local
docker save -o alphapulse-api.tar alphapulse/api:local
```

한 파일로 묶고 싶으면:

```bash
docker save -o alphapulse-images.tar \
  alphapulse/predict:local \
  alphapulse/api:local
```

### 11.2 2단계: 운영 서버로 전송

예시(포트·사용자·호스트·원격 경로는 환경에 맞게 바꿉니다).

```bash
scp -P 22222 \
  alphapulse-predict.tar alphapulse-api.tar \
  vims@192.168.0.141:~/projects/alphapulse/
```

### 11.3 3단계: 서버(Podman)에서 기존 컨테이너 교체

**사용자 정의 네트워크**를 쓰면 컨테이너 이름으로 서로 통신할 수 있습니다(`PREDICT_URL`, `BACKEND_BASE_URL`).

```bash
ssh -p 22222 vims@192.168.0.141
cd ~/projects/alphapulse

# 네트워크(최초 1회)
podman network create alphapulse-network 2>/dev/null || true

# 기존 앱 컨테이너만 중지·삭제 (DB 등 다른 스택은 그대로 두는 식으로 조정)
podman rm -f alphapulse-predict alphapulse-api

# 신규 이미지 로드
podman load < alphapulse-predict.tar
podman load < alphapulse-api.tar
```

실행 순서는 `docker-compose.yml`과 같이 **predict → api** 로 두면 됩니다(백엔드가 예측 서비스에 의존).

```bash
podman run -d --name alphapulse-predict \
  --network alphapulse-network \
  -p 8001:8001 \
  -e BACKEND_BASE_URL=http://alphapulse-api:4001 \
  -e FINBERT_ENABLED=false \
  --restart unless-stopped \
  alphapulse/predict:local

podman run -d --name alphapulse-api \
  --network alphapulse-network \
  -p 4001:4001 \
  -e NODE_ENV=production \
  -e PORT=4001 \
  -e PREDICT_URL=http://alphapulse-predict:8001 \
  -e FRONTEND_DIST=/app/frontend/dist \
  --restart unless-stopped \
  alphapulse/api:local
```

- **공인 IP·방화벽 앞에서 포트만 열려 있으면** `-p 4001:4001` 만으로 UI+API 접속이 됩니다. 예측 서버는 내부 전용으로 두려면 `-p 127.0.0.1:8001:8001` 처럼 바인딩을 조이면 됩니다.
- **Firebase·Redis·기타 비밀**은 Blueprint에서 하던 것처럼 `-e ...`, `--env-file`, `-v ...json:ro` 를 `alphapulse-api` `podman run` 줄에 추가하면 됩니다. (`docker-compose.yml` §5 참고.)

### 11.4 Docker Desktop(Windows)에서도 동일한가?

가능합니다. `podman` 대신 `docker`만 쓰면 됩니다.

```powershell
docker network create alphapulse-network 2>$null
docker rm -f alphapulse-predict alphapulse-api
docker load -i alphapulse-predict.tar
docker load -i alphapulse-api.tar
# 이후 podman run 과 동일 인자로 docker run ...
```

또는 tar만 로드해 둔 뒤 **`docker compose up -d --no-build`**(같은 폴더에 `docker-compose.yml` 유지)가 더 단순할 수 있습니다(§10).

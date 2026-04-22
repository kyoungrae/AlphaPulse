<!-- # Docker로 AlphaPulse 실행하기 (Windows / LAN)

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

## 7. 환경 변수

`docker-compose.yml`의 `api` 서비스는 **`./backend/.env`를 자동으로 불러옵니다** (`env_file`). 로컬과 같은 Firebase·기타 설정을 넣어 두면 컨테이너에 주입됩니다.

- `backend/.env`가 없으면 Compose가 실패할 수 있으므로, `backend/.env.example`을 복사해 만듭니다.
- `GOOGLE_APPLICATION_CREDENTIALS`가 **파일 경로**를 가리키면, 그 파일이 **컨테이너 안 경로에 있어야** 합니다. `backend/` 아래 JSON을 쓰는 경우 `docker-compose.yml`의 `volumes` 예시(주석)로 마운트하거나, `.env`에 **`FIREBASE_SERVICE_ACCOUNT_JSON`**(JSON 본문 또는 경로) 방식을 쓰면 마운트 없이 동작할 수 있습니다 (`backend/src/firebaseCredential.ts` 참고).

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

--- -->

## 11. Blueprint Lab 스타일: 맥에서 개별 빌드 → tar 전송 → docker으로 교체

<!-- 다른 프로젝트에서 쓰던 것처럼 **`docker build`를 이미지마다 명시**하고, **tar로 저장한 뒤** 운영 PC로 옮긴 뒤, **`docker load` → `docker compose up -d --no-build`** 한 번으로 띄우는 방식을 권장합니다(아래 §11.3). 긴 `docker run` 두 줄을 수동으로 칠 필요가 없습니다.

### AlphaPulse와 Blueprint의 차이(한 줄)

| Blueprint Lab | AlphaPulse |
|---------------|------------|
| `Dockerfile.frontend` + `server/Dockerfile` → 이미지 2개 | **프론트 빌드 결과가 API 이미지 안에 포함** (`Dockerfile` 멀티 스테이지). 별도 Nginx 프론트 이미지는 없음 |
| 프론트 / 백엔드 | **api**(Node + 정적 UI) + **predict**(Python FastAPI) **이미지 2개** |

즉, **“프론트 tar + 백엔드 tar”가 아니라 “predict tar + api tar”** 두 장이 됩니다. -->

### 11.1 1단계: 로컬(Mac)에서 이미지 재빌드 및 추출

<!-- 저장소 루트에서 태그는 `docker-compose.yml`과 맞춥니다(`alphapulse/predict:local`, `alphapulse/api:local`). -->

```bash
# 본인 경로로 변경
cd ~/Documents/coding/AlphaPulse   

# predict (컨텍스트는 ai_model/)
docker build --platform linux/amd64 -t alphapulse/predict:local -f ai_model/Dockerfile ./ai_model

# api (프론트 빌드 포함, 루트 Dockerfile)
docker build --platform linux/amd64 -t alphapulse/api:local -f Dockerfile .

# .tar 로 저장 (Blueprint처럼 파일을 나눠도 됨)
docker save -o alphapulse-predict.tar alphapulse/predict:local
docker save -o alphapulse-api.tar alphapulse/api:local

```

<!-- 한 파일로 묶고 싶으면: -->

<!-- ```bash -->
<!-- # docker save -o alphapulse-images.tar alphapulse/predict:local alphapulse/api:local -->

<!-- ``` -->

### 11.2 2단계: 운영 서버로 전송

<!-- **이미지 tar 두 개**와 함께, 같은 폴더에서 Compose를 쓰려면 **`docker-compose.yml` 파일 하나**도 같이 복사하세요(저장소 루트에 있음, 용량 매우 작음).  
Firestore 등을 쓰려면 맥의 **`backend/.env`** 도 같은 구조로 두면 됩니다(`./backend/.env`).

예시(포트·사용자·호스트·원격 경로는 환경에 맞게 바꿉니다). -->

```bash
scp -P 22 alphapulse-predict.tar alphapulse-api.tar docker-compose.yml test@192.168.0.232:~/project/alphapulse/
# (선택) scp ... backend/.env test@192.168.0.232:~/project/alphapulse/backend/

```

### 11.3 3단계: 서버(docker)에서 기존 컨테이너 교체

<!-- **권장:** `docker-compose.yml`이 있는 디렉터리에서 **`docker load` 후 `docker compose up -d --no-build`** 만 실행합니다. 포트·`PREDICT_URL`·`env_file` 등은 YAML에 이미 정의되어 있습니다.

예전에 **수동 `docker run`으로** `alphapulse-predict` / `alphapulse-api` 이름을 썼다면, 한 번 지운 뒤 Compose로 올립니다. -->

```bash
# tar + docker-compose.yml 이 있는 폴더
cd ~/projects/alphapulse

docker rm -f alphapulse-predict alphapulse-api

docker load -i alphapulse-predict.tar
docker load -i alphapulse-api.tar

docker compose up -d --no-build
```

<!-- - `--no-build`: 방금 `load`한 이미지만 쓰고, Dockerfile로 다시 빌드하지 않습니다.
- **`backend/.env` 없이**도 기동할 수 있게 두었습니다(`env_file` optional). Firestore를 쓰려면 맥에서 복사한 `backend/.env`를 두면 자동 주입됩니다.
- 서비스 이름은 Compose 기준 **`predict` / `api`** 입니다(예전 수동 이름 `alphapulse-*`와 다를 수 있음).
 -->
**대안(Compose 없이):** tar만 있는 PC에서는 예전처럼 긴 `docker run` 두 줄을 쓸 수 있지만, 유지보수가 불편하므로 **`docker-compose.yml`을 같이 두는 방식**을 권장합니다.

```bash
docker run -d --name alphapulse-predict --network alphapulse-network -p 8001:8001 -e BACKEND_BASE_URL=http://alphapulse-api:4001 -e FINBERT_ENABLED=false --restart unless-stopped alphapulse/predict:local

docker run -d --name alphapulse-api --network alphapulse-network -p 4001:4001 -e NODE_ENV=production -e PORT=4001 -e PREDICT_URL=http://alphapulse-predict:8001 -e FRONTEND_DIST=/app/frontend/dist --restart unless-stopped alphapulse/api:local
```

<!-- (위 `docker run`은 **사용자 정의 네트워크 `alphapulse-network`가 이미 있을 때**이며, Compose를 쓰면 네트워크 생성까지 포함되므로 일반적으로는 위 § 권장 절차만 쓰면 됩니다.)

- **공인 IP·방화벽**에서는 TCP **4001** (필요 시 **8001**)을 열면 됩니다.
- **Firebase JSON 파일 경로**를 `.env`에 쓰는 경우, 컨테이너 안 경로와 `docker-compose.yml`의 `volumes` 주석을 맞추세요(§5·§7). -->

### 11.3.1 여전히 「Firestore 미설정」「예측 이력이 비어 있습니다」가 뜰 때

`docker compose up`까지 했는데도 뜨는 경우는 거의 항상 **백엔드가 Firestore Admin에 못 붙는 것**입니다. 아래를 순서대로 확인하세요.

1. **Windows에 `backend/.env`가 실제로 있는지**  
   `docker-compose.yml`과 **같은 프로젝트 루트** 아래 `backend\.env` (경로 오타 없음).

2. **`.env` 안의 경로가 “맥 전용”이 아닌지**  
   `GOOGLE_APPLICATION_CREDENTIALS=/Users/.../xxx.json` 처럼 **맥 절대 경로**면 컨테이너 안에는 그 파일이 없습니다.  
   → Windows에서 쓰는 JSON을 `backend\` 아래에 두고, 아래 3번처럼 **컨테이너 경로 + 마운트**로 맞춥니다.

3. **JSON 파일을 컨테이너에 넣기 (가장 흔한 해결)**  
   - 맥에서 받은 **서비스 계정 JSON**을 Windows 프로젝트의 `backend\` 폴더에 복사합니다 (예: `backend\alphapulse-firebase-adminsdk.json`).  
   - `backend\.env`에 한 줄을 **컨테이너 기준 경로**로 맞춥니다:  
     `GOOGLE_APPLICATION_CREDENTIALS=/run/secrets/firebase.json`  
   - `docker-compose.yml`의 `api` 서비스에서 **주석 처리된 `volumes` 두 줄을 해제**하고, 왼쪽 파일명을 방금 둔 파일 이름으로 바꿉니다.  
     예: `./backend/alphapulse-firebase-adminsdk.json:/run/secrets/firebase.json:ro`  
   - 저장 후 재기동:  
     `docker compose up -d --no-build --force-recreate api`

4. **로그로 확인** (PowerShell):  
   `docker compose logs api` 에서 `[Firestore]` 경고가 사라졌는지 봅니다.

5. **대안**  
   `backend/.env`에 **`FIREBASE_SERVICE_ACCOUNT_JSON`** 으로 JSON **본문**을 넣는 방식이면 파일 마운트 없이도 될 수 있습니다(값이 길고 따옴표 이스케이프 주의). 동작은 `backend/src/firebaseCredential.ts` 참고.

브라우저 쪽 「Firestore 규칙」 안내는 **클라이언트 SDK로 직접 읽을 때** 추가로 필요할 수 있습니다. Admin만 붙으면 API 경로로 이력이 채워지는 경우가 많습니다.

### 11.4 Docker Desktop(Windows)에서도 동일한가?

가능합니다. **tar 두 개 + `docker-compose.yml`을 같은 폴더에 두고** PowerShell에서:

```powershell
cd C:\Users\TEST\project\alphapulse

docker rm -f alphapulse-predict alphapulse-api 2>$null

docker load -i alphapulse-predict.tar
docker load -i alphapulse-api.tar

docker compose up -d --no-build
```

`env_file`의 `path` / `required: false` 형식은 **Docker Compose v2.24+**(최근 Docker Desktop)에서 지원됩니다. 오류가 나면 저장소의 `docker-compose.yml`을 받은 최신본인지 확인하세요.

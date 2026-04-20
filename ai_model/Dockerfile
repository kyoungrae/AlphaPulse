# Inference API (FastAPI). Default: no FinBERT to keep image smaller.
FROM python:3.11-slim-bookworm

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py ./

ENV PYTHONUNBUFFERED=1
ENV BACKEND_BASE_URL=http://api:4001
ENV FINBERT_ENABLED=false

EXPOSE 8001

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8001"]

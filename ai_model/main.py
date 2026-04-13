"""
FastAPI inference server for next-day direction classification.

Install:
  pip install fastapi uvicorn yfinance pandas scikit-learn ta joblib

Run (port 8001, matches backend PREDICT_URL default):
  ./start
  # or: uvicorn main:app --reload --port 8001
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Tuple
from urllib.parse import urlencode
from urllib.request import urlopen

import pandas as pd
import yfinance as yf
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import TimeSeriesSplit, cross_validate
from sklearn.preprocessing import StandardScaler
from ta.momentum import RSIIndicator
from ta.trend import MACD, SMAIndicator
from ta.volatility import BollingerBands

logger = logging.getLogger(__name__)

app = FastAPI(title="AlphaPulse 예측 서버", version="0.1.0")

FEATURE_COLS: List[str] = [
  "Open",
  "High",
  "Low",
  "Close",
  "Volume",
  "sma_5",
  "sma_20",
  "rsi_14",
  "macd",
  "macd_signal",
  "macd_hist",
  "bb_bbm",
  "bb_bbh",
  "bb_bbl",
  "news_sentiment_score",
  "news_volume",
  "event_keyword_count",
]

MODEL_TTL_HOURS = 24
DATA_BASELINE_YEARS = 10
PRICE_CACHE_TTL_MINUTES = 30
PRELOAD_TICKERS = ["AAPL", "MSFT", "NVDA", "TSLA", "AMZN", "GOOGL", "META", "JPM", "XOM", "UNH"]
BACKEND_BASE_URL = os.getenv("BACKEND_BASE_URL", "http://localhost:4000").rstrip("/")
NEWS_FEATURE_TIMEOUT_SECONDS = float(os.getenv("NEWS_FEATURE_TIMEOUT_SECONDS", "8"))
NEWS_FEATURES_ENABLED = os.getenv("NEWS_FEATURES_ENABLED", "true").lower() != "false"


@dataclass
class ModelBundle:
  model: RandomForestClassifier
  scaler: StandardScaler
  trained_at: datetime
  cv_accuracy: float
  cv_precision: float


MODEL_CACHE: Dict[str, ModelBundle] = {}
PRICE_CACHE: Dict[Tuple[str, int], Tuple[pd.DataFrame, datetime]] = {}


def load_price_data(ticker: str, period_years: int = DATA_BASELINE_YEARS) -> pd.DataFrame:
  cache_key = (ticker, period_years)
  cached = PRICE_CACHE.get(cache_key)
  if cached:
    df_cached, loaded_at = cached
    if datetime.now() - loaded_at < timedelta(minutes=PRICE_CACHE_TTL_MINUTES):
      return df_cached.copy()

  df = yf.download(ticker, period=f"{period_years}y", interval="1d", auto_adjust=False)
  # Flatten multi-index columns if present (single ticker can still return multi-index)
  if isinstance(df.columns, pd.MultiIndex):
    # Select the second level (ticker) and rename to single-level columns
    df.columns = [col[0] for col in df.columns]  # e.g., ('Close','AAPL') -> 'Close'
  df = df.dropna()

  # Ensure required columns exist
  expected = {"Open", "High", "Low", "Close", "Volume"}
  missing = expected - set(df.columns)
  if missing:
    raise ValueError(f"Missing columns in price data: {missing}")
  PRICE_CACHE[cache_key] = (df, datetime.now())
  return df.copy()


def load_news_feature_data(ticker: str, from_date: str, to_date: str) -> pd.DataFrame:
  if not NEWS_FEATURES_ENABLED:
    return pd.DataFrame(columns=["news_sentiment_score", "news_volume", "event_keyword_count"])
  try:
    market = "kr" if ticker.upper().endswith((".KS", ".KQ")) else "us"
    query = urlencode({"from": from_date, "to": to_date, "limit": 300, "market": market})
    url = f"{BACKEND_BASE_URL}/api/features/news/{ticker}?{query}"
    with urlopen(url, timeout=NEWS_FEATURE_TIMEOUT_SECONDS) as response:
      payload = json.loads(response.read().decode("utf-8"))
    daily = payload.get("daily", [])
    if not isinstance(daily, list) or len(daily) == 0:
      return pd.DataFrame(columns=["news_sentiment_score", "news_volume", "event_keyword_count"])
    news_df = pd.DataFrame(daily)
    required_cols = ["date", "news_sentiment_score", "news_volume", "event_keyword_count"]
    missing = [c for c in required_cols if c not in news_df.columns]
    if missing:
      logger.warning("News feature response missing columns: %s", missing)
      return pd.DataFrame(columns=["news_sentiment_score", "news_volume", "event_keyword_count"])
    news_df["date"] = pd.to_datetime(news_df["date"]).dt.tz_localize(None)
    return news_df.set_index("date")[["news_sentiment_score", "news_volume", "event_keyword_count"]]
  except Exception as err:
    logger.warning("News feature load failed for %s: %s", ticker, err)
    return pd.DataFrame(columns=["news_sentiment_score", "news_volume", "event_keyword_count"])


def add_features(df: pd.DataFrame, ticker: str) -> pd.DataFrame:
  df = df.copy()
  df.index = pd.to_datetime(df.index).tz_localize(None)
  close = df["Close"]
  # Ensure 1-D series (guard against DataFrame shape (n,1))
  if isinstance(close, pd.DataFrame):
    close = close.iloc[:, 0]
  close = pd.to_numeric(close, errors="coerce")

  df["sma_5"] = SMAIndicator(close, window=5).sma_indicator()
  df["sma_20"] = SMAIndicator(close, window=20).sma_indicator()
  df["rsi_14"] = RSIIndicator(close, window=14).rsi()

  macd = MACD(close)
  df["macd"] = macd.macd()
  df["macd_signal"] = macd.macd_signal()
  df["macd_hist"] = macd.macd_diff()

  # Bollinger Bands (20, 2)
  bb = BollingerBands(close=close, window=20, window_dev=2)
  df["bb_bbm"] = bb.bollinger_mavg()
  df["bb_bbh"] = bb.bollinger_hband()
  df["bb_bbl"] = bb.bollinger_lband()

  df["target"] = (close.shift(-1) > close).astype(int)

  news_df = load_news_feature_data(
    ticker=ticker,
    from_date=df.index.min().date().isoformat(),
    to_date=df.index.max().date().isoformat(),
  )
  if news_df.empty:
    df["news_sentiment_score"] = 0.0
    df["news_volume"] = 0.0
    df["event_keyword_count"] = 0.0
  else:
    merged = df.join(news_df, how="left")
    df["news_sentiment_score"] = pd.to_numeric(merged["news_sentiment_score"], errors="coerce").fillna(0.0)
    df["news_volume"] = pd.to_numeric(merged["news_volume"], errors="coerce").fillna(0.0)
    df["event_keyword_count"] = pd.to_numeric(merged["event_keyword_count"], errors="coerce").fillna(0.0)

  df = df.dropna()
  return df


def train_model(ticker: str = "AAPL") -> ModelBundle:
  df = load_price_data(ticker)
  df_feat = add_features(df, ticker)

  X = df_feat[FEATURE_COLS]
  y = df_feat["target"]

  scaler = StandardScaler()
  X_scaled = scaler.fit_transform(X)

  model = RandomForestClassifier(
    n_estimators=300,
    max_depth=8,
    random_state=42,
    n_jobs=-1,
  )
  model.fit(X_scaled, y)

  tscv = TimeSeriesSplit(n_splits=5)
  cv_model = RandomForestClassifier(
    n_estimators=300,
    max_depth=8,
    random_state=42,
    n_jobs=-1,
  )
  cv_scores = cross_validate(
    cv_model,
    X_scaled,
    y,
    cv=tscv,
    scoring=("accuracy", "precision"),
    n_jobs=-1,
    error_score="raise",
  )
  cv_accuracy = float(cv_scores["test_accuracy"].mean())
  cv_precision = float(cv_scores["test_precision"].mean())

  logger.info(
    "Model trained for %s (samples=%s, cv_acc=%.4f, cv_prec=%.4f)",
    ticker,
    len(X),
    cv_accuracy,
    cv_precision,
  )
  return ModelBundle(
    model=model,
    scaler=scaler,
    trained_at=datetime.now(),
    cv_accuracy=cv_accuracy,
    cv_precision=cv_precision,
  )


def get_model_bundle(ticker: str) -> ModelBundle:
  cached = MODEL_CACHE.get(ticker)
  if cached:
    age = datetime.now() - cached.trained_at
    if age < timedelta(hours=MODEL_TTL_HOURS):
      return cached

  bundle = train_model(ticker)
  MODEL_CACHE[ticker] = bundle
  return bundle


class FeatureImportanceItem(BaseModel):
  feature: str
  importance: float


class PredictResponse(BaseModel):
  ticker: str
  probability_up: float
  direction: str
  last_date: str
  last_close: float
  cv_accuracy: float
  cv_precision: float
  model_trained_at: str
  top_feature_importance: List[FeatureImportanceItem]
  reason_summary: str
  data_years: int


@app.on_event("startup")
def _startup():
  for ticker in PRELOAD_TICKERS:
    try:
      MODEL_CACHE[ticker] = train_model(ticker)
    except Exception as err:
      logger.warning("Preload failed for %s: %s", ticker, err)
  logger.info("Startup preload complete. cached=%s", len(MODEL_CACHE))


@app.get("/predict/{ticker}", response_model=PredictResponse)
def predict(ticker: str):
  ticker = ticker.upper()
  try:
    bundle = get_model_bundle(ticker)
  except Exception as err:
    raise HTTPException(status_code=500, detail=f"모델 학습/로드 실패: {err}") from err

  # Use recent data to generate the latest feature row
  df = load_price_data(ticker, period_years=DATA_BASELINE_YEARS)
  df_feat = add_features(df, ticker)
  if df_feat.empty:
    raise HTTPException(status_code=400, detail="지표 계산을 위한 데이터가 충분하지 않습니다.")

  latest = df_feat.iloc[-1]
  features = latest[FEATURE_COLS].to_frame().T
  features_scaled = bundle.scaler.transform(features)

  proba = bundle.model.predict_proba(features_scaled)[0][1]
  direction = "Up" if proba >= 0.5 else "Down"
  top_idx = bundle.model.feature_importances_.argsort()[::-1][:3]
  top_feature_importance = [
    FeatureImportanceItem(
      feature=FEATURE_COLS[i],
      importance=round(float(bundle.model.feature_importances_[i]), 4),
    )
    for i in top_idx
  ]
  reason_summary = (
    f"이번 예측은 {top_feature_importance[0].feature}, "
    f"{top_feature_importance[1].feature}, {top_feature_importance[2].feature} "
    "지표 영향이 상대적으로 크게 반영되었습니다."
  )

  return PredictResponse(
    ticker=ticker,
    probability_up=round(float(proba), 4),
    direction=direction,
    last_date=str(latest.name.date()),
    last_close=round(float(latest["Close"]), 2),
    cv_accuracy=round(bundle.cv_accuracy, 4),
    cv_precision=round(bundle.cv_precision, 4),
    model_trained_at=bundle.trained_at.isoformat(timespec="seconds"),
    top_feature_importance=top_feature_importance,
    reason_summary=reason_summary,
    data_years=DATA_BASELINE_YEARS,
  )


@app.get("/health")
def health():
  return {"status": "정상"}

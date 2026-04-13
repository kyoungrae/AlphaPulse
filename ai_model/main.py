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
try:
  import torch
  from transformers import AutoModelForSequenceClassification, AutoTokenizer
except Exception:  # pragma: no cover - optional dependency
  torch = None
  AutoModelForSequenceClassification = None
  AutoTokenizer = None
try:
  import shap
except Exception:  # pragma: no cover - optional dependency
  shap = None

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
  "vbp_support_gap",
  "vbp_resistance_gap",
  "vbp_node_strength",
  "oil_price",
  "usd_krw_exchange",
  "us10y_yield",
  "vix_close",
  "gold_price",
  "oil_return_5d",
  "usd_krw_return_5d",
  "us10y_delta_5d",
]

MODEL_TTL_HOURS = 24
DATA_BASELINE_YEARS = 10
PRICE_CACHE_TTL_MINUTES = 30
PRELOAD_TICKERS = ["AAPL", "MSFT", "NVDA", "TSLA", "AMZN", "GOOGL", "META", "JPM", "XOM", "UNH"]
BACKEND_BASE_URL = os.getenv("BACKEND_BASE_URL", "http://localhost:4000").rstrip("/")
NEWS_FEATURE_TIMEOUT_SECONDS = float(os.getenv("NEWS_FEATURE_TIMEOUT_SECONDS", "8"))
NEWS_FEATURES_ENABLED = os.getenv("NEWS_FEATURES_ENABLED", "true").lower() != "false"
MACRO_CACHE_TTL_MINUTES = 60
FINBERT_MODEL = os.getenv("FINBERT_MODEL", "ProsusAI/finbert")
FINBERT_ENABLED = os.getenv("FINBERT_ENABLED", "true").lower() != "false"


@dataclass
class ModelBundle:
  model: RandomForestClassifier
  scaler: StandardScaler
  trained_at: datetime
  cv_accuracy: float
  cv_precision: float


MODEL_CACHE: Dict[str, ModelBundle] = {}
PRICE_CACHE: Dict[Tuple[str, int], Tuple[pd.DataFrame, datetime]] = {}
MACRO_CACHE: Dict[int, Tuple[pd.DataFrame, datetime]] = {}
FINBERT_PIPELINE: Dict[str, object] = {}


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


def load_macro_feature_data(period_years: int = DATA_BASELINE_YEARS) -> pd.DataFrame:
  cached = MACRO_CACHE.get(period_years)
  if cached:
    df_cached, loaded_at = cached
    if datetime.now() - loaded_at < timedelta(minutes=MACRO_CACHE_TTL_MINUTES):
      return df_cached.copy()

  end = datetime.now()
  start = end - timedelta(days=max(365, period_years * 365 + 30))
  symbols = {
    "oil_price": "CL=F",
    "usd_krw_exchange": "KRW=X",
    "us10y_yield": "^TNX",
    "vix_close": "^VIX",
    "gold_price": "GC=F",
  }
  merged: Optional[pd.DataFrame] = None
  for col, ticker in symbols.items():
    df = yf.download(ticker, start=start, end=end, interval="1d", auto_adjust=False)
    if isinstance(df.columns, pd.MultiIndex):
      df.columns = [c[0] for c in df.columns]
    if "Close" not in df.columns:
      continue
    s = pd.to_numeric(df["Close"], errors="coerce").rename(col).to_frame()
    merged = s if merged is None else merged.join(s, how="outer")

  if merged is None or merged.empty:
    return pd.DataFrame(
      columns=[
        "oil_price",
        "usd_krw_exchange",
        "us10y_yield",
        "vix_close",
        "gold_price",
        "oil_return_5d",
        "usd_krw_return_5d",
        "us10y_delta_5d",
      ]
    )

  merged.index = pd.to_datetime(merged.index).tz_localize(None)
  merged = merged.sort_index().ffill()
  merged["oil_return_5d"] = merged["oil_price"].pct_change(5)
  merged["usd_krw_return_5d"] = merged["usd_krw_exchange"].pct_change(5)
  merged["us10y_delta_5d"] = merged["us10y_yield"].diff(5)
  merged = merged.fillna(0.0)
  MACRO_CACHE[period_years] = (merged, datetime.now())
  return merged.copy()


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

  macro_df = load_macro_feature_data(DATA_BASELINE_YEARS)
  if macro_df.empty:
    df["oil_price"] = 0.0
    df["usd_krw_exchange"] = 0.0
    df["us10y_yield"] = 0.0
    df["vix_close"] = 0.0
    df["gold_price"] = 0.0
    df["oil_return_5d"] = 0.0
    df["usd_krw_return_5d"] = 0.0
    df["us10y_delta_5d"] = 0.0
  else:
    merged_macro = df.join(macro_df, how="left")
    df["oil_price"] = pd.to_numeric(merged_macro["oil_price"], errors="coerce").ffill().fillna(0.0)
    df["usd_krw_exchange"] = pd.to_numeric(merged_macro["usd_krw_exchange"], errors="coerce").ffill().fillna(0.0)
    df["us10y_yield"] = pd.to_numeric(merged_macro["us10y_yield"], errors="coerce").ffill().fillna(0.0)
    df["vix_close"] = pd.to_numeric(merged_macro["vix_close"], errors="coerce").ffill().fillna(0.0)
    df["gold_price"] = pd.to_numeric(merged_macro["gold_price"], errors="coerce").ffill().fillna(0.0)
    df["oil_return_5d"] = pd.to_numeric(merged_macro["oil_return_5d"], errors="coerce").fillna(0.0)
    df["usd_krw_return_5d"] = pd.to_numeric(merged_macro["usd_krw_return_5d"], errors="coerce").fillna(0.0)
    df["us10y_delta_5d"] = pd.to_numeric(merged_macro["us10y_delta_5d"], errors="coerce").fillna(0.0)

  # Volume-by-price proxy features: approximate "물량대/평단대" 저항·지지 압력을 수치화
  typical_price = (df["High"] + df["Low"] + df["Close"]) / 3.0
  vol = pd.to_numeric(df["Volume"], errors="coerce").fillna(0.0)
  price_min = float(typical_price.min())
  price_max = float(typical_price.max())
  bin_count = 24
  eps = 1e-9
  if price_max - price_min < eps:
    df["vbp_support_gap"] = 0.0
    df["vbp_resistance_gap"] = 0.0
    df["vbp_node_strength"] = 0.0
  else:
    step = (price_max - price_min) / bin_count
    bins = [price_min + step * i for i in range(bin_count + 1)]
    vbp_support_gap: List[float] = []
    vbp_resistance_gap: List[float] = []
    vbp_node_strength: List[float] = []
    lookback = 120
    for i in range(len(df)):
      start = max(0, i - lookback + 1)
      tp_window = typical_price.iloc[start : i + 1]
      vol_window = vol.iloc[start : i + 1]
      hist = [0.0] * bin_count
      for px, vv in zip(tp_window, vol_window):
        idx = int((float(px) - price_min) / max(step, eps))
        idx = min(max(idx, 0), bin_count - 1)
        hist[idx] += float(vv)
      cur = float(df["Close"].iloc[i])
      cur_idx = int((cur - price_min) / max(step, eps))
      cur_idx = min(max(cur_idx, 0), bin_count - 1)
      support_idx = max(range(0, cur_idx + 1), key=lambda k: hist[k]) if cur_idx >= 0 else cur_idx
      resist_idx = max(range(cur_idx, bin_count), key=lambda k: hist[k]) if cur_idx < bin_count else cur_idx
      support_price = (bins[support_idx] + bins[min(support_idx + 1, bin_count)]) / 2.0
      resist_price = (bins[resist_idx] + bins[min(resist_idx + 1, bin_count)]) / 2.0
      vbp_support_gap.append((cur - support_price) / max(cur, eps))
      vbp_resistance_gap.append((resist_price - cur) / max(cur, eps))
      total_hist = sum(hist)
      vbp_node_strength.append((hist[cur_idx] / total_hist) if total_hist > 0 else 0.0)
    df["vbp_support_gap"] = pd.Series(vbp_support_gap, index=df.index).fillna(0.0)
    df["vbp_resistance_gap"] = pd.Series(vbp_resistance_gap, index=df.index).fillna(0.0)
    df["vbp_node_strength"] = pd.Series(vbp_node_strength, index=df.index).fillna(0.0)

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


class SentimentAnalyzeRequest(BaseModel):
  titles: List[str]


class SentimentAnalyzeItem(BaseModel):
  title: str
  label: str
  score: int


class SentimentAnalyzeResponse(BaseModel):
  data: List[SentimentAnalyzeItem]


def get_finbert_pipeline():
  if not FINBERT_ENABLED:
    raise RuntimeError("FINBERT_ENABLED=false")
  if torch is None or AutoTokenizer is None or AutoModelForSequenceClassification is None:
    raise RuntimeError("transformers/torch 패키지가 설치되지 않았습니다.")
  if "tokenizer" in FINBERT_PIPELINE and "model" in FINBERT_PIPELINE:
    return FINBERT_PIPELINE["tokenizer"], FINBERT_PIPELINE["model"]
  tokenizer = AutoTokenizer.from_pretrained(FINBERT_MODEL)
  model = AutoModelForSequenceClassification.from_pretrained(FINBERT_MODEL)
  model.eval()
  FINBERT_PIPELINE["tokenizer"] = tokenizer
  FINBERT_PIPELINE["model"] = model
  return tokenizer, model


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

  top_feature_importance: List[FeatureImportanceItem]
  if shap is not None:
    try:
      explainer = shap.TreeExplainer(bundle.model)
      shap_values = explainer.shap_values(features_scaled)
      if isinstance(shap_values, list):
        shap_vals_up = shap_values[1][0]
      else:
        # shap>=0.45 returns ndarray with class axis
        arr = shap_values[0]
        shap_vals_up = arr[:, 1] if getattr(arr, "ndim", 1) > 1 else arr
      feature_shap_pairs = list(zip(FEATURE_COLS, [float(v) for v in shap_vals_up]))
      feature_shap_pairs.sort(key=lambda x: abs(x[1]), reverse=True)
      top_feature_importance = [
        FeatureImportanceItem(feature=feat, importance=round(val, 4))
        for feat, val in feature_shap_pairs[:3]
      ]
    except Exception as err:
      logger.warning("SHAP 해석 실패. feature_importances_로 대체: %s", err)
      top_idx = bundle.model.feature_importances_.argsort()[::-1][:3]
      top_feature_importance = [
        FeatureImportanceItem(
          feature=FEATURE_COLS[i],
          importance=round(float(bundle.model.feature_importances_[i]), 4),
        )
        for i in top_idx
      ]
  else:
    top_idx = bundle.model.feature_importances_.argsort()[::-1][:3]
    top_feature_importance = [
      FeatureImportanceItem(
        feature=FEATURE_COLS[i],
        importance=round(float(bundle.model.feature_importances_[i]), 4),
      )
      for i in top_idx
    ]
  reason_summary = (
    f"이번 예측은 {top_feature_importance[0].feature}(기여도 {top_feature_importance[0].importance}), "
    f"{top_feature_importance[1].feature}, {top_feature_importance[2].feature} "
    f"지표의 영향이 이번 결과({direction})를 결정하는 데 크게 작용했습니다."
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


@app.post("/api/sentiment/analyze", response_model=SentimentAnalyzeResponse)
def analyze_sentiment_batch(payload: SentimentAnalyzeRequest):
  titles = [title.strip() for title in payload.titles if title and title.strip()]
  if not titles:
    return SentimentAnalyzeResponse(data=[])
  try:
    tokenizer, model = get_finbert_pipeline()
    inputs = tokenizer(titles, padding=True, truncation=True, return_tensors="pt")
    with torch.no_grad():
      outputs = model(**inputs)
      scores = torch.softmax(outputs.logits, dim=1)
    labels = ["positive", "negative", "neutral"]  # FinBERT class order
    results: List[SentimentAnalyzeItem] = []
    for i, score_set in enumerate(scores):
      label_idx = int(torch.argmax(score_set).item())
      conf = float(score_set[label_idx].item())
      final_score = 0
      if label_idx == 0:
        final_score = int(conf * 100)
      elif label_idx == 1:
        final_score = int(conf * -100)
      results.append(
        SentimentAnalyzeItem(
          title=titles[i],
          label=labels[label_idx],
          score=final_score,
        )
      )
    return SentimentAnalyzeResponse(data=results)
  except Exception as err:
    logger.error("FinBERT 분석 실패: %s", err)
    raise HTTPException(status_code=500, detail="Internal NLP Error")


@app.get("/health")
def health():
  return {"status": "정상"}

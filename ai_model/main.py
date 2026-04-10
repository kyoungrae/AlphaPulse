"""
FastAPI inference server for next-day direction classification.

Install:
  pip install fastapi uvicorn yfinance pandas scikit-learn ta joblib

Run (port 8000):
  uvicorn main:app --reload --port 8000
"""

from __future__ import annotations

import logging
from typing import List, Optional

import pandas as pd
import yfinance as yf
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from sklearn.ensemble import RandomForestClassifier
from ta.momentum import RSIIndicator
from ta.trend import MACD, SMAIndicator

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
]

MODEL: Optional[RandomForestClassifier] = None


def load_price_data(ticker: str, period_years: int = 5) -> pd.DataFrame:
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
  return df


def add_features(df: pd.DataFrame) -> pd.DataFrame:
  close = df["Close"]
  # Ensure 1-D series (guard against DataFrame shape (n,1))
  if isinstance(close, pd.DataFrame):
    close = close.iloc[:, 0]
  close = pd.to_numeric(close, errors="coerce")

  df = df.copy()
  df["sma_5"] = SMAIndicator(close, window=5).sma_indicator()
  df["sma_20"] = SMAIndicator(close, window=20).sma_indicator()
  df["rsi_14"] = RSIIndicator(close, window=14).rsi()

  macd = MACD(close)
  df["macd"] = macd.macd()
  df["macd_signal"] = macd.macd_signal()
  df["macd_hist"] = macd.macd_diff()

  df["target"] = (close.shift(-1) > close).astype(int)

  df = df.dropna()
  return df


def train_model(ticker: str = "AAPL") -> RandomForestClassifier:
  df = load_price_data(ticker)
  df_feat = add_features(df)

  X = df_feat[FEATURE_COLS]
  y = df_feat["target"]

  model = RandomForestClassifier(
    n_estimators=300,
    max_depth=8,
    random_state=42,
    n_jobs=-1,
  )
  model.fit(X, y)
  logger.info("Model trained on %s samples for %s", len(X), ticker)
  return model


class PredictResponse(BaseModel):
  ticker: str
  probability_up: float
  direction: str
  last_date: str
  last_close: float


@app.on_event("startup")
def _startup():
  global MODEL
  MODEL = train_model("AAPL")
  logger.info("Startup training complete.")


@app.get("/predict/{ticker}", response_model=PredictResponse)
def predict(ticker: str):
  ticker = ticker.upper()
  if MODEL is None:
    raise HTTPException(status_code=503, detail="모델이 아직 준비되지 않았습니다.")

  # Use recent data to generate the latest feature row
  df = load_price_data(ticker, period_years=2)
  df_feat = add_features(df)
  if df_feat.empty:
    raise HTTPException(status_code=400, detail="지표 계산을 위한 데이터가 충분하지 않습니다.")

  latest = df_feat.iloc[-1]
  features = latest[FEATURE_COLS].to_frame().T

  proba = MODEL.predict_proba(features)[0][1]
  direction = "Up" if proba >= 0.5 else "Down"

  return PredictResponse(
    ticker=ticker,
    probability_up=round(float(proba), 4),
    direction=direction,
    last_date=str(latest.name.date()),
    last_close=round(float(latest["Close"]), 2),
  )


@app.get("/health")
def health():
  return {"status": "정상"}

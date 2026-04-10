"""
Required packages:
- pip install yfinance pandas scikit-learn ta
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass

import pandas as pd
import yfinance as yf
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import accuracy_score, precision_score
from sklearn.model_selection import train_test_split
from ta.momentum import RSIIndicator
from ta.trend import MACD, SMAIndicator

warnings.filterwarnings("ignore", category=FutureWarning)


@dataclass
class PreparedData:
    features: pd.DataFrame
    target: pd.Series


def load_price_data(ticker: str, period_years: int = 5) -> pd.DataFrame:
    """Download daily OHLCV for the given ticker."""
    df = yf.download(ticker, period=f"{period_years}y", interval="1d", auto_adjust=False)
    df = df.dropna()
    return df


def add_features(df: pd.DataFrame) -> PreparedData:
    """Add technical indicators and target (tomorrow up/down)."""
    close = df["Close"]

    # Simple Moving Averages
    df["sma_5"] = SMAIndicator(close, window=5).sma_indicator()
    df["sma_20"] = SMAIndicator(close, window=20).sma_indicator()

    # RSI (14)
    df["rsi_14"] = RSIIndicator(close, window=14).rsi()

    # MACD
    macd = MACD(close)
    df["macd"] = macd.macd()
    df["macd_signal"] = macd.macd_signal()
    df["macd_hist"] = macd.macd_diff()

    # Target: tomorrow close higher than today -> 1 else 0
    df["target"] = (close.shift(-1) > close).astype(int)

    df = df.dropna()
    feature_cols = [
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
    features = df[feature_cols]
    target = df["target"]
    return PreparedData(features=features, target=target)


def train_and_eval(prepped: PreparedData):
    """Train RandomForest to classify next-day up/down."""
    X_train, X_test, y_train, y_test = train_test_split(
        prepped.features,
        prepped.target,
        test_size=0.2,
        shuffle=False,
        stratify=None,
    )

    model = RandomForestClassifier(
        n_estimators=200,
        max_depth=6,
        random_state=42,
        n_jobs=-1,
    )
    model.fit(X_train, y_train)

    y_pred = model.predict(X_test)
    acc = accuracy_score(y_test, y_pred)
    prec = precision_score(y_test, y_pred, zero_division=0)

    print(f"Test Accuracy : {acc:.4f}")
    print(f"Test Precision: {prec:.4f}")


def main():
    ticker = "AAPL"
    print(f"Downloading {ticker} daily data (5y)...")
    df = load_price_data(ticker, period_years=5)
    print(df.tail())

    print("Adding features and target...")
    prepped = add_features(df)
    print(prepped.features.tail())

    print("Training and evaluating model...")
    train_and_eval(prepped)


if __name__ == "__main__":
    main()

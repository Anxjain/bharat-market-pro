"""LightGBM cross-sectional ranker — walk-forward, no excuses.

Trains on the exported dataset (npm run ml:export) to predict 20-session EXCESS return
vs NIFTY (x20) from point-in-time price features. Validation is WALK-FORWARD by year:
train on everything before year Y, test on year Y. Never random splits — random splits
on overlapping financial windows leak the future and produce the fake 90%-accuracy
models the internet is full of.

Reported per fold (the honest metrics for a ranker):
  * IC  — Spearman rank correlation between prediction and realized x20 (0.03–0.08 is
    genuinely good in equities; anything above ~0.15 usually means leakage — investigate)
  * Q5-Q1 — mean realized x20 of the top prediction quintile minus the bottom one
    (the tradable spread before costs)

Usage:
  cd <project root> && npm run ml:export             # writes scripts/ml/out/dataset.csv
  pip install lightgbm pandas scipy
  python scripts/ml/train.py

Outputs into scripts/ml/out/: model.txt (LightGBM), metrics.json, importance.txt.
The model is NOT wired into the live scan until its walk-forward IC is stable and
positive across folds — the grading panel is the judge, not enthusiasm.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

try:
    import lightgbm as lgb
    import pandas as pd
    from scipy.stats import spearmanr
except ImportError as e:
    sys.exit(f"missing dependency ({e.name}) — run: pip install lightgbm pandas scipy")

OUT = Path(__file__).parent / "out"
FEATURES = ["m12", "m6", "m3", "m1", "vol60", "dd_52w", "off_low_52w", "rsi14"]
TARGET = "x20"

def main() -> None:
    csv = OUT / "dataset.csv"
    if not csv.exists():
        sys.exit(f"{csv} not found — run `npm run ml:export` in server/ first")
    df = pd.read_csv(csv).dropna(subset=FEATURES + [TARGET])
    df["year"] = df["date"].str[:4].astype(int)
    years = sorted(df["year"].unique())
    if len(years) < 3:
        sys.exit(f"only {len(years)} year(s) of labeled data — need >=3 for walk-forward")

    folds = []
    for test_year in years[2:]:  # first two years are the minimum training base
        train = df[df["year"] < test_year]
        test = df[df["year"] == test_year]
        if len(train) < 5_000 or len(test) < 500:
            continue
        model = lgb.train(
            {
                "objective": "regression",
                "metric": "l2",
                "num_leaves": 31,
                "learning_rate": 0.05,
                "feature_fraction": 0.8,
                "bagging_fraction": 0.8,
                "bagging_freq": 1,
                "min_data_in_leaf": 200,  # coarse trees — finance data is mostly noise
                "verbosity": -1,
            },
            lgb.Dataset(train[FEATURES], label=train[TARGET]),
            num_boost_round=300,
        )
        pred = model.predict(test[FEATURES])
        t = test.assign(pred=pred)
        ic = float(spearmanr(t["pred"], t[TARGET]).statistic)
        q = pd.qcut(t["pred"], 5, labels=False, duplicates="drop")
        spread = float(t[TARGET][q == q.max()].mean() - t[TARGET][q == q.min()].mean())
        folds.append({"test_year": int(test_year), "n_train": len(train), "n_test": len(test),
                      "ic": round(ic, 4), "q5_minus_q1_x20_pct": round(spread, 2)})
        print(f"  {test_year}: IC={ic:+.4f}  Q5-Q1={spread:+.2f}%  (train {len(train):,}, test {len(test):,})")

    if not folds:
        sys.exit("no usable folds — dataset too small; let labels accumulate / widen --since")

    # final model on ALL data (for nightly scoring once the folds justify deploying it)
    final = lgb.train(
        {"objective": "regression", "num_leaves": 31, "learning_rate": 0.05,
         "feature_fraction": 0.8, "min_data_in_leaf": 200, "verbosity": -1},
        lgb.Dataset(df[FEATURES], label=df[TARGET]),
        num_boost_round=300,
    )
    final.save_model(str(OUT / "model.txt"))
    imp = sorted(zip(FEATURES, final.feature_importance("gain")), key=lambda x: -x[1])
    (OUT / "importance.txt").write_text("\n".join(f"{k}\t{v:.0f}" for k, v in imp))
    mean_ic = sum(f["ic"] for f in folds) / len(folds)
    (OUT / "metrics.json").write_text(json.dumps({"folds": folds, "mean_ic": round(mean_ic, 4),
                                                  "features": FEATURES, "target": TARGET,
                                                  "rows": len(df)}, indent=2))
    print(f"\nmean walk-forward IC: {mean_ic:+.4f}  ({len(folds)} folds, {len(df):,} rows)")
    print(f"saved: {OUT/'model.txt'}, metrics.json, importance.txt")
    verdict = ("DEPLOYABLE — stable positive IC" if mean_ic > 0.02 and all(f["ic"] > 0 for f in folds)
               else "NOT deployable yet — IC unstable or too weak; keep accumulating labels")
    print(f"verdict: {verdict}")

if __name__ == "__main__":
    main()

# REGIMES — causal regime engine (`engine.regimes`)

Phase 6. All labels are **causal**: the row at bar `t` uses only bars `<= t`. Thresholds are
**expanding quantiles of the indicator's own past values** (shifted one bar, >= 90 days of history),
never full-sample quantiles. Research output uses data strictly before `H2_START` (2025-10-01, sealed).

## API

```python
from engine.regimes import labels, label, transition_stats
df = labels(dataset)            # hourly DataFrame, one column per labeler
row = label(dataset, t)         # == labels(dataset.truncate(t)).iloc[-1] (computed on truncated data)
transition_stats(df["trend"])   # row-normalised transition matrix + share + mean spell length (bars)
```

## Labelers (`labelers.py`, hourly, leader = BTC perp)

| column | states | rule |
|---|---|---|
| trend | bull / bear / sideways | close vs SMA 30d vs SMA 90d (bull: c > s30 > s90; bear: c < s30 < s90) |
| vol | high / low | 7d realized vol vs expanding median of its past values |
| funding | high / negative / neutral | last BTC funding print: < 0 negative; > expanding p80 of past prints high |
| correlation | high / low / mid / breakdown | 30d mean alt-BTC corr vs expanding terciles; breakdown if 7d corr < 30d corr - 0.25 |
| leadership | btc_led / alt_led | BTC 30d log return minus equal-weight alt 30d log return (dominance proxy) |
| panic | panic / normal | 24h vol > 2x trailing 30d vol (lagged 24h) AND drawdown from 30d high < -10% |

## Statistical regimes

* **Gaussian HMM** (`hmm.py`): 2 states on daily BTC log returns, numpy Baum-Welch EM. Re-fit at every
  month start on days strictly before that month (expanding, warm-started). The label is the
  **filtered** probability `P(high-vol | r_1..r_d)` from a forward pass only; the module has no smoother
  and the backward pass is used only inside EM on the training window. States ordered by variance.
* **CUSUM** (`changepoint.py`): two-sided CUSUM on `r_d^2 / expanding-mean(r^2)_{d-1} - 1`, k=0.5, h=5,
  reset on alarm. Outputs `cp_flag` (+1 vol-up, -1 vol-down) and `days_since_cp`.
* Daily labels from day `d` are applied to the hours of day `d+1`.

## Tests (`tests/test_regimes.py`)

Truncation invariance of the whole label panel (incl. HMM), future-shock invariance, forward filter
independent of future observations, no smoother exposed, CUSUM detects a planted vol jump, transition
rows sum to 1.

## Results

`uv run python -m engine.regimes.report` -> `reports/regimes/summary.md` and `labels.parquet`
(2020-01-01 .. 2025-09-30). Highlights: trend bull 37% / sideways 40% / bear 23% (mean spell ~3 days);
HMM high-vol state 11% of labelled bars; panic 2.1%; 30 CUSUM vol-up alarms (e.g. 2020-03, 2021-05,
2022-05/06, 2022-11). Per-state next-hour BTC returns in the report are descriptive only, not a strategy.

# FEATURES — feature store (`engine.features`)

## Definition (`engine.features.registry.FeatureDef`)

`feature_id`, `calculation_version`, `inputs` (panel names such as `perp.close`, `funding`),
`function: Dataset -> wide DataFrame` (index = hourly bar open, columns = assets), `lookback_hours`,
`source`. Register with the `@feature(...)` decorator; list with `list_features()`.
Changing a formula requires bumping `calculation_version` (new cache file).

## Causality rule

Row t may use only `Dataset.truncate(t)`: bars with open <= t (closed by t+1h) and funding events
with ts <= t. Hence `availability_timestamp = t + 1h`. `tests/test_features.py` checks every
registered feature: `f(data.truncate(t)).loc[t] == f(data).loc[t]`, and that perturbing data after t
leaves every value at <= t unchanged.

## Stored record

`feature_id, asset, timestamp, availability_timestamp, value, source, calculation_version`
(non-NaN values only). Cache: `data/features/{feature_id}/v{n}.parquet` + `v{n}.meta.json`
(`input_hash` = sha256 of the input panels, `last_ts`). `FeatureStore.compute`:
same hash -> cache; history unchanged + new bars -> recompute only rows > last_ts from a slice
starting `lookback_hours + 24h` earlier; otherwise full recompute.

Cache safety (review D5): `input_hash` also covers the source of the feature function and of its
module (`code_hash`), so an edit without a version bump still forces a recompute. Writes go to
`*.tmp` then `os.replace` (parquet first, meta last); the meta stores `parquet_sha256` and
`code_sha256`, and a cache whose parquet does not match its meta (crash between the two writes) is
ignored. Incremental results are deduplicated on `(asset, timestamp)`. A per-feature
`v{n}.lock` file (O_EXCL, broken after 1h) serializes concurrent writers.

## Base features (v1)

Prices = perp close on real bars (filled bars -> NaN). Log returns. Vol in per-hour units.
Windows are hourly rows with full `min_periods`.

| id | definition |
|---|---|
| `ret_1h`, `ret_4h`, `ret_24h`, `ret_7d` | log(close_t / close_{t-h}), h = 1, 4, 24, 168 |
| `rv_24h`, `rv_7d` | std of 1h log returns over 24 / 168 rows |
| `vol_adj_mom_7d` | ret_7d / (rv_7d * sqrt(168)) |
| `volume_z_7d` | z-score of log(1+quote_volume) vs trailing 168 rows |
| `funding_z_90evt` | latest funding (ts <= t) z-scored vs last 90 events |
| `funding_change` | latest funding minus previous event |
| `basis_perp_spot` | perp_close / spot_close - 1 (both legs real) |
| `btc_ret_lag1h`, `btc_ret_lag2h` | BTC 1h return at t-1 / t-2, broadcast to every listed asset |
| `ethbtc_rs_7d` | ret_7d(ETH) - ret_7d(BTC), column `ETHBTC` |
| `btc_beta_7d`, `btc_corr_7d` | rolling 168-row beta / correlation of asset vs BTC 1h returns |
| `drawdown_30d` | close / max(close over trailing 720 rows) - 1 (v2: full 720-row window required; v1 used partial windows) |

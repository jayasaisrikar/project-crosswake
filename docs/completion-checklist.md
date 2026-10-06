# Crosswake MVP completion checklist

Updated 5 October 2026. This is an engineering checklist, separate from statistical and elapsed-time gates.

| Item                                               | Engineering state | Verification                                                              |
| -------------------------------------------------- | ----------------- | ------------------------------------------------------------------------- |
| Spot raw trades/BBO and 1-second Parquet           | Implemented       | Local disconnect/restart/replay; single-writer rejection; live collection |
| Public historical archives                         | Implemented       | Verified daily archive import, checksums and reproducibility              |
| Quant, impulse and candidate engine                | Implemented       | Causal fixtures and known beta/lag                                        |
| Multi-window relationship reports and lag controls | Implemented       | Block-shuffle maximum-grid controls and shifted clocks                    |
| Long-only fill simulator and costs                 | Implemented       | Future-quote exclusion, target semantics, fees/slippage                   |
| Fixed-horizon long/short research outcomes         | Implemented       | Exact horizons, gap censoring and separate research-only summaries        |
| Cost stress and size/volatility proxies            | Implemented       | Past-only inputs; unsupported participation rejected                      |
| Walk-forward and one-use holdout                   | Implemented       | Selection/leakage, interval reuse and provenance tests                    |
| Mastra research host                               | Implemented       | Thread/mode/messages, permissions and workflow parity                     |
| Persistent forward-paper recovery                  | Implemented       | Synthetic open-position and real chained-session parity                   |
| altFINS adapter/cache                              | Implemented       | Retrieval clocks, expiry, integrity and mocked authentication             |
| Local evidence API and dashboard                   | Implemented       | Production build; desktop/mobile, evidence dialog and keyboard checks     |
| Wall-clock operations reporting                    | Implemented       | CLI fixture verifies wall-clock downtime and sampled counter deltas       |

External checks still require RESEARCH_MODEL, provider credentials and ALTFINS_API_KEY in the local environment. No keys are configured in this session. Real provider calls are not marked verified. The default frozen protocol requires prospective October data; it has not been evaluated. No 24-hour collection result or profitable edge has been established. Actual execution/futures remain outside the MVP.

Current cost models use sampled BBO and past observed volume/volatility. They do not model full order-book depth or queue priority. Context is timestamped supplementary evidence; incremental context contribution must be measured out of sample before enabling a context-driven strategy. The current universe is a development seed, not an unbiased historical selection.

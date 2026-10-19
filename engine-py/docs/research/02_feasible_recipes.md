# 02 — Feasible with ONLY our data (OHLCV, quote volume, trade count, funding)

Rule: use recipes as published, or the canonical textbook form. **No tuning.** Parameters I could not verify
this session are marked [check PDF]: use the stated default and do not search over it.
All signals use daily closes resampled from 1h bars (UTC 00:00) and act on the next bar.

## A. TSMOM, Moskowitz-Ooi-Pedersen form (already built; check it matches)
- Signal_k = sign(return over the past k days), k in {20, 60, 120} (our current ensemble).
- Position_i = mean_k(Signal_k) * sigma_target / sigma_i, where sigma_i is the EWMA vol of daily returns with a
  60-day center of mass (the MOP convention) [K].

## B. Donchian-channel ensemble (Zarattini, Pagani & Barbon 2025)
- For each lookback N in the paper's fixed set [check PDF]: go long when close >= the N-day highest high; exit on
  the paper's trailing stop (channel midline or lower band) [check PDF]. If the PDF is unavailable, use the classic
  Turtle set {20, 55} without optimising it.
- Ensemble = average of the binary signals, a long/flat fraction in [0, 1].
- Inverse-vol sizing to a target vol, across every coin that is live at time t (respect delistings).
- Source: https://ideas.repec.org/p/chf/rpseri/rp2580.html

## C. Liu-Tsyvinski market momentum (weekly)
- Signal = sign of the past 1-4 week return; the paper tests horizons of 1, 2, 3 and 4 weeks [K].
- Add 7d and 28d as extra lookbacks in A rather than as a separate strategy, so the signal is not counted twice.

## D. Volatility overlay (Moreira-Muir / Harvey et al.)
- Scale by c / sigma (vol targeting) rather than c / sigma^2. It gives less turnover and behaves better in crypto.
- A gross leverage cap (e.g. 2x) is a risk constraint, not a fitted parameter.

## E. Funding carry with a cost threshold (BIS WP 1087 mechanics)
- Expected carry = trailing mean of the last 9 funding prints (3 days), annualised. This is our convention: the
  paper measures the basis and does not give a trading rule.
- Enter only when expected funding over the holding horizon exceeds round-trip cost on both legs. Exit when
  trailing funding turns negative. Both thresholds come from the cost model, not from fitting.

## F. Volume and trade count
- Liu-Tsyvinski-Wu's volume-based factors are subsumed by their 3-factor model [V]. **Do not add them as alpha.**
- Use quote volume as a liquidity filter (a fixed USD floor on the 30-day median) and in the impact model.

## Not feasible with our data
- Open interest, liquidations, order book, on-chain, and attention data such as Google Trends.

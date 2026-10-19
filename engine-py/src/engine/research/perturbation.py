"""Parameter-neighbourhood stability: a real edge should survive small parameter changes."""

from __future__ import annotations

import itertools
from collections.abc import Callable
from typing import Any

import numpy as np


def neighbors(params: dict[str, Any], grid: dict[str, list[Any]]) -> list[dict[str, Any]]:
    """All one-at-a-time neighbours: for each key in grid, each alternative value != current."""
    out = []
    for k, values in grid.items():
        for v in values:
            if params.get(k) != v:
                out.append({**params, k: v})
    return out


def full_grid(params: dict[str, Any], grid: dict[str, list[Any]]) -> list[dict[str, Any]]:
    keys = list(grid)
    return [{**params, **dict(zip(keys, combo, strict=True))}
            for combo in itertools.product(*(grid[k] for k in keys))]


def stability_score(neighbor_sharpes: list[float], base_sharpe: float | None = None) -> dict[str, float]:
    """frac_positive: share of neighbours with OOS Sharpe > 0 (NaN counts as not positive);
    dispersion: std of neighbour Sharpes; rel_dispersion: std / |base|."""
    s = np.asarray(neighbor_sharpes, dtype=float)
    if not len(s):
        return {"n_neighbors": 0, "frac_positive": float("nan"), "median": float("nan"),
                "dispersion": float("nan"), "rel_dispersion": float("nan")}
    fin = s[np.isfinite(s)]
    disp = float(np.std(fin, ddof=1)) if len(fin) > 1 else float("nan")
    return {
        "n_neighbors": int(len(s)),
        "frac_positive": float(np.mean(np.nan_to_num(s, nan=-1.0) > 0)),
        "median": float(np.median(fin)) if len(fin) else float("nan"),
        "dispersion": disp,
        "rel_dispersion": disp / abs(base_sharpe) if base_sharpe else float("nan"),
    }


def evaluate_neighborhood(params: dict[str, Any], grid: dict[str, list[Any]],
                          oos_sharpe: Callable[[dict[str, Any]], float],
                          base_sharpe: float | None = None) -> dict[str, Any]:
    nbrs = neighbors(params, grid)
    sharpes = [float(oos_sharpe(p)) for p in nbrs]
    return {**stability_score(sharpes, base_sharpe), "neighbor_sharpes": sharpes, "neighbors": nbrs}

"""Typed schema validation for config/*.yaml (review 04 finding 6).

Every known config file is checked at load time (`engine.pipeline.load_config` calls `validate`):

* unknown or misspelled keys fail loudly (`ConfigError` names the full dotted path and the
  allowed keys) instead of being silently ignored, e.g. `ensemble.enable` vs `ensemble.enabled`;
* value types are checked (int is accepted where a float is expected; bool is never a number);
* risk limits in live.yaml must lie in sane ranges (a drawdown kill switch of 2.0 or a negative
  daily loss limit is rejected).

The schema is a small declarative tree (no pydantic dependency): a `Spec` maps keys to a type,
a nested `Spec`, or a `Range`. `ANY_MAP` marks a free-form mapping (e.g. per-symbol overrides).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml


class ConfigError(ValueError):
    """A config file does not match its schema."""


@dataclass(frozen=True)
class Range:
    """A number constrained to [lo, hi] (either bound may be None)."""

    kind: type
    lo: float | None = None
    hi: float | None = None


@dataclass(frozen=True)
class Spec:
    """A mapping with a fixed key set. `required` keys must be present; `values` (if set) is the
    schema every value must satisfy when the key set is open (e.g. strategy name -> params)."""

    keys: dict[str, Any] = field(default_factory=dict)
    required: frozenset[str] = frozenset()
    values: Any = None


ANY_MAP = Spec(values=object)
NUM = (int, float)
OPT_STR = (str, type(None))
STR_LIST = list

_TREND_LIKE = {
    "enabled": bool, "market": str, "lookbacks_days": list, "vol_target_annual": NUM,
    "vol_lookback_days": int, "rebalance_hours": int, "max_gross_leverage": NUM,
    "max_weight_per_asset": NUM, "allow_short": bool,
}

STRATEGIES = Spec(keys={
    "trend": Spec(keys=_TREND_LIKE),
    "breakout": Spec(keys=_TREND_LIKE),
    "trend_regime": Spec(keys=_TREND_LIKE),
    "carry": Spec(keys={
        "enabled": bool, "entry_funding_annual": NUM, "exit_funding_annual": NUM,
        "funding_lookback_hours": int, "max_weight_per_asset": NUM, "max_gross": NUM, "max_basis": NUM,
        "rebalance_hours": int, "max_positions": int, "no_trade_band": NUM, "min_hold_days": NUM,
        "entry_cost_margin": NUM, "entry_fee_bps": ANY_MAP, "entry_half_spread_bps": ANY_MAP,
    }),
    "xsmom": Spec(keys={
        "enabled": bool, "market": str, "formation_days": int, "skip_days": int, "rebalance_hours": int,
        "vol_target_annual": NUM, "vol_lookback_days": int, "max_gross_leverage": NUM,
        "max_weight_per_asset": NUM,
    }),
    "leadlag": Spec(keys={
        "enabled": bool, "market": str, "leader": str, "k": NUM, "vol_lookback_bars": int,
        "hold_hours": int, "gross": NUM, "max_weight_per_asset": NUM, "allow_short": bool,
    }),
    "allocation": ANY_MAP,
})

EXPERIMENT = Spec(
    keys={
        "initial_capital": Range(float, 0.0, None),
        "costs": Spec(keys={
            "fee_bps": ANY_MAP, "spreads_file": str, "spread_stat": str,
            "half_spread_override_bps": ANY_MAP, "half_spread_bps": ANY_MAP,
            "impact_y": Range(float, 0.0, None), "stress_multiplier": Range(float, 0.0, None),
        }),
        "split": Spec(keys={"dev_end": str, "holdout_start": str}, required=frozenset({"dev_end"})),
        "walk_forward": Spec(keys={"train_months": int, "test_months": int, "embargo_bars": int}),
        "strategies": STRATEGIES,
    },
    required=frozenset({"costs", "split", "strategies"}),
)

LIVE = Spec(
    keys={
        "paper": Spec(keys={
            "initial_capital": Range(float, 0.0, None), "dir": str,
            "min_trade_frac": Range(float, 0.0, 1.0), "max_fill_lag_bars": Range(int, 0, None),
        }),
        "feed": Spec(keys={
            "history_days": Range(int, 1, None), "timeout_s": Range(float, 0.0, None),
            "retries": Range(int, 0, 20), "step_deadline_s": Range(float, 0.0, None), "cache_dir": str,
        }),
        "risk": Spec(keys={
            "max_drawdown": Range(float, 0.0, 1.0),
            "daily_loss_limit": Range(float, 0.0, 1.0),
            "stale_data_hours": Range(float, 0.0, 48.0),
            "max_exchange_errors": Range(int, 0, None),
            "max_gross_leverage": Range(float, 0.0, 10.0),
            "flatten_on_kill": bool,
            "reconcile_tolerance": Range(float, 0.0, 0.01),
            "stale_mark_tolerance": Range(float, 0.0, 1.0),
        }, required=frozenset({"max_drawdown", "daily_loss_limit", "max_gross_leverage"})),
        "monitor": Spec(keys={"log_predictions": bool}),
        "ensemble": Spec(keys={
            "enabled": bool, "min_samples": Range(int, 0, None), "prior_n": Range(int, 0, None),
            "horizon_hours": ANY_MAP, "no_trade": ANY_MAP, "risk": ANY_MAP,
        }),
    },
    required=frozenset({"paper", "risk"}),
)

UNIVERSE = Spec(
    keys={
        "quote": str, "interval": str, "start": str, "end": OPT_STR, "symbols": STR_LIST,
        "markets": STR_LIST, "discovery": ANY_MAP, "rules": ANY_MAP, "exclude": STR_LIST,
    },
    required=frozenset({"symbols"}),
)

SCHEMAS: dict[str, Spec] = {
    "live.yaml": LIVE,
    "experiment.yaml": EXPERIMENT,
    "universe.yaml": UNIVERSE,
    "universe_pit.yaml": UNIVERSE,
}


def _type_name(t: Any) -> str:
    if isinstance(t, tuple):
        return " | ".join(x.__name__ for x in t)
    return getattr(t, "__name__", str(t))


def _check_type(path: str, value: Any, t: Any) -> None:
    if t is object:
        return
    types = t if isinstance(t, tuple) else (t,)
    if isinstance(value, bool) and bool not in types:   # bool is an int subclass: never a number here
        raise ConfigError(f"{path}: expected {_type_name(t)}, got bool {value!r}")
    if not isinstance(value, types):
        raise ConfigError(f"{path}: expected {_type_name(t)}, got {type(value).__name__} {value!r}")


def _check(path: str, value: Any, schema: Any) -> None:
    if isinstance(schema, Spec):
        if not isinstance(value, dict):
            raise ConfigError(f"{path or '<root>'}: expected a mapping, got {type(value).__name__}")
        missing = sorted(schema.required - set(value))
        if missing:
            raise ConfigError(f"{path or '<root>'}: missing required key(s) {missing}")
        for k, v in value.items():
            sub = f"{path}.{k}" if path else str(k)
            if k in schema.keys:
                _check(sub, v, schema.keys[k])
            elif schema.values is not None:
                _check(sub, v, schema.values)
            else:
                raise ConfigError(f"{sub}: unknown key (allowed: {sorted(schema.keys)})")
    elif isinstance(schema, Range):
        kinds = NUM if schema.kind is float else (schema.kind,)
        _check_type(path, value, kinds)
        if schema.lo is not None and value < schema.lo:
            raise ConfigError(f"{path}: {value!r} is below the minimum {schema.lo}")
        if schema.hi is not None and value > schema.hi:
            raise ConfigError(f"{path}: {value!r} is above the maximum {schema.hi}")
    else:
        _check_type(path, value, NUM if schema is float else schema)


def validate(name: str, cfg: Any) -> Any:
    """Validate a parsed config named `name` (basename, e.g. "live.yaml"). Files without a schema
    pass through unchanged. Returns `cfg` so callers can chain it."""
    schema = SCHEMAS.get(Path(name).name)
    if schema is None:
        return cfg
    try:
        _check("", cfg, schema)
    except ConfigError as e:
        raise ConfigError(f"config/{Path(name).name}: {e}") from None
    return cfg


def load_validated(path: Path) -> Any:
    """Read a YAML file and validate it against its schema (by basename)."""
    return validate(path.name, yaml.safe_load(path.read_text(encoding="utf-8")))

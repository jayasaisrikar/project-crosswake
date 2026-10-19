"""Rule-based (keyword) event classifier. Deterministic; no LLM."""

from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import dataclass

# (event_type, keywords, importance, sentiment) - first match wins, order = priority
RULES: list[tuple[str, tuple[str, ...], float, float]] = [
    ("delisting", ("delist", "will remove", "cease trading", "removal of"), 0.9, -0.8),
    ("hack_exploit", ("hack", "exploit", "drained", "stolen", "attack"), 0.95, -0.9),
    ("regulatory", ("sec ", "lawsuit", "regulator", "ban", "sanction", "subpoena", "cftc"), 0.8, -0.5),
    ("listing", ("will list", "new listing", "lists ", "launchpool", "perpetual contract",
                 "adds "), 0.8, 0.6),
    ("maintenance", ("maintenance", "suspend deposit", "suspend withdrawal", "network upgrade"), 0.4, -0.1),
    ("token_unlock", ("unlock", "vesting", "token release"), 0.6, -0.4),
    ("partnership", ("partnership", "integrat", "collaborat"), 0.4, 0.3),
    ("funding_rate", ("funding rate", "funding interval"), 0.3, 0.0),
    ("macro", ("cpi", "fomc", "interest rate", "fed "), 0.7, 0.0),
]
POS = ("surge", "record high", "approve", "approval", "launch", "upgrade", "bullish", "gain")
NEG = ("plunge", "crash", "reject", "delay", "bearish", "loss", "fraud", "halt")


@dataclass(frozen=True)
class Classification:
    event_type: str
    importance: float
    sentiment: float
    affected_assets: tuple[str, ...]
    processed_text: str


def normalize(text: str) -> str:
    t = re.sub(r"<[^>]+>", " ", text)
    return re.sub(r"\s+", " ", t).strip().lower()


def find_assets(text: str, universe: Iterable[str]) -> tuple[str, ...]:
    """Tickers mentioned as whole words (e.g. 'BTC', 'BTCUSDT', '(SOL)'), case-sensitive on raw text."""
    found = []
    for a in sorted(set(universe)):
        if len(a) < 2:
            continue
        if re.search(rf"(?<![A-Z0-9]){re.escape(a)}(?:USDT|USDC|USD)?(?![A-Z0-9])", text):
            found.append(a)
    return tuple(found)


def classify(text: str, universe: Iterable[str] = ()) -> Classification:
    p = normalize(text)
    etype, imp, sent = "other", 0.2, 0.0
    for t, kws, i, s in RULES:
        if any(k in p for k in kws):
            etype, imp, sent = t, i, s
            break
    sent += 0.2 * sum(k in p for k in POS) - 0.2 * sum(k in p for k in NEG)
    return Classification(etype, imp, max(-1.0, min(1.0, sent)), find_assets(text, universe), p)


def novelty(text: str, prior: Iterable[str]) -> float:
    """1 - max Jaccard similarity (word sets) vs prior texts."""
    w = set(normalize(text).split())
    if not w:
        return 0.0
    best = 0.0
    for o in prior:
        ow = set(normalize(o).split())
        if ow:
            best = max(best, len(w & ow) / len(w | ow))
    return round(1.0 - best, 4)

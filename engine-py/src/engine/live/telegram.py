"""Daily signal message. Sent ONLY if --send AND TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID are set."""

from __future__ import annotations

import os
from collections.abc import Mapping
from typing import Any

import requests

from engine.live.signals_live import Weights

DISCLAIMER = ("Paper trading only. This is not financial advice; past performance (simulated or real) "
              "is not indicative of future results. Crypto is highly volatile; you can lose all capital.")


def _fmt_w(w: Weights) -> list[str]:
    lines = []
    for m in ("spot", "perp"):
        for s, v in sorted(w.get(m, {}).items(), key=lambda kv: -abs(kv[1])):
            lines.append(f"  {m:4s} {s:6s} {v:+.2%}")
    return lines or ["  (flat)"]


def action(current: float, target: float) -> str:
    """Plain-words action for one position change."""
    if abs(current) < 1e-12:
        return "OPEN LONG" if target > 0 else "OPEN SHORT"
    if abs(target) < 1e-12:
        return "CLOSE LONG" if current > 0 else "CLOSE SHORT"
    if (current > 0) != (target > 0):
        return "FLIP TO LONG" if target > 0 else "FLIP TO SHORT"
    return "ADD TO" if abs(target) > abs(current) else "TRIM"


def format_actions(changes: list[dict[str, Any]], min_change: float = 0.0025) -> list[str]:
    """Human trade calls: opens/closes/flips always; adds/trims only when >= min_change of equity."""
    out = []
    for c in changes:
        cur, tgt = float(c["current"]), float(c["target"])
        a = action(cur, tgt)
        if a in ("ADD TO", "TRIM") and abs(tgt - cur) < min_change:
            continue
        out.append(f"  {a} {c['symbol']} ({c['market']}): {cur:+.2%} -> {tgt:+.2%} of equity")
    return out


def format_message(asof: str, equity: float, combined: Weights, changes: list[dict[str, Any]],
                   risk_notes: list[str], sleeves: Mapping[str, Weights] | None = None,
                   version: str | None = None) -> str:
    head = f"Signal update {version} (UTC bar {asof})" if version else f"Signal update (UTC bar {asof})"
    out = [head, f"Paper equity: {equity:,.2f} USDT", "",
           "What to do (next hourly open):", *(format_actions(changes) or ["  nothing - hold positions"]),
           "", "Target weights (fraction of equity):", *_fmt_w(combined)]
    for name, w in (sleeves or {}).items():
        out += ["", f"Sleeve {name}:", *_fmt_w(w)]
    out += ["", "Changes vs current paper positions:"]
    out += [f"  {c['market']:4s} {c['symbol']:6s} {c['current']:+.2%} -> {c['target']:+.2%}"
            for c in changes] or ["  (none)"]
    out += ["", "Risk notes:", *[f"  - {n}" for n in risk_notes]] if risk_notes else []
    out += ["", DISCLAIMER]
    return "\n".join(out)


def maybe_send(text: str, send: bool, env: Mapping[str, str] | None = None,
               session: requests.Session | None = None, timeout: float = 15.0) -> bool:
    """Send via Telegram Bot API only if `send` and both env vars present; else print. Returns sent."""
    env = os.environ if env is None else env
    token, chat = env.get("TELEGRAM_BOT_TOKEN"), env.get("TELEGRAM_CHAT_ID")
    if not (send and token and chat):
        print(text)
        if send:
            print("[telegram] not sent: TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set")
        return False
    s = session or requests.Session()
    r = s.post(f"https://api.telegram.org/bot{token}/sendMessage",
               data={"chat_id": chat, "text": text, "disable_web_page_preview": "true"}, timeout=timeout)
    r.raise_for_status()
    return True

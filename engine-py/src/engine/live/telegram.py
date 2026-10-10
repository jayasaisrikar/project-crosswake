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


MAX_CHARS = 4000          # Telegram hard limit is 4096; keep a margin


def redact(text: str, env: Mapping[str, str] | None = None) -> str:
    """Remove secrets (bot token, any `bot<token>/` URL part) from text destined for logs."""
    import re

    env = os.environ if env is None else env
    out = re.sub(r"/bot[^/\s]+", "/bot<redacted>", str(text))
    for k in ("TELEGRAM_BOT_TOKEN",):
        v = env.get(k)
        if v:
            out = out.replace(v, "<redacted>")
    return out


def split_message(text: str, limit: int = MAX_CHARS) -> list[str]:
    """Split at line boundaries into chunks <= limit characters (a single long line is hard-cut)."""
    chunks: list[str] = []
    cur = ""
    for line in text.split("\n"):
        while len(line) > limit:
            if cur:
                chunks.append(cur)
                cur = ""
            chunks.append(line[:limit])
            line = line[limit:]
        cand = f"{cur}\n{line}" if cur else line
        if len(cand) > limit:
            chunks.append(cur)
            cur = line
        else:
            cur = cand
    if cur or not chunks:
        chunks.append(cur)
    return chunks


class SendError(RuntimeError):
    """Telegram send failed; the message never contains the token."""


def maybe_send(text: str, send: bool, env: Mapping[str, str] | None = None,
               session: requests.Session | None = None, timeout: float = 15.0) -> bool:
    """Send via Telegram Bot API only if `send` and both env vars present; else print. Returns sent.

    Long messages are split (<= 4000 chars each). Errors are re-raised as SendError with the token
    redacted, so it can never reach logs/live.log."""
    env = os.environ if env is None else env
    token, chat = env.get("TELEGRAM_BOT_TOKEN"), env.get("TELEGRAM_CHAT_ID")
    if not (send and token and chat):
        print(text)
        if send:
            print("[telegram] not sent: TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set")
        return False
    s = session or requests.Session()
    for part in split_message(text):
        try:
            r = s.post(f"https://api.telegram.org/bot{token}/sendMessage",
                       data={"chat_id": chat, "text": part, "disable_web_page_preview": "true"},
                       timeout=timeout)
            r.raise_for_status()
        except Exception as e:  # noqa: BLE001  (any error text may embed the URL with the token)
            raise SendError(redact(f"telegram send failed: {type(e).__name__}: {e}", env)) from None
    return True

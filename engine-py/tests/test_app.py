import json
import re
from html.parser import HTMLParser
from pathlib import Path

from engine.app import build
from engine.app.collect import collect
from engine.app.render import embed_json, render

SECTIONS = ["home", "market", "signals", "paper", "models", "research", "data", "glossary"]


def _data_blob(html: str) -> str:
    m = re.search(r'<script type="application/json" id="app-data">(.*?)</script>', html, re.S)
    assert m
    return m.group(1)


def test_collector_tolerates_empty_repo(tmp_path: Path) -> None:
    d = collect(tmp_path)
    assert d["paper"] == []
    assert d["market"]["assets"] == [] and d["market"]["regime"] is None
    assert d["signals"]["cards"] == []
    assert d["models"]["leaderboard"] == []
    assert d["research"]["hypotheses"] == [] and d["research"]["verdicts"] == []
    assert d["data"]["integrity"] is None
    assert "errors" not in d


def test_collector_reads_small_fixture(tmp_path: Path) -> None:
    p = tmp_path / "data/paper"
    p.mkdir(parents=True)
    rows = [json.dumps({"ts": f"2026-01-01T{h:02d}:00", "equity": 100000 + h}) for h in range(5)]
    (p / "equity.jsonl").write_text("\n".join(rows) + "\n{broken\n", encoding="utf-8")
    (p / "state.json").write_text(json.dumps({"initial_capital": 100000, "qty": {"perp": {"BTC": 1.0}}}))
    (tmp_path / "experiments").mkdir()
    (tmp_path / "experiments/exp_registry.jsonl").write_text(
        json.dumps({"id": "E1", "hypothesis_id": "H-1", "decision": "REJECT",
                    "results": {"oos_sharpe": 0.1}}) + "\n")
    d = collect(tmp_path)
    run = d["paper"][0]
    assert run["equity"][-1] == 100004 and run["positions"][0]["side"] == "long"
    assert run["sharpe"] is None  # too few points: show nothing rather than a fake number
    assert d["research"]["counts"]["REJECT"] == 1


def test_embed_json_is_script_safe() -> None:
    s = embed_json({"x": "</script><script>alert(1)</script> <!-- & https://evil.example"})
    assert "</script" not in s.lower() and "<!--" not in s and "https://" not in s
    assert json.loads(s)["x"].startswith("</script>")


def test_render_self_contained_and_complete(tmp_path: Path) -> None:
    html = render({**collect(tmp_path), "probe": "</script> http://x.example"})
    assert not re.search(r"https?://", html, re.I)
    assert not re.search(r"<(link|img|iframe)\b|\bsrc\s*=|@import|url\(", html, re.I)
    assert html.count("</script>") == 2
    for sec in SECTIONS:
        assert f"['{sec}'," in html  # every section is registered in the navigation
    for key in ("GLOSSARY", "guided tour", "localStorage", "prefers-color-scheme"):
        assert key.lower() in html.lower()
    json.loads(_data_blob(html))
    HTMLParser().feed(html)


def test_build_writes_file(tmp_path: Path) -> None:
    out = build(tmp_path, tmp_path / "app/index.html")
    assert out.exists() and out.stat().st_size < 5_000_000


def test_real_repo_build_under_5mb(tmp_path: Path) -> None:
    root = Path(__file__).resolve().parents[1]
    html = render(collect(root))
    assert len(html.encode("utf-8")) < 5_000_000
    assert not re.search(r"https?://", html, re.I)


def test_no_forecast_rows_are_missing_not_zero(tmp_path: Path) -> None:
    p = tmp_path / "data/paper"
    p.mkdir(parents=True)
    rows = [
        {"asset": "BTC", "model_id": "sleeve.trend", "expected_return": 0.0, "expected_cost": 0.0,
         "expected_net_edge": 0.0, "direction": 1, "features": {"weight": 0.1}, "signal_id": "a",
         "reason": "sleeve target weight (no return forecast)", "timestamp": "2026-01-01T00:00:00+00:00"},
        {"asset": "ETH", "model_id": "m1", "expected_return": 0.01, "expected_cost": 0.002,
         "expected_net_edge": 0.008, "direction": 1, "model_sources": ["m1"], "signal_id": "b",
         "timestamp": "2026-01-01T00:00:00+00:00"},
    ]
    (p / "predictions.jsonl").write_text("\n".join(json.dumps(r) for r in rows))
    (p / "resolutions.jsonl").write_text("\n".join(json.dumps({"signal_id": s, "realized_return": 0.001})
                                                   for s in "ab"))
    (p / "state.json").write_text(json.dumps({"initial_capital": 50000}))
    (p / "fills.jsonl").write_text("\n".join(json.dumps(f) for f in [
        {"side": "buy", "symbol": "BTC", "cost": 1.0, "notional": 100},
        {"side": "funding", "symbol": "BTC", "cost": -0.5}]))
    d = collect(tmp_path)
    by = {c["asset"]: c for c in d["signals"]["cards"]}
    assert by["BTC"]["has_forecast"] is False and by["BTC"]["expected_return"] is None
    assert by["BTC"]["net_edge"] is None and by["BTC"]["weight"] == 0.1
    assert by["ETH"]["has_forecast"] and by["ETH"]["net_edge"] == 0.008
    assert len(d["models"]["pred_vs_real"]) == 1 and d["models"]["n_resolved_no_forecast"] == 1
    run = d["paper"][0]
    assert run["initial"] == 50000 and run["n_trades"] == 1 and run["n_funding"] == 1
    assert run["total_cost"] == 1.0 and run["funding_net"] == -0.5


def test_leadlag_verdict_uses_registry(tmp_path: Path) -> None:
    (tmp_path / "experiments").mkdir()
    (tmp_path / "experiments/exp_registry.jsonl").write_text(json.dumps(
        {"id": "E1", "model_version": "leadlag_engine:BTC->ADA", "decision": "WATCH",
         "rejection_reason": "failed: dsr", "results": {"q_bh_43": 0.089, "n_pairs_tested": 43}}))
    d_ = tmp_path / "reports/leadlag/engine"
    d_.mkdir(parents=True)
    (d_ / "verdicts.csv").write_text(
        "pair,group,verdict,net_sharpe,n_trades\nBTC->ADA,g,EDGE EXISTS,1.4,600\n")
    v = collect(tmp_path)["research"]["verdicts"][0]
    assert v["registry_decision"] == "WATCH" and v["q_bh"] == 0.089 and v["n_pairs_tested"] == 43
    html = render(collect(tmp_path))
    assert "before multiple-testing correction" in html and "aria-modal" in html

# ruff: noqa: E501  (inline JS harness: long lines are intentional)
"""Browser smoke tests that EXECUTE the app's JS (headless Edge/Chrome via playwright-core under Node).

Skipped when Node, playwright-core or a Chromium-based browser is not available. To enable locally:
``npm install --prefix ~/.cache/engine-app-browser playwright-core@1.47.2`` (or set PLAYWRIGHT_CORE_DIR to a
folder whose node_modules contains playwright-core). Optional: ENGINE_APP_SHOTS=<dir> saves screenshots.
Everything runs on a local file:// page; nothing is uploaded.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest

from engine.app.collect import collect
from engine.app.render import write

ROOT = Path(__file__).resolve().parents[1]
SECTIONS = ["home", "market", "signals", "paper", "models", "research", "data", "glossary"]

BROWSERS = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    "/usr/bin/microsoft-edge", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
]

HARNESS = r"""
const path = require('path');
const { chromium } = require('playwright-core');
const [file, exe, shots] = process.argv.slice(2);
const SECTIONS = %SECTIONS%;
(async () => {
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  const out = [];
  for (const [vw, vh, tag] of [[1440, 900, 'd'], [390, 844, 'm']]) {
    for (const scheme of ['light', 'dark']) {
      const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, colorScheme: scheme });
      const page = await ctx.newPage();
      const errors = [];
      page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
      page.on('pageerror', e => errors.push(String(e)));
      await page.goto('file:///' + file.replace(/\\/g, '/'));
      const tourVisible1 = await page.evaluate(() => getComputedStyle(document.getElementById('tour')).display !== 'none');
      await page.keyboard.press('Escape');
      const focusAfterTour = await page.evaluate(() => document.activeElement && document.activeElement.id);
      await page.reload();
      const tourVisible2 = await page.evaluate(() => getComputedStyle(document.getElementById('tour')).display !== 'none');
      const res = { tag, scheme, errors, tourVisible1, tourVisible2, focusAfterTour, sections: {} };
      for (const s of SECTIONS) {
        await page.evaluate(id => { location.hash = id; }, s);
        await page.waitForTimeout(60);
        const r = await page.evaluate(id => {
          const el = document.getElementById(id);
          const nav = document.querySelector('.side');
          const h1 = el && el.querySelector('h1');
          const navB = nav.getBoundingClientRect(), h1B = h1 ? h1.getBoundingClientRect() : null;
          const a = document.querySelector('#stepDetail a, .banner a');
          return {
            visible: !!el && !el.hidden, textLen: el ? el.innerText.trim().length : 0,
            text: el ? el.innerText : '', overflow: document.documentElement.scrollWidth - window.innerWidth,
            h1Covered: !!(h1B && getComputedStyle(nav).position === 'sticky' && navB.bottom > h1B.top + 2 && navB.top <= 0 && window.innerWidth < 820),
            bigDots: Array.from(document.querySelectorAll('.dot')).filter(d => d.offsetWidth > 20).length,
            linkColor: a ? getComputedStyle(a).color : null, bg: getComputedStyle(document.body).backgroundColor,
            banner: (document.querySelector('.banner') || {}).innerText || ''
          };
        }, s);
        res.sections[s] = r;
        if (shots) await page.screenshot({ path: path.join(shots, `${tag}_${scheme}_${s}.png`), fullPage: true });
      }
      out.push(res);
      await ctx.close();
    }
  }
  await browser.close();
  process.stdout.write(JSON.stringify(out));
})().catch(e => { console.error(e); process.exit(2); });
"""


def _pw_dir() -> Path | None:
    for d in [os.environ.get("PLAYWRIGHT_CORE_DIR"), str(Path.home() / ".cache/engine-app-browser")]:
        if d and (Path(d) / "node_modules/playwright-core").exists():
            return Path(d)
    return None


def _browser() -> str | None:
    env = os.environ.get("ENGINE_APP_BROWSER")
    if env and Path(env).exists():
        return env
    return next((b for b in BROWSERS if Path(b).exists()), None)


@pytest.fixture(scope="module")
def runs(tmp_path_factory: pytest.TempPathFactory) -> list[dict[str, Any]]:
    node, pw, exe = shutil.which("node"), _pw_dir(), _browser()
    if not (node and pw and exe):
        pytest.skip("node + playwright-core + Edge/Chrome not available")
    tmp = tmp_path_factory.mktemp("appbrowser")
    html = write(collect(ROOT), tmp / "index.html")
    script = pw / "app_harness.cjs"
    script.write_text(HARNESS.replace("%SECTIONS%", json.dumps(SECTIONS)), encoding="utf-8")
    shots = os.environ.get("ENGINE_APP_SHOTS", "")
    if shots:
        Path(shots).mkdir(parents=True, exist_ok=True)
    proc = subprocess.run([node, str(script), str(html), exe, shots], capture_output=True, text=True,
                          timeout=240, cwd=pw, check=False)
    if proc.returncode != 0:
        pytest.skip(f"browser harness could not run: {proc.stderr[-400:]}")
    data: list[dict[str, Any]] = json.loads(proc.stdout)
    return data


def test_no_console_or_page_errors(runs: list[dict[str, Any]]) -> None:
    for r in runs:
        assert r["errors"] == [], (r["tag"], r["scheme"], r["errors"])


def test_all_sections_render(runs: list[dict[str, Any]]) -> None:
    for r in runs:
        for s in SECTIONS:
            sec = r["sections"][s]
            assert sec["visible"] and sec["textLen"] > 80, (r["tag"], s)
            assert "could not be drawn" not in sec["text"], (r["tag"], s)


def test_missing_forecasts_are_not_zero(runs: list[dict[str, Any]]) -> None:
    text = runs[0]["sections"]["signals"]["text"]
    assert "+0.00%" not in text and "0.00%" not in text
    d = collect(ROOT)
    if any(not c["has_forecast"] for c in d["signals"]["cards"]):
        assert "not available" in text


def test_no_uncorrected_edge_exists_chip(runs: list[dict[str, Any]]) -> None:
    for r in runs:
        for s in SECTIONS:
            assert "EDGE EXISTS" not in r["sections"][s]["text"].upper(), (r["tag"], s)
    research = runs[0]["sections"]["research"]["text"]
    if collect(ROOT)["research"]["verdicts"]:
        assert "multiple-testing caveat" in research.lower()


def test_no_horizontal_overflow_on_mobile(runs: list[dict[str, Any]]) -> None:
    for r in runs:
        for s in SECTIONS:
            assert r["sections"][s]["overflow"] <= 0, (r["tag"], r["scheme"], s, r["sections"][s]["overflow"])
            assert not r["sections"][s]["h1Covered"], (r["tag"], s)
            assert r["sections"][s]["bigDots"] == 0, (r["tag"], s)


def test_freshness_banner_and_tour_first_visit_only(runs: list[dict[str, Any]]) -> None:
    for r in runs:
        b = r["sections"]["home"]["banner"]
        assert "Snapshot, not live" in b and "Market data ends" in b and "page built" in b
        assert r["tourVisible1"] and not r["tourVisible2"]
        assert r["focusAfterTour"] == "tourBtn" or r["tag"] == "m"  # sidebar button is hidden on mobile


def test_dark_mode_links_use_accent(runs: list[dict[str, Any]]) -> None:
    dark = next(r for r in runs if r["tag"] == "d" and r["scheme"] == "dark")
    assert dark["sections"]["home"]["linkColor"] not in (None, "rgb(0, 0, 238)", "rgb(85, 26, 139)")

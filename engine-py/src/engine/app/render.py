# ruff: noqa: E501  (inline CSS/JS payload: long lines are intentional)
"""Render the collected data into ONE self-contained HTML file (inline CSS/JS/SVG, no external URLs).

The data is embedded as JSON inside ``<script type="application/json">``; the inline script builds the
page in the browser. Opened by double-clicking the file: no server, no network calls.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from engine.track.dashboard import CSS as BASE_CSS


def embed_json(data: Any) -> str:
    """JSON safe to place inside a <script> element (no '</script>', no '<!--', no URL schemes)."""
    s = json.dumps(data, ensure_ascii=False, allow_nan=False, default=str, separators=(",", ":"))
    s = (s.replace("&", "\\u0026").replace("<", "\\u003c").replace(">", "\\u003e")
         .replace("\u2028", "\\u2028").replace("\u2029", "\\u2029"))
    # Keep any URL text from the data from looking like an external reference (lossless JSON escape).
    return s.replace("://", ":\\/\\/")


APP_CSS = """
:root{--accent-soft:color-mix(in srgb,var(--accent) 12%,transparent);--shadow:0 1px 2px rgb(0 0 0/.06),0 6px 20px rgb(0 0 0/.06)}
body{min-height:100vh}
.app{display:grid;grid-template-columns:232px minmax(0,1fr);min-height:100vh}
.side{position:sticky;top:0;height:100vh;padding:22px 14px;border-right:1px solid var(--line);
display:flex;flex-direction:column;gap:4px;background:var(--bg)}
.brand{font-weight:700;font-size:16px;letter-spacing:-.01em;padding:0 10px 2px}
.brand small{display:block;font-weight:400;color:var(--mut);font-size:12px}
.paperflag{margin:10px 10px 14px;font-size:12px;color:var(--warn);border:1px solid currentColor;border-radius:8px;
padding:6px 8px;line-height:1.35}
.nav a{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:8px;color:var(--fg);
text-decoration:none;font-size:14px;min-height:40px}
.nav a:hover{background:var(--card)}
.nav a[aria-current="page"]{background:var(--accent-soft);color:var(--accent);font-weight:600}
.dot{display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;border-radius:50%;background:var(--line);
flex:none;font-size:10px;font-weight:700;line-height:1;color:var(--bg);padding:0;border:0}
.dot.st-ok{background:var(--good)}.dot.st-warn{background:var(--warn)}.dot.st-empty,.dot.st-na{background:var(--line);color:var(--fg)}.dot.st-bad{background:var(--bad)}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
a{color:var(--accent)}a:visited{color:var(--accent)}
.banner{border:1px solid var(--line);border-left:4px solid var(--accent);background:var(--card);border-radius:10px;padding:10px 14px;margin:0 0 18px;font-size:14px;line-height:1.5}
.banner.stale{border-left-color:var(--warn)}.banner.stale>b:first-child{color:var(--warn)}
.na{color:var(--mut);font-style:italic}.na-why{font-size:11.5px}
.unit{font-size:13px;font-weight:600;color:var(--mut)}
.wraptxt{text-align:left!important;white-space:normal!important;min-width:180px}
.caveat{border-left:4px solid var(--warn)}
.cmds{margin:6px 0;padding-left:22px}.cmds li{margin:4px 0}
.stt{display:block;font-size:11.5px;font-weight:600;margin-top:4px}
.side .foot{margin-top:auto;font-size:12px;color:var(--mut);padding:0 10px}
.side button{font:inherit}
main{max-width:1080px;width:100%;min-width:0;padding:28px 28px 90px}
.wrap{overflow-x:auto;max-width:100%}pre{white-space:pre-wrap;word-break:break-word}pre.scroll{overflow:auto;max-height:420px}
section,h2,dt{scroll-margin-top:16px}.kv{min-width:0}.kv span{overflow-wrap:break-word;min-width:0}.kv{grid-template-columns:minmax(0,1fr) minmax(0,auto)}.kv code{white-space:normal;overflow-wrap:anywhere}#stepDetail .kv{grid-template-columns:minmax(90px,1fr) minmax(0,2fr)}
section[hidden]{display:none}
.eyebrow{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--mut);font-weight:600;margin:0}
h1{font-size:30px;letter-spacing:-.02em;line-height:1.15;margin:4px 0 8px;text-wrap:balance}
.lede{font-size:16.5px;max-width:66ch;color:var(--fg);margin:0 0 18px}
h2{border-top:0;margin:28px 0 8px;padding-top:0}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(230px,1fr))}
.card{box-shadow:var(--shadow)}
.card h3{margin:0 0 4px;color:var(--fg);font-size:15px}
.big{font-size:26px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.chip{display:inline-flex;align-items:center;gap:6px;padding:2px 10px;border-radius:99px;font-size:12px;font-weight:600;
border:1px solid currentColor;white-space:nowrap}
.c-good{color:var(--good)}.c-bad{color:var(--bad)}.c-warn{color:var(--warn)}.c-mut{color:var(--mut)}.c-acc{color:var(--accent)}
.empty{border:1px dashed var(--line);border-radius:10px;padding:18px;color:var(--mut);background:transparent}
.empty b{color:var(--fg)}
code{font:12.5px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;background:var(--card);border:1px solid var(--line);
border-radius:5px;padding:1px 5px}
.term{border-bottom:1px dotted var(--mut);cursor:help}
#tip{position:fixed;z-index:50;max-width:300px;background:var(--fg);color:var(--bg);border-radius:8px;padding:8px 10px;
font-size:13px;line-height:1.4;box-shadow:var(--shadow);display:none}
#tip a{color:inherit;font-weight:600}
/* flow diagram */
.flow{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;counter-reset:s;margin:8px 0 14px}
.step{position:relative;text-align:left;background:var(--card);border:1px solid var(--line);border-radius:10px;
padding:10px 12px 10px 12px;cursor:pointer;color:var(--fg);font:inherit;min-height:64px;transition:border-color .2s,transform .2s}
.step:hover{transform:translateY(-1px);border-color:var(--mut)}
.step[aria-pressed="true"]{border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-soft)}
.step .n{font-size:11px;color:var(--mut);font-variant-numeric:tabular-nums}
.step b{display:block;font-size:14px;line-height:1.25;margin-top:2px}
.step .dot{position:absolute;top:10px;right:10px}
.step.pulse{border-color:var(--accent)}
.loopnote{font-size:13px;color:var(--mut)}
.detail{border-left:3px solid var(--accent)}
/* charts */
.chart{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px}
.spark{height:46px}
svg .ax{stroke:var(--line)}svg .ln{fill:none;stroke:var(--accent);stroke-width:2}
svg .ar{fill:var(--accent-soft)}svg .dd{fill:color-mix(in srgb,var(--bad) 22%,transparent);stroke:var(--bad);stroke-width:1.2}
svg .pt{fill:var(--accent);opacity:.6}
.regime{display:flex;gap:16px;align-items:center;flex-wrap:wrap}
.badge{font-size:22px;font-weight:700;padding:10px 18px;border-radius:12px;border:2px solid currentColor;letter-spacing:-.01em}
.sig{display:flex;flex-direction:column;gap:6px}
.sig .dir{font-size:20px;font-weight:700}
.kv{display:grid;grid-template-columns:1fr auto;gap:2px 10px;font-size:13px}
.kv span:nth-child(odd){color:var(--mut)}.kv span:nth-child(even){text-align:right;font-variant-numeric:tabular-nums}
.light{width:14px;height:14px;border-radius:50%;display:inline-block;box-shadow:inset 0 0 0 2px rgb(0 0 0/.08)}
details summary{cursor:pointer;color:var(--mut);font-size:13px}
dl.gl{display:grid;grid-template-columns:minmax(120px,200px) 1fr;gap:10px 18px;margin:0}
dl.gl dt{font-weight:700}dl.gl dd{margin:0;color:var(--fg)}
dl.gl dt:target,dl.gl dt.hl{color:var(--accent)}
.btn{font:inherit;font-size:14px;border-radius:8px;padding:8px 14px;min-height:40px;cursor:pointer;border:1px solid var(--line);
background:var(--card);color:var(--fg)}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--bg);font-weight:600}
#tour{position:fixed;z-index:60;right:20px;bottom:20px;width:min(380px,calc(100vw - 32px));background:var(--card);
border:1px solid var(--line);border-radius:12px;padding:16px;box-shadow:0 10px 40px rgb(0 0 0/.18);display:none}
#tour h3{margin:0 0 6px;color:var(--fg);font-size:16px}
#tour .prog{font-size:12px;color:var(--mut)}
.tour-hl{outline:3px solid var(--accent);outline-offset:3px;border-radius:8px}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
@media (max-width:820px){.app{grid-template-columns:1fr}.side{position:sticky;top:0;z-index:20;height:auto;
flex-direction:row;align-items:center;overflow-x:auto;padding:8px 12px;border-right:0;border-bottom:1px solid var(--line)}
.brand small,.paperflag,.side .foot{display:none}.nav{display:flex;gap:2px}.nav a{white-space:nowrap;padding:8px 10px}
main{padding:20px 16px 90px}dl.gl{grid-template-columns:1fr}h1{font-size:25px}
section,h2,dt,#refresh{scroll-margin-top:72px}.side{max-width:100vw}.brand{white-space:nowrap}.flow{grid-template-columns:repeat(auto-fill,minmax(140px,1fr))}}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
"""

HTML = """<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Engine App</title><style>__CSS__</style></head><body>
<div class="app">
<aside class="side" aria-label="Sections">
<div class="brand">Crypto Engine<small>Research &amp; paper trading</small></div>
<div class="paperflag">Simulated money only. This engine never places real orders.</div>
<nav class="nav" id="nav"></nav>
<div class="foot"><button class="btn" id="tourBtn" type="button">Take the tour</button>
<p><b>Snapshot, not live.</b> Built <span id="gen"></span>. <span id="age"></span><br>Refresh: run <code>engine download &amp;&amp; engine clean</code> and <code>engine live step</code>, then <code>engine app</code>. <a href="#refresh">Details</a><br>Local file, no network.</p></div>
</aside>
<main id="main"></main>
</div>
<div id="tip" role="tooltip"></div>
<div id="tour" role="dialog" aria-modal="true" aria-labelledby="tourTitle" aria-label="Guided tour"></div>
<script type="application/json" id="app-data">__DATA__</script>
<script>__JS__</script>
</body></html>"""


def render(data: dict[str, Any]) -> str:
    from engine.app.script import JS

    return (HTML.replace("__CSS__", BASE_CSS + APP_CSS)
            .replace("__JS__", JS)
            .replace("__DATA__", embed_json(data)))


def write(data: dict[str, Any], out: Path) -> Path:
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(render(data), encoding="utf-8")
    return out

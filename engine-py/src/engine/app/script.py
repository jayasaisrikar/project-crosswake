# ruff: noqa: E501  (inline CSS/JS payload: long lines are intentional)
"""Inline browser script for the app (plain JS, no libraries, no network)."""

JS = r"""
(function(){
'use strict';
var D = {};
try { D = JSON.parse(document.getElementById('app-data').textContent) || {}; } catch (e) { D = {}; }
var $ = function(s, r){ return (r || document).querySelector(s); };
function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
function isN(x){ return typeof x === 'number' && isFinite(x); }
function pct(x, d){ if (!isN(x)) return '—'; var v = (x * 100).toFixed(d == null ? 2 : d); if (+v === 0) return '0%'; return (x > 0 ? '+' : '') + v + '%'; }
function pctU(x, d){ return isN(x) ? (x * 100).toFixed(d == null ? 1 : d) + '%' : '—'; }
function num(x, d){ return isN(x) ? x.toLocaleString('en-US', {maximumFractionDigits: d == null ? 2 : d, minimumFractionDigits: d == null ? 0 : Math.min(d, 2)}) : '—'; }
function money(x){ return isN(x) ? (x < 0 ? '-$' : '$') + Math.abs(x).toLocaleString('en-US', {maximumFractionDigits: 0}) : '—'; }
function money2(x){ return isN(x) ? (x < 0 ? '-$' : '$') + Math.abs(x).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2}) : '—'; }
function cls(x){ return !isN(x) || x === 0 ? '' : (x > 0 ? 'c-good' : 'c-bad'); }
/* one timestamp format everywhere: YYYY-MM-DD HH:MM UTC (all stored times are UTC) */
function fmtTs(s){ s = String(s == null ? '' : s); if (!s || s === 'None' || s === 'null') return '—'; var m = s.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/); if (!m) return s; return m[2] ? m[1] + ' ' + m[2] + ' UTC' : m[1]; }
function fmtDate(s){ var t = fmtTs(s); return t === '—' ? t : t.slice(0, 10); }
function NA(why){ return '<span class="na">not available</span>' + (why ? '<span class="sub na-why"> (' + esc(why) + ')</span>' : ''); }

/* ---------------- glossary ---------------- */
var GL = {
  sharpe: ['Sharpe ratio', 'Average return divided by how much returns wobble, scaled to a year; above 1 is good, below 0 means losing on average.'],
  drawdown: ['Drawdown', 'How far the account has fallen from its highest point so far, in percent.'],
  maxdd: ['Max drawdown', 'The worst peak-to-bottom fall the account has had; the pain you would have sat through.'],
  funding: ['Funding rate', 'A small fee perpetual-futures traders pay each other every few hours; positive means longs pay shorts.'],
  edge: ['Edge', 'The return a signal expects to make on average before costs.'],
  netedge: ['Net edge', 'Expected move minus all trading costs; only a positive net edge is worth trading.'],
  cost: ['Trading cost', 'Fees, the bid/ask spread and price impact paid to get in and out of a trade.'],
  holdout: ['Holdout', 'A slice of history kept locked away so a strategy can be tested once on data it has never seen.'],
  overfitting: ['Overfitting', 'When a strategy is tuned so closely to past data that it learned noise and fails on new data.'],
  regime: ['Regime', 'The market\'s "weather": e.g. calm uptrend, choppy sideways, or volatile selloff.'],
  volatility: ['Volatility', 'How much prices swing; shown here as the yearly-scaled spread of hourly returns.'],
  paper: ['Paper trading', 'Trading with simulated money on market prices to see how a strategy would behave, with no real orders.'],
  perp: ['Perpetual future (perp)', 'A futures contract with no expiry that tracks the coin price, kept in line by funding payments.'],
  winrate: ['Win rate', 'The share of trades that made money; on its own it says nothing about how much.'],
  uphours: ['Hours in profit', 'The share of hourly steps in which the account value went up; shown only after 30 or more steps.'],
  oos: ['Out-of-sample (OOS)', 'Results measured on data the model was not fitted on; the only results that count.'],
  walkforward: ['Walk-forward', 'Fit on the past, test on the next slice, roll forward and repeat, like real life.'],
  dsr: ['Deflated Sharpe (DSR)', 'A Sharpe ratio adjusted for how many ideas were tried, so lucky winners are discounted.'],
  pbo: ['PBO', 'Probability of backtest overfitting: how often the "best" setting in-sample is below median out-of-sample.'],
  mtc: ['Multiple-testing correction', 'When many ideas are tested, some pass by luck. Corrections such as Benjamini-Hochberg (BH) raise the bar; a BH q-value above 0.05 means the result may be chance.'],
  confidence: ['Confidence', 'A calibrated probability that the direction is right; "not yet calibrated" until enough live results exist.'],
  leadlag: ['Lead-lag', 'The idea that one coin (e.g. BTC) moves first and others follow a little later.'],
  drift: ['Drift', 'When a model\'s live errors start behaving differently from what was seen in testing.'],
  health: ['Model health', 'A 0-100 score from live hit rate, profit, Sharpe and calibration that moves a model between states.'],
  hypothesis: ['Hypothesis', 'A specific, testable claim about the market written down before testing it.'],
  integrity: ['Data integrity', 'Automatic checks that price data has no gaps, duplicates, frozen bars or impossible values.'],
  equity: ['Equity', 'The total value of the simulated account: cash plus open positions marked to market.'],
  long: ['Long / short', 'Long profits if price rises; short profits if price falls.'],
  weight: ['Target weight', 'The share of the account the strategy wants in a coin; +10% means a long position worth a tenth of the account.'],
  bps: ['Basis point (bp)', 'One hundredth of a percent: 100 bp = 1%.']
};
function T(key, label){ var g = GL[key]; return '<span class="term" tabindex="0" aria-describedby="tip" data-term="' + key + '">' + esc(label || (g ? g[0] : key)) + '</span>'; }

function empty(msg, cmd){ return '<div class="empty"><b>Nothing here yet.</b> ' + msg + (cmd ? ' Run <code>' + esc(cmd) + '</code> to fill it.' : '') + '</div>'; }
function chip(text, tone){ return '<span class="chip c-' + (tone || 'mut') + '">' + esc(text) + '</span>'; }

/* ---------------- charts (inline SVG strings) ---------------- */
function spark(vals, w, h){
  w = w || 220; h = h || 46; if (!vals || vals.length < 2) return '';
  var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals), sp = (hi - lo) || 1;
  var pts = vals.map(function(v, i){ return (i * (w - 4) / (vals.length - 1) + 2).toFixed(1) + ',' + (2 + (hi - v) / sp * (h - 4)).toFixed(1); });
  var lx = pts[pts.length - 1].split(',');
  return '<svg class="spark" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" aria-hidden="true">'
    + '<polygon class="ar" points="2,' + h + ' ' + pts.join(' ') + ' ' + (w - 2) + ',' + h + '"/>'
    + '<polyline class="ln" points="' + pts.join(' ') + '"/><circle cx="' + lx[0] + '" cy="' + lx[1] + '" r="3" fill="var(--accent)"/></svg>';
}
function lineChart(ys, labels, opt){
  opt = opt || {}; var w = 960, h = opt.h || 220, px = 64, py = 14;
  if (!ys || ys.length < 2) return '';
  var lo = Math.min.apply(null, ys.concat(opt.base != null ? [opt.base] : [])), hi = Math.max.apply(null, ys.concat(opt.base != null ? [opt.base] : []));
  if (opt.zeroTop) { hi = 0; } var sp = (hi - lo) || 1;
  var X = function(i){ return px + i * (w - px - 10) / (ys.length - 1); };
  var Y = function(v){ return py + (hi - v) / sp * (h - 2 * py - 14); };
  var pts = ys.map(function(v, i){ return X(i).toFixed(1) + ',' + Y(v).toFixed(1); }).join(' ');
  var f = opt.fmt || function(v){ return num(v, 0); };
  var s = '<svg viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="' + esc(opt.label || 'chart') + '">';
  [hi, (hi + lo) / 2, lo].forEach(function(v){ s += '<line class="ax" x1="' + px + '" x2="' + (w - 10) + '" y1="' + Y(v).toFixed(1) + '" y2="' + Y(v).toFixed(1) + '" stroke-dasharray="2 4"/><text x="' + (px - 6) + '" y="' + (Y(v) + 4).toFixed(1) + '" text-anchor="end">' + esc(f(v)) + '</text>'; });
  if (opt.base != null) s += '<line x1="' + px + '" x2="' + (w - 10) + '" y1="' + Y(opt.base).toFixed(1) + '" y2="' + Y(opt.base).toFixed(1) + '" stroke="var(--mut)" stroke-dasharray="5 4"/>';
  var b = opt.zeroTop ? Y(0) : (h - py - 14);
  s += '<polygon class="' + (opt.dd ? 'dd' : 'ar') + '" points="' + X(0).toFixed(1) + ',' + b.toFixed(1) + ' ' + pts + ' ' + X(ys.length - 1).toFixed(1) + ',' + b.toFixed(1) + '"/>';
  if (!opt.dd) s += '<polyline class="ln" points="' + pts + '"/><circle cx="' + X(ys.length - 1).toFixed(1) + '" cy="' + Y(ys[ys.length - 1]).toFixed(1) + '" r="4" fill="var(--accent)"/>';
  if (labels && labels.length) s += '<text x="' + px + '" y="' + (h - 2) + '">' + esc(fmtTs(labels[0])) + '</text><text x="' + (w - 10) + '" y="' + (h - 2) + '" text-anchor="end">' + esc(fmtTs(labels[labels.length - 1])) + '</text>';
  return s + '</svg>';
}
function scatter(pts){
  var w = 520, h = 340, p = 52; if (!pts.length) return '';
  var m = 0; pts.forEach(function(q){ m = Math.max(m, Math.abs(q.predicted), Math.abs(q.actual)); }); m = m || 0.01;
  var S = function(v, size){ return p + (v + m) / (2 * m) * (size - 2 * p); };
  var s = '<svg viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="predicted versus actual return">';
  s += '<line class="ax" x1="' + p + '" x2="' + (w - p) + '" y1="' + (h - S(0, h)) + '" y2="' + (h - S(0, h)) + '"/><line class="ax" y1="' + p + '" y2="' + (h - p) + '" x1="' + S(0, w) + '" x2="' + S(0, w) + '"/>';
  s += '<line x1="' + S(-m, w) + '" y1="' + (h - S(-m, h)) + '" x2="' + S(m, w) + '" y2="' + (h - S(m, h)) + '" stroke="var(--mut)" stroke-dasharray="4 4"/>';
  [-m, 0, m].forEach(function(v){
    s += '<text x="' + S(v, w).toFixed(1) + '" y="' + (h - p + 16) + '" text-anchor="middle">' + esc(pct(v, 2)) + '</text>';
    s += '<text x="' + (p - 6) + '" y="' + (h - S(v, h) + 4).toFixed(1) + '" text-anchor="end">' + esc(pct(v, 2)) + '</text>';
  });
  pts.forEach(function(q){ s += '<circle class="pt" r="3.2" cx="' + S(q.predicted, w).toFixed(1) + '" cy="' + (h - S(q.actual, h)).toFixed(1) + '"/>'; });
  s += '<text x="' + (w / 2) + '" y="' + (h - 6) + '" text-anchor="middle">predicted move (%) →</text><text x="12" y="' + (h / 2) + '" transform="rotate(-90 12 ' + (h / 2) + ')" text-anchor="middle">actual move (%) →</text>';
  return s + '</svg>';
}
function bars(items){
  var max = 1; items.forEach(function(i){ max = Math.max(max, i.n); });
  return '<div style="display:grid;gap:8px">' + items.map(function(i){
    return '<div><div class="row" style="justify-content:space-between"><span>' + chip(i.label, i.tone) + '</span><b>' + i.n + '</b></div>'
      + '<div style="height:8px;background:var(--line);border-radius:99px;margin-top:4px"><div style="height:8px;border-radius:99px;width:' + (i.n / max * 100).toFixed(1) + '%;background:currentColor" class="c-' + i.tone + '"></div></div></div>';
  }).join('') + '</div>';
}

/* ---------------- derived state ---------------- */
var paper = D.paper || [], mk = D.market || {}, sg = D.signals || {}, md = D.models || {}, rs = D.research || {}, dh = D.data || {}, FR = D.freshness || {};
var v1 = paper.filter(function(p){ return p.id === 'v001'; })[0] || paper[0];
var integ = dh.integrity;
var allCards = sg.cards || [];
var nForecast = allCards.filter(function(c){ return c.has_forecast && isN(c.net_edge); }).length;
var counts = rs.counts || {};
var verdicts = rs.verdicts || [];
var promoted = counts.PROMOTE || 0;
function st(ok, warn){ return ok ? (warn ? 'warn' : 'ok') : 'empty'; }

/* Status = real evidence, never "a file exists". Each step carries the reason shown next to its status. */
var STEPS = [
  {k:'data', t:'Market data', s:'market', what:'Downloads hourly prices and funding payments for Binance coins and stores them on this computer.',
   feeds:'data.binance.vision archives → data/cleaned/', cmd:'engine download && engine clean',
   status: !(mk.assets || []).length ? 'empty' : (FR.stale ? 'warn' : 'ok'),
   why: !(mk.assets || []).length ? 'No stored prices.' : (FR.stale ? 'Stored prices end ' + fmtTs(FR.data_end) + ', ' + FR.data_age_days + ' days before this page was built.' : 'Prices are up to date (less than a day old).')},
  {k:'check', t:'Check data', s:'data', what:'Looks for gaps, duplicates, frozen prices and impossible values before anything else uses the data.',
   feeds:'reports/data_integrity.json', cmd:'engine data validate',
   status: integ ? (integ.ok ? 'ok' : 'warn') : 'empty', why: integ ? (integ.ok ? 'All integrity checks pass.' : 'The integrity report lists open issues.') : 'No integrity report.'},
  {k:'feat', t:'Features', s:'research', what:'Turns raw prices into simple measurements such as "return over the last week" or "how jumpy prices are".',
   feeds:'feature registry (engine features list)', cmd:'engine features list',
   status: 'na', why: 'This app does not read a feature artifact, so it cannot tell whether features are current.'},
  {k:'models', t:'Models', s:'models', what:'Each model reads the features and makes a forecast: up, down or no view, and by how much.',
   feeds:'experiments/exp_registry.jsonl', cmd:'engine research run',
   status: !md.n_experiments ? 'empty' : (promoted ? 'ok' : 'warn'), why: !md.n_experiments ? 'No experiments recorded.' : (promoted ? promoted + ' model(s) passed every gate.' : 'No experiment has passed every gate yet (0 promoted).')},
  {k:'combine', t:'Combine', s:'signals', what:'Blends several models into one view per coin, giving more weight to the ones that have earned it.',
   feeds:'prediction ledger / paper targets', cmd:'engine live step',
   status: !allCards.length ? 'empty' : (nForecast ? 'ok' : 'warn'), why: !allCards.length ? 'No targets recorded.' : (nForecast ? nForecast + ' coin views carry a model forecast.' : 'Only target weights are recorded; no blended return forecast yet.')},
  {k:'edge', t:'Is the edge worth the cost?', s:'signals', what:'Compares the expected move with fees, spread and funding. If costs eat the move, the answer is "stay out".',
   feeds:'data/paper/predictions.jsonl (expected_net_edge)', cmd:'engine live step',
   status: !allCards.length ? 'empty' : (nForecast ? 'ok' : 'warn'), why: nForecast ? nForecast + ' views have a net-edge forecast.' : 'No cost-vs-edge forecasts yet: the ledger rows are target weights without a return forecast.'},
  {k:'risk', t:'Risk', s:'paper', what:'Caps how big any position can be, targets a calm level of swings and halts trading after a large loss.',
   feeds:'config/live.yaml limits', cmd:'engine live step',
   status: v1 ? ((v1.halt || v1.killed) ? 'warn' : 'ok') : 'empty', why: v1 ? ((v1.halt || v1.killed) ? 'A risk stop is active.' : 'No risk stop is active.') : 'Paper trading has not started.'},
  {k:'paper', t:'Paper trade', s:'paper', what:'Places simulated trades at real prices, paying realistic costs. No real money moves.',
   feeds:'data/paper/*.jsonl', cmd:'engine live step',
   status: !paper.length ? 'empty' : (FR.paper_last_step ? 'ok' : 'warn'), why: paper.length ? 'Last simulated step ' + fmtTs(FR.paper_last_step) + '.' : 'Paper trading has not started.'},
  {k:'compare', t:'Prediction vs reality', s:'models', what:'When a forecast\'s time is up, writes down what really happened next to what was predicted.',
   feeds:'data/paper/resolutions.jsonl', cmd:'engine monitor resolve',
   status: (md.pred_vs_real || []).length ? 'ok' : (md.n_resolved_no_forecast ? 'warn' : 'empty'),
   why: (md.pred_vs_real || []).length ? (md.pred_vs_real.length + ' forecasts compared with reality.') : (md.n_resolved_no_forecast ? md.n_resolved_no_forecast + ' rows resolved, but none carried a return forecast to compare.' : 'Nothing resolved yet.')},
  {k:'health', t:'Health & drift', s:'models', what:'Scores each model on its live record and demotes it (ACTIVE → WARNING → …) if it starts failing.',
   feeds:'data/paper/model_health.json', cmd:'engine monitor drift',
   status: st((md.health || []).length > 0), why: (md.health || []).length ? 'Health states recorded.' : 'No model has a live track record yet.'},
  {k:'research', t:'New research', s:'research', what:'Failures and drift become new written hypotheses, tested strictly on old data before anything goes live.',
   feeds:'research/hypotheses_seed.yaml, experiments/', cmd:'engine research run',
   status: st((rs.hypotheses || []).length > 0), why: (rs.hypotheses || []).length ? (rs.hypotheses.length + ' hypotheses written down.') : 'No hypotheses file.'}
];
var STATUS_TXT = {ok:['Working', 'good'], warn:['Needs attention', 'warn'], empty:['No data yet', 'mut'], na:['Not tracked here', 'mut']};
var STATUS_ICON = {ok:'✓', warn:'!', empty:'–', na:'?'};
function dot(status, extra){ var t = STATUS_TXT[status]; return '<span class="dot st-' + status + (extra ? ' ' + extra : '') + '" title="' + esc(t[0]) + '" aria-hidden="true">' + STATUS_ICON[status] + '</span><span class="sr-only">Status: ' + esc(t[0]) + '.</span>'; }

var SECTIONS = [
  ['home', 'What is this?'], ['market', 'Market'], ['signals', 'Signals today'], ['paper', 'Paper trading'],
  ['models', 'Models'], ['research', 'Research lab'], ['data', 'Data health'], ['glossary', 'Glossary']
];
function secStatus(id){
  var m = {market: !(mk.assets || []).length ? 'empty' : (FR.stale ? 'warn' : 'ok'),
    signals: !allCards.length ? 'empty' : (nForecast ? 'ok' : 'warn'),
    paper: st(paper.length > 0, v1 && (v1.halt || v1.killed)),
    models: !md.n_experiments ? 'empty' : (promoted && (md.health || []).length ? 'ok' : 'warn'),
    research: st((rs.hypotheses || []).length > 0), data: integ ? (integ.ok ? 'ok' : 'warn') : 'empty'};
  return m[id] || '';
}

/* ---------------- freshness + refresh ---------------- */
function banner(){
  var stale = FR.stale;
  return '<div class="banner ' + (stale ? 'stale' : '') + '" role="note" aria-label="Data freshness"><b>' + (stale ? 'Snapshot, not live. Market data is ' + esc(FR.data_age_days) + ' days old.' : 'Snapshot, not live.') + '</b> '
    + '<span>Market data ends <b>' + esc(fmtTs(FR.data_end)) + '</b> · page built <b>' + esc(fmtTs(FR.generated_at)) + '</b> · paper trading last step <b>' + esc(fmtTs(FR.paper_last_step)) + '</b>'
    + (FR.regime_asof ? ' · regime label as of <b>' + esc(fmtDate(FR.regime_asof)) + '</b> (research data, before sealed holdout)' : '') + '.</span> <a href="#refresh">How to refresh</a></div>';
}
var REFRESH = [
  ['Download and clean new market data', 'engine download && engine clean'],
  ['Re-check the data', 'engine data validate'],
  ['Advance paper trading by one step (simulated)', 'engine live step'],
  ['Compare finished forecasts with reality', 'engine monitor resolve'],
  ['Rebuild this page', 'engine app']
];
function refreshPanel(){
  return '<h2 id="refresh" tabindex="-1">How to refresh this page</h2><div class="card"><p style="margin-top:0">This page is a snapshot built from files on this computer. It never updates by itself and makes no network calls. To bring it up to date, run these in the project folder, in order:</p><ol class="cmds">'
    + REFRESH.map(function(r){ return '<li>' + esc(r[0]) + ': <code>' + esc(r[1]) + '</code></li>'; }).join('') + '</ol><p class="sub" style="margin-bottom:0">Then reload this file in the browser.</p></div>';
}

/* ---------------- sections ---------------- */
function home(){
  var h = '<p class="eyebrow">Start here</p><h1>A research lab that tests trading ideas, then paper-trades the survivors.</h1>'
    + '<p class="lede">This engine collects crypto prices, checks them, turns them into forecasts, and asks one honest question: '
    + '<i>is the expected ' + T('edge', 'edge') + ' bigger than the ' + T('cost', 'cost') + ' of trading?</i> '
    + 'If yes, it trades with simulated money (' + T('paper', 'paper trading') + ') and later compares each prediction with what actually happened. '
    + 'Models that stop working are demoted, and their failures become new research.</p>'
    + '<h2>How the loop works</h2><p class="loopnote">Tap a step to see what it does, whether it is working, and where its data comes from. The last step feeds back into the first. Status: ✓ working, ! needs attention, – no data yet, ? not tracked here.</p>'
    + '<div class="flow" id="flow">' + STEPS.map(function(s, i){
        return '<button class="step" type="button" data-i="' + i + '" aria-pressed="false"><span class="n">Step ' + (i + 1) + (i === STEPS.length - 1 ? ' ↺' : ' →') + '</span><b>' + esc(s.t) + '</b><span class="stt c-' + STATUS_TXT[s.status][1] + '">' + esc(STATUS_TXT[s.status][0]) + '</span>' + dot(s.status) + '</button>';
      }).join('') + '</div><div class="card detail" id="stepDetail" aria-live="polite"></div>';
  var eqTxt = v1 && isN(v1.total_return) ? '<span class="' + cls(v1.total_return) + '">' + pct(v1.total_return) + '</span> since start' : 'not started';
  var r = mk.regime;
  h += '<h2>At a glance</h2><div class="grid">'
    + '<div class="card"><span class="sub">Paper account (' + esc(v1 ? v1.id : 'v001') + ')</span><div class="big">' + (v1 && v1.equity.length ? money(v1.equity[v1.equity.length - 1]) : '—') + '</div><span class="sub">' + eqTxt + '</span></div>'
    + '<div class="card"><span class="sub">Experiments run</span><div class="big">' + (rs.n_experiments || 0) + '</div><span class="sub">' + (rs.counts ? (counts.PROMOTE || 0) + ' promoted, ' + (counts.WATCH || 0) + ' watch, ' + (counts.INCONCLUSIVE || 0) + ' inconclusive, ' + (counts.REJECT || 0) + ' rejected' : '') + '</span></div>'
    + '<div class="card"><span class="sub">Data checks</span><div class="big ' + (integ ? (integ.ok ? 'c-good' : 'c-warn') : '') + '">' + (integ ? (integ.ok ? 'Passing' : 'Issues found') : '—') + '</div><span class="sub">' + (integ ? 'see Data health' : 'run engine data validate') + '</span></div>'
    + '<div class="card"><span class="sub">Last labelled ' + T('regime', 'regime') + '</span><div class="big c-mut" style="font-size:20px">' + (r ? esc(regimeName(r)[0]) : '—') + '</div><span class="sub">' + (r ? 'as of ' + esc(fmtDate(r.asof)) + ' (research data, before sealed holdout); not today\'s market' : 'run engine regimes') + '</span></div></div>';
  return h + refreshPanel();
}
function showStep(i){
  var s = STEPS[i], t = STATUS_TXT[s.status];
  document.querySelectorAll('#flow .step').forEach(function(b){ b.setAttribute('aria-pressed', String(+b.dataset.i === i)); });
  $('#stepDetail').innerHTML = '<div class="row" style="justify-content:space-between"><h3 style="margin:0">Step ' + (i + 1) + ': ' + esc(s.t) + '</h3>' + chip(t[0], t[1]) + '</div>'
    + '<p>' + esc(s.what) + '</p><p class="sub">Why this status: ' + esc(s.why) + '</p><div class="kv"><span>Data it uses / writes</span><span><code>' + esc(s.feeds) + '</code></span>'
    + '<span>Command that runs it</span><span><code>' + esc(s.cmd) + '</code></span></div>'
    + '<p><a href="#' + s.s + '">Open the related section →</a></p>';
}

function regimeName(r){
  var tr = r.trend, vo = r.vol;
  var calm = vo === 'low', a = calm ? 'Calm' : (vo === 'high' ? 'Volatile' : '');
  var map = {bull:['uptrend', 'prices had been rising; trend-following tends to be on the right side.', 'good'],
    bear:['downtrend', 'prices had been falling; long positions are riskier.', 'bad'],
    sideways:['sideways', 'no clear direction; trend signals are weaker and more likely to flip.', 'warn']};
  var m = map[tr] || [String(tr || 'unknown'), 'not enough history to label this.', 'mut'];
  var name = (a ? a + ' ' : '') + m[0];
  var extra = calm ? ' Swings were smaller than usual.' : (vo === 'high' ? ' Swings were larger than usual, so position sizes shrink.' : '');
  return [name.charAt(0).toUpperCase() + name.slice(1), m[1].charAt(0).toUpperCase() + m[1].slice(1) + extra, m[2]];
}

function market(){
  var h = '<p class="eyebrow">Market</p><h1>What the market was doing</h1><p class="lede">Prices of the biggest coins over the last 90 days of <b>stored</b> data, how jumpy they are (' + T('volatility', 'volatility') + ') and the ' + T('funding', 'funding rate') + ' on ' + T('perp', 'perpetual futures') + '. These are not live prices.</p>';
  if (FR.stale) h += '<div class="card c-warn"><b>Market data ends ' + esc(fmtTs(FR.data_end)) + ' (' + esc(FR.data_age_days) + ' days old).</b> <span style="color:var(--fg)">Run <code>engine download && engine clean</code>, then <code>engine app</code>.</span></div>';
  if (mk.regime) {
    var rn = regimeName(mk.regime);
    h += '<div class="card regime"><span class="badge c-mut">' + esc(rn[0]) + '</span><div><b>' + T('regime', 'Last labelled regime') + ' (as of ' + esc(fmtDate(mk.regime.asof)) + ', research data only)</b><p style="margin:2px 0">' + esc(rn[0]) + ': ' + esc(rn[1]) + '</p><span class="sub">Regime labels stop at ' + esc(fmtTs(mk.regime.asof)) + ', before the sealed holdout, so this is history, not the current market.'
      + (mk.regime.panic != null ? ' Panic flag: ' + esc(mk.regime.panic) + '.' : '') + (mk.regime.funding ? ' Funding state: ' + esc(mk.regime.funding) + '.' : '') + '</span></div></div>';
  } else h += empty('No market regime has been labelled.', 'engine regimes');
  var as = mk.assets || [];
  if (!as.length) return h + empty('No stored price history found.', 'engine download && engine clean');
  h += '<div class="grid" style="margin-top:12px">' + as.map(function(a){
    var fd = isN(a.funding_apr_7d) ? '<span class="' + (a.funding_apr_7d > 0 ? 'c-warn' : 'c-good') + '">' + pct(a.funding_apr_7d, 1) + ' / yr</span>' : '—';
    return '<div class="card"><div class="row" style="justify-content:space-between"><h3>' + esc(a.symbol) + '</h3><span><span class="' + cls(a.change_90d) + '">' + pct(a.change_90d, 1) + '</span> <span class="sub">90d</span></span></div>'
      + '<div class="big">' + num(a.last, a.last < 10 ? 4 : 2) + ' <span class="unit">' + esc(a.quote || 'USDT') + '</span></div>' + spark(a.closes)
      + '<div class="kv"><span>' + T('volatility', '30-day volatility') + '</span><span>' + pctU(a.vol_30d, 0) + '</span><span>' + T('funding', 'Funding (7d avg)') + '</span><span>' + fd + '</span></div>'
      + '<span class="sub">Change since ' + esc(fmtTs(a.change_since)) + '. Data up to ' + esc(fmtTs(a.asof)) + '.</span></div>';
  }).join('') + '</div>';
  return h;
}

function signals(){
  var h = '<p class="eyebrow">Signals today</p><h1>What the engine wants to hold</h1><p class="lede">One card per coin and strategy version. "Long" means the engine holds a ' + T('long', 'long') + ' position, "Short" a short, "Flat" no position. A trade is only worth it when the ' + T('netedge', 'net edge') + ' is positive.</p>';
  var vs = sg.versions || [];
  if (!vs.length) return h + empty('No forecasts or paper targets have been recorded.', 'engine live step');
  h += '<p class="sub">Versions shown: ' + vs.map(function(v){ return esc(v.id) + ' (' + v.cards.length + ' coins)'; }).join(', ') + '.</p>';
  vs.forEach(function(v){
    h += '<h2>' + esc(v.id) + (v.name ? ' · ' + esc(v.name) : '') + ' <span class="sub">' + v.cards.length + ' coins</span></h2>';
    if (!v.n_forecasts) h += '<div class="card"><b>No return forecasts recorded for ' + esc(v.id) + '.</b> <span class="sub">Its ledger rows hold the ' + T('weight', 'target weight') + ' per coin only, so expected move, cost and net edge are shown as "not available" (they are not zero). They fill in once a model writes real forecasts to the prediction ledger.' + (v.halt ? ' <b class="c-warn">Trading is currently halted by the risk layer.</b>' : '') + '</span></div>';
    h += '<div class="grid">' + v.cards.map(function(c){
      var dir = c.direction > 0 ? ['Long', 'good'] : c.direction < 0 ? ['Short', 'bad'] : ['Flat', 'mut'];
      var why = c.missing_reason ? 'target weight only, no return forecast' : '';
      var conf = isN(c.confidence) ? pctU(c.confidence, 0) : '<span class="c-mut">not yet calibrated</span>';
      return '<div class="card sig"><div class="row" style="justify-content:space-between"><h3>' + esc(c.asset) + '</h3><span class="sub">' + esc(c.version) + ' · ' + esc(c.model) + '</span></div>'
        + '<div class="dir c-' + dir[1] + '">' + dir[0] + '</div>'
        + '<div class="kv"><span>' + T('weight', 'Target weight') + '</span><span>' + (isN(c.weight) ? pct(c.weight, 2) : NA('not recorded')) + '</span>'
        + '<span>Expected move</span><span>' + (c.has_forecast && isN(c.expected_return) ? pct(c.expected_return) : NA()) + '</span>'
        + '<span>' + T('cost', 'Cost') + '</span><span>' + (c.has_forecast && isN(c.expected_cost) ? pctU(c.expected_cost, 2) : NA()) + '</span>'
        + '<span>' + T('netedge', 'Net edge') + '</span><span class="' + (c.has_forecast ? cls(c.net_edge) : '') + '">' + (c.has_forecast && isN(c.net_edge) ? pct(c.net_edge) : NA()) + '</span>'
        + '<span>' + T('confidence', 'Confidence') + '</span><span>' + conf + '</span></div>'
        + (why ? '<p class="sub" style="margin:2px 0 0">Not available because: ' + esc(why) + '.</p>' : '') + '<span class="sub">As of ' + esc(fmtTs(c.ts)) + '</span></div>';
    }).join('') + '</div>';
  });
  return h;
}

function paperSec(){
  var init = v1 ? money(v1.initial) : 'a simulated';
  var h = '<p class="eyebrow">Paper trading</p><h1>The simulated account</h1><p class="lede"><b>Simulated money, no real orders.</b> The engine pretends to trade ' + init + ' at real market prices and pays realistic costs, so we can see how the strategy behaves before any real money is involved.</p>';
  if (!paper.length) return h + empty('Paper trading has not started.', 'engine live step');
  paper.forEach(function(p){
    var n = p.equity.length, fnet = p.funding_net;
    var fTxt = isN(fnet) ? (fnet > 0 ? money2(fnet) + ' paid' : fnet < 0 ? money2(-fnet) + ' received' : '$0.00') : '—';
    h += '<h2>' + esc(p.id) + (p.name ? ' · ' + esc(p.name) : '') + '</h2><p class="sub">Started with ' + money(p.initial) + '. Last step ' + esc(fmtTs(p.last_bar)) + '.</p>';
    if (p.killed || p.halt) h += '<div class="card c-warn"><b>Risk stop active.</b> ' + esc((p.reasons || []).join('; ') || 'The risk layer has paused new trades.') + '</div>';
    h += '<div class="grid">'
      + '<div class="card"><span class="sub">' + T('equity', 'Equity') + '</span><div class="big">' + (n ? money(p.equity[n - 1]) : '—') + '</div><span class="sub ' + cls(p.total_return) + '">' + pct(p.total_return) + ' since start</span></div>'
      + '<div class="card"><span class="sub">' + T('maxdd', 'Max drawdown') + '</span><div class="big ' + (p.max_drawdown < 0 ? 'c-bad' : '') + '">' + pct(p.max_drawdown) + '</div><span class="sub">worst fall from a peak</span></div>'
      + '<div class="card"><span class="sub">' + T('sharpe', 'Sharpe ratio') + '</span><div class="big">' + (isN(p.sharpe) ? num(p.sharpe, 2) : '—') + '</div><span class="sub">' + (isN(p.sharpe) ? 'annualised from hourly changes' : 'needs 30+ hourly steps (has ' + p.n_hours + ')') + '</span></div>'
      + '<div class="card"><span class="sub">' + T('uphours', 'Hours in profit') + '</span><div class="big">' + (isN(p.up_hours_frac) ? pctU(p.up_hours_frac, 0) : '—') + '</div><span class="sub">' + (isN(p.up_hours_frac) ? 'of ' + p.n_hours + ' hourly steps' : 'needs 30+ hourly steps (has ' + p.n_hours + ')') + '</span></div>'
      + '<div class="card"><span class="sub">Trades</span><div class="big">' + p.n_trades + '</div><span class="sub">' + p.n_buys + ' buys, ' + p.n_sells + ' sells; ' + T('cost', 'trading costs') + ' ' + money2(p.total_cost) + '</span></div>'
      + '<div class="card"><span class="sub">' + T('funding', 'Funding payments') + '</span><div class="big">' + p.n_funding + '</div><span class="sub">net ' + fTxt + ' (not trades)</span></div>'
      + '<div class="card"><span class="sub">Open positions</span><div class="big">' + p.positions.length + '</div><span class="sub">' + p.positions.filter(function(x){ return x.side === 'long'; }).length + ' long, ' + p.positions.filter(function(x){ return x.side === 'short'; }).length + ' short</span></div></div>';
    if (n >= 2) {
      h += '<h3>' + T('equity', 'Account value') + ' over time</h3><div class="chart">' + lineChart(p.equity, p.ts, {base: p.initial, label: 'equity curve', fmt: function(v){ return money(v); }}) + '</div>'
        + '<h3>' + T('drawdown', 'Drawdown') + '</h3><div class="chart">' + lineChart(p.drawdown, p.ts, {dd: true, zeroTop: true, h: 140, label: 'drawdown', fmt: function(v){ return pct(v, 2); }}) + '</div>';
    } else h += empty('The chart appears after a few hourly steps.', 'engine live step');
    if (p.eq_duplicates) h += '<p class="sub">' + p.eq_duplicates + ' repeated equity row(s) with the same timestamp (re-runs) were merged; the last value per hour is used. See Data health.</p>';
    if (p.recent_fills.length) h += '<details><summary>Latest simulated trades (' + p.n_trades + ' total)</summary><div class="wrap"><table><tr><th>Time</th><th>Coin</th><th>Side</th><th>Size</th><th>Cost</th></tr>'
      + p.recent_fills.map(function(f){ return '<tr><td>' + esc(fmtTs(f.ts)) + '</td><td>' + esc(f.symbol) + '</td><td>' + esc(f.side) + '</td><td>' + money(f.notional) + '</td><td>' + money2(f.cost) + '</td></tr>'; }).join('') + '</table></div></details>';
    if ((p.recent_funding || []).length) h += '<details><summary>Latest funding payments (' + p.n_funding + ' total, not trades)</summary><div class="wrap"><table><tr><th>Time</th><th>Coin</th><th>Rate</th><th>Amount</th></tr>'
      + p.recent_funding.map(function(f){ var c = f.cost; return '<tr><td>' + esc(fmtTs(f.ts)) + '</td><td>' + esc(f.symbol) + '</td><td>' + (isN(f.rate) ? pct(f.rate, 4) : '—') + '</td><td>' + (isN(c) ? (c < 0 ? money2(-c) + ' received' : money2(c) + ' paid') : '—') + '</td></tr>'; }).join('') + '</table></div></details>';
  });
  return h;
}

var HEALTH = {ACTIVE:['good', 'Working as expected; trades at full size.'], WARNING:['warn', 'Live results are slipping; watched closely.'],
  REDUCED:['warn', 'Poor live results; trades at reduced size.'], QUARANTINED:['bad', 'Failing; no longer allowed to trade.'],
  RESEARCH:['mut', 'Back in the lab; not trading.']};
var DEC = {PROMOTE:['good', 'Passed every gate; allowed into paper trading.'], WATCH:['warn', 'Failed some gates; not tradeable. Kept on a watch list in case more data changes the picture.'],
  INCONCLUSIVE:['mut', 'Not enough evidence either way (or the run failed).'], REJECT:['bad', 'Failed a decisive gate (e.g. costs, overfitting); dropped.']};
function models(){
  var h = '<p class="eyebrow">Models</p><h1>Which models are earning their place</h1><p class="lede">Every model is tested ' + T('walkforward', 'walk-forward') + ' on past data, then judged on ' + T('paper', 'paper') + ' results. ' + T('health', 'Health') + ' moves it up or down.</p>';
  h += '<h2>Health</h2>';
  var hl = md.health || [];
  if (hl.length) h += '<div class="grid">' + hl.map(function(m){ var s = HEALTH[m.state] || ['mut', '']; return '<div class="card"><div class="row"><span class="light" style="background:var(--' + (s[0] === 'good' ? 'good' : s[0] === 'bad' ? 'bad' : s[0] === 'warn' ? 'warn' : 'line') + ')" aria-hidden="true"></span><h3>' + esc(m.model) + '</h3></div><b class="c-' + s[0] + '">' + esc(m.state) + '</b> <span class="sub">score ' + num(m.score, 0) + '/100</span><p class="sub">' + esc(s[1]) + '</p></div>'; }).join('') + '</div>';
  else h += empty('No model has a live track record yet, so no health states exist. States: ' + Object.keys(HEALTH).map(function(k){ return k + ' (' + HEALTH[k][1].toLowerCase().replace(/\.$/, '') + ')'; }).join(', ') + '.', 'engine monitor drift');
  h += '<h2>Prediction vs reality</h2>';
  var pv = md.pred_vs_real || [];
  if (pv.length) h += '<p class="sub">Each dot is one finished forecast. Dots near the dashed line were accurate; dots in the top-right or bottom-left got the direction right.</p><div class="chart" style="max-width:560px">' + scatter(pv) + '</div>';
  else if (md.n_resolved_no_forecast) h += '<div class="empty"><b>Nothing to compare yet.</b> ' + md.n_resolved_no_forecast + ' ledger rows have finished, but all of them are target weights without a return forecast, so there is no predicted move to put next to the actual move. The chart appears once a model records real forecasts.</div>';
  else h += empty('No forecast has reached its end time yet.', 'engine monitor resolve');
  h += '<h2>Leaderboard</h2>';
  var lb = md.leaderboard || [];
  if (!lb.length) return h + empty('No research experiments have been recorded.', 'engine research run');
  h += '<p class="sub">' + Object.keys(DEC).map(function(k){ return '<b>' + k + '</b>: ' + esc(DEC[k][1]); }).join(' ') + '</p>';
  h += '<div class="wrap"><table><tr><th>Model</th><th>Idea</th><th>Decision</th><th>' + T('oos', 'OOS') + ' ' + T('sharpe', 'Sharpe') + '</th><th>2× cost Sharpe</th><th>' + T('dsr', 'DSR') + '</th><th>' + T('pbo', 'PBO') + '</th><th style="text-align:left">Gates failed</th></tr>'
    + lb.map(function(r){ var d = DEC[r.decision] || ['mut']; return '<tr><td>' + esc(r.model) + '</td><td>' + esc(r.hypothesis) + '</td><td>' + chip(r.decision, d[0]) + '</td><td class="' + cls(r.oos_sharpe) + '">' + num(r.oos_sharpe, 2) + '</td><td>' + num(r.cost_stress_sharpe, 2) + '</td><td>' + num(r.dsr, 2) + '</td><td>' + num(r.pbo, 2) + '</td><td class="wraptxt">' + esc(String(r.reason || '—').replace(/failed: /g, '')) + '</td></tr>'; }).join('') + '</table></div>';
  return h;
}

/* lead-lag: raw single-pair verdicts are never shown as a green "edge"; the registry decision wins */
var RAW_V = {'EDGE EXISTS': ['Passed single-pair test (before multiple-testing correction)', 'warn'], 'EDGE DOES NOT SURVIVE': ['No edge after costs', 'bad'], 'INSUFFICIENT EVIDENCE': ['Insufficient evidence', 'mut']};
function rawV(v){ return RAW_V[v] || [String(v || 'unknown'), 'mut']; }
function research(){
  var h = '<p class="eyebrow">Research lab</p><h1>Ideas, tested honestly</h1><p class="lede">Every trading idea is written down first as a ' + T('hypothesis', 'hypothesis') + ', tested only on old data, and judged by fixed rules so we cannot fool ourselves (' + T('overfitting', 'overfitting') + ').</p>';
  h += '<h2>Experiment decisions</h2>';
  if (rs.n_experiments) h += '<div class="grid"><div class="card">' + bars(['PROMOTE', 'WATCH', 'INCONCLUSIVE', 'REJECT'].map(function(k){ return {label: k, n: counts[k] || 0, tone: DEC[k][0]}; })) + '</div><div class="card"><dl class="gl" style="grid-template-columns:auto 1fr">' + Object.keys(DEC).map(function(k){ return '<dt>' + chip(k, DEC[k][0]) + '</dt><dd>' + esc(DEC[k][1]) + '</dd>'; }).join('') + '</dl></div></div>';
  else h += empty('No experiments have been recorded.', 'engine research run');
  var ho = rs.holdout || {};
  h += '<h2>' + T('holdout', 'Holdout') + ' status</h2><div class="grid">'
    + '<div class="card"><h3>H1 holdout</h3>' + (ho.h1_views ? chip('Consumed', 'warn') + '<p class="sub">Holdout from ' + esc(fmtDate(ho.h1_start)) + '; opened ' + ho.h1_views + ' time(s) (first ' + esc(fmtTs(ho.h1_first_view)) + ', last ' + esc(fmtTs(ho.h1_last_view)) + '). Results on it no longer count as unseen.</p>'
        + ((ho.h1_reasons || []).length ? '<details><summary>Why it was opened</summary><ol class="sub">' + ho.h1_reasons.map(function(x){ return '<li>' + esc(x || '(no reason given)') + '</li>'; }).join('') + '</ol></details>' : '') : chip('Unused', 'good')) + '</div>'
    + '<div class="card"><h3>H2 holdout</h3>' + (ho.h2_opens ? chip('Opened ' + ho.h2_opens + '×', 'warn') : chip('Sealed', 'good')) + '<p class="sub">Data from ' + esc(fmtDate(ho.h2_start)) + ' onward is locked. Open count: ' + (ho.h2_opens == null ? '—' : ho.h2_opens) + '. Opening it is logged and permanent.</p></div></div>';
  h += '<h2>Hypotheses</h2>';
  var hy = rs.hypotheses || [];
  if (hy.length) {
    var tone = function(s){ return DEC[s] ? DEC[s][0] : (s === 'NEEDS DATA' ? 'mut' : 'acc'); };
    h += '<div class="wrap"><table><tr><th>ID</th><th>Family</th><th>Status</th><th>Tests</th><th style="text-align:left">Idea in one line</th></tr>' + hy.map(function(x){ return '<tr><td>' + esc(x.id) + '</td><td>' + esc(x.family) + '</td><td>' + chip(x.status, tone(x.status)) + '</td><td>' + x.n_experiments + '</td><td class="wraptxt">' + esc(x.statement) + '</td></tr>'; }).join('') + '</table></div>';
  } else h += empty('No hypotheses file found (research/hypotheses_seed.yaml).', '');
  h += '<h2>' + T('leadlag', 'Lead-lag') + ' results</h2>';
  if (verdicts.length) {
    var n = rs.n_pairs || verdicts.length;
    var passes = verdicts.filter(function(v){ return v.verdict === 'EDGE EXISTS'; });
    var vc = {}; verdicts.forEach(function(v){ var k = v.registry_decision ? 'Registry: ' + v.registry_decision : rawV(v.verdict)[0]; vc[k] = (vc[k] || 0) + 1; });
    h += '<p class="sub">Does one coin move first and another follow, enough to trade after costs? ' + n + ' pairs were tested.</p>';
    h += '<div class="card caveat"><b>' + T('mtc', 'Multiple-testing caveat') + ':</b> ' + n + ' pairs tested; ' + passes.length + ' passed the single-pair test. '
      + passes.map(function(v){ return esc(v.pair) + ': BH-adjusted q ' + (isN(v.q_bh) ? num(v.q_bh, 3) : 'not recorded') + (isN(v.q_bh) ? (v.q_bh > 0.05 ? ' (not significant after correction)' : ' (significant after correction)') : '') + '; registry decision ' + esc(v.registry_decision || 'none') + (v.registry_reason ? ' (' + esc(v.registry_reason) + ')' : '') + '. '; }).join('')
      + (passes.length <= Math.max(1, Math.round(n * 0.05)) ? passes.length + ' pass(es) out of ' + n + ' is consistent with chance. ' : '') + 'No lead-lag pair is a proven, tradeable edge.</div>';
    h += '<div class="row" style="margin:10px 0">' + Object.keys(vc).map(function(k){ return chip(k + ': ' + vc[k], /REJECT|No edge/.test(k) ? 'bad' : 'mut'); }).join('') + '</div>';
    h += '<details><summary>All ' + verdicts.length + ' pairs</summary><div class="wrap"><table><tr><th>Pair</th><th>Group</th><th>Single-pair test</th><th>Registry decision</th><th>BH q</th><th>Net ' + T('sharpe', 'Sharpe') + '</th><th>Trades</th></tr>' + verdicts.map(function(v){ var rv = rawV(v.verdict); return '<tr><td>' + esc(v.pair) + '</td><td>' + esc(v.group) + '</td><td>' + chip(rv[0], rv[1]) + '</td><td>' + (v.registry_decision ? chip(v.registry_decision, (DEC[v.registry_decision] || ['mut'])[0]) : '<span class="c-mut">not registered</span>') + '</td><td>' + (isN(v.q_bh) ? num(v.q_bh, 3) : '—') + '</td><td>' + num(v.net_sharpe, 2) + '</td><td>' + num(v.n_trades, 0) + '</td></tr>'; }).join('') + '</table></div></details>';
  } else h += empty('No lead-lag study has been run.', 'engine leadlag-engine');
  h += '<h2>' + T('regime', 'Regime') + ' summary</h2>';
  var r = mk.regime;
  if (r && r.shares) {
    var sh = r.shares, tr = sh.trend || {}, vo = sh.vol || {};
    h += '<div class="card"><p style="margin:0">In the research data (' + esc(r.first) + ' to ' + esc(fmtDate(r.asof)) + '), BTC was labelled an uptrend ' + pctU(tr.bull, 0) + ' of the time, a downtrend ' + pctU(tr.bear, 0) + ' and sideways ' + pctU(tr.sideways, 0) + '. Swings were high ' + pctU(vo.high, 0) + ' and low ' + pctU(vo.low, 0) + ' of the time. Labels only use past data; they describe history and are not a trading result.</p></div>';
  }
  h += rs.regime_summary ? '<details><summary>Show the full regime report (technical)</summary><div class="card"><pre class="scroll">' + esc(rs.regime_summary) + '</pre></div></details>' : empty('No regime report yet.', 'engine regimes');
  if (rs.batch) {
    var B = rs.batch, FD = {'plan.yaml': 'the plan, frozen before any test ran', 'results.md': 'the written results', 'leadlag_43_pairs.csv': 'one row per lead-lag pair tested'};
    h += '<h2>Current research batch</h2><div class="card"><b>batch_001</b> <span class="sub">created ' + esc(fmtTs(B.created_at)) + '</span><p>A research batch is a group of experiments planned in advance. The plan is written and frozen first, then every test runs on research data only'
      + (B.data_end ? ' (' + esc(fmtDate(B.data_start)) + ' to ' + esc(fmtDate(B.data_end)) + ')' : '') + (B.h2_start ? '; the sealed holdout from ' + esc(fmtDate(B.h2_start)) + ' is not touched' : '') + '.</p><ul class="sub">'
      + B.files.map(function(f){ return '<li><code>' + esc(f) + '</code>' + (FD[f] ? ': ' + esc(FD[f]) : '') + '</li>'; }).join('') + '</ul></div>';
  }
  return h;
}

function dataSec(){
  var h = '<p class="eyebrow">Data health</p><h1>Can we trust the data?</h1><p class="lede">Every result depends on clean prices. ' + T('integrity', 'Integrity checks') + ' look for problems; freshness shows when each dataset was last updated.</p>';
  h += '<h2>Integrity checks</h2>';
  if (integ) {
    var cc = integ.counts || {};
    h += '<div class="grid"><div class="card"><span class="sub">Overall</span><div class="big ' + (integ.ok ? 'c-good' : 'c-warn') + '">' + (integ.ok ? 'Passing' : 'Issues found') + '</div><span class="sub">checked ' + esc(fmtTs(integ.updated)) + '</span></div>'
      + ['critical', 'high', 'medium', 'info'].map(function(k){ return '<div class="card"><span class="sub">' + k + ' issue rows</span><div class="big ' + ((cc[k] || 0) && (k === 'critical' || k === 'high') ? 'c-bad' : '') + '">' + (cc[k] || 0) + '</div></div>'; }).join('') + '</div>';
    if (!integ.ok) h += '<div class="card"><b>What this means.</b> An issue row is one problem found in one coin\'s file (spot or perp). "Frozen" means hours where the price did not move and nothing traded, but the bar was stored as real instead of being marked as filled-in; such bars can make prices look calmer than they were. To re-check after fixing or re-downloading data, run <code>engine data validate</code>, then <code>engine app</code>.</div>';
    var bc = integ.by_check || [];
    if (bc.length) {
      var hit = {}; bc.forEach(function(b){ (b.universe_hit || []).forEach(function(s){ hit[s] = 1; }); });
      h += '<div class="wrap"><table><tr><th>Check</th><th>Severity</th><th>Issue rows</th><th>Unique coins</th><th>Bars affected</th><th>Traded-universe coins hit</th><th style="text-align:left">What it means</th></tr>' + bc.map(function(b){ return '<tr><td>' + esc(b.check) + '</td><td>' + chip(b.severity, b.severity === 'critical' || b.severity === 'high' ? 'bad' : 'warn') + '</td><td>' + b.n + '</td><td>' + b.n_symbols + '</td><td>' + num(b.n_bars, 0) + '</td><td>' + (b.universe_hit || []).length + '</td><td class="wraptxt">' + esc(b.detail) + '</td></tr>'; }).join('') + '</table></div>'
        + '<p class="sub">' + Object.keys(hit).length + ' of the ' + (integ.universe_size || '?') + ' coins in the configured universe (<code>config/universe.yaml</code>) are touched by at least one issue' + (Object.keys(hit).length ? ': ' + esc(Object.keys(hit).sort().join(', ')) : '') + '.</p>';
    }
  } else h += empty('No integrity report found.', 'engine data validate');
  if (dh.coverage) h += '<h2>Coverage</h2><div class="grid">' + Object.keys(dh.coverage).map(function(m){ var o = dh.coverage[m]; return '<div class="card"><h3>' + esc(m) + ' bars</h3><div class="kv">' + Object.keys(o).map(function(k){ return '<span>' + esc(k) + '</span><span>' + o[k] + '</span>'; }).join('') + '</div></div>'; }).join('') + '</div>';
  var dup = paper.filter(function(p){ return p.eq_duplicates; });
  if (dup.length) h += '<h2>Paper ledger</h2><div class="card">' + dup.map(function(p){ return esc(p.id) + ': ' + p.eq_rows + ' equity rows, ' + p.eq_duplicates + ' with a repeated timestamp (merged, last value kept).'; }).join('<br>') + '</div>';
  h += '<h2>Freshness</h2><div class="wrap"><table><tr><th>Dataset</th><th>File</th><th>Status</th><th>Last updated</th></tr>' + (dh.freshness || []).map(function(f){ return '<tr><td>' + esc(f.label) + '</td><td><code>' + esc(f.path) + '</code></td><td>' + (f.exists ? chip('present', 'good') : chip('missing', 'mut')) + '</td><td>' + esc(fmtTs(f.updated)) + '</td></tr>'; }).join('') + '</table></div>';
  if (D.errors) h += '<h2>Sections that could not be read</h2><div class="card c-warn"><pre class="scroll">' + esc(JSON.stringify(D.errors, null, 1)) + '</pre></div>';
  return h;
}

function glossary(){
  var keys = Object.keys(GL).sort(function(a, b){ return GL[a][0].localeCompare(GL[b][0]); });
  return '<p class="eyebrow">Glossary</p><h1>Every term in one sentence</h1><p class="lede">Underlined words anywhere in the app show their meaning when you hover or tap them.</p><dl class="gl">'
    + keys.map(function(k){ return '<dt id="g-' + k + '">' + esc(GL[k][0]) + '</dt><dd>' + esc(GL[k][1]) + '</dd>'; }).join('') + '</dl>';
}

var RENDER = {home: home, market: market, signals: signals, paper: paperSec, models: models, research: research, data: dataSec, glossary: glossary};

/* ---------------- shell ---------------- */
var main = $('#main');
main.innerHTML = '<div id="fresh">' + banner() + '</div>' + SECTIONS.map(function(s){ var html; try { html = RENDER[s[0]](); } catch (e) { html = empty('This section could not be drawn (' + esc(e.message) + ').', 'engine app'); } return '<section id="' + s[0] + '" aria-label="' + esc(s[1]) + '" hidden>' + html + '</section>'; }).join('');
$('#nav').innerHTML = SECTIONS.map(function(s){ var c = secStatus(s[0]); return '<a href="#' + s[0] + '" data-s="' + s[0] + '"' + (c ? ' title="' + esc(s[1] + ': ' + STATUS_TXT[c][0]) + '"' : '') + '>' + (c ? dot(c) : '<span class="dot" style="visibility:hidden" aria-hidden="true"></span>') + esc(s[1]) + '</a>'; }).join('');
$('#gen').textContent = fmtTs(D.generated_at);
var ageEl = $('#age'); if (ageEl) ageEl.textContent = FR.data_end ? 'Market data ends ' + fmtTs(FR.data_end) + '.' : '';

function go(id, keepScroll){
  var target = id;
  if (id && id.indexOf('g-') === 0) target = 'glossary';
  if (id === 'refresh') target = 'home';
  if (!RENDER[target]) target = 'home';
  document.querySelectorAll('main > section').forEach(function(s){ s.hidden = s.id !== target; });
  document.querySelectorAll('#nav a').forEach(function(a){ if (a.dataset.s === target) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  document.querySelectorAll('dl.gl dt').forEach(function(d){ d.classList.toggle('hl', d.id === id); });
  if ((id && id.indexOf('g-') === 0) || id === 'refresh') { var el = document.getElementById(id); if (el) el.scrollIntoView({block: 'start'}); }
  else if (!keepScroll) window.scrollTo(0, 0);
}
window.addEventListener('hashchange', function(){ go(location.hash.slice(1)); });
go(location.hash.slice(1));

document.querySelectorAll('#flow .step').forEach(function(b){ b.addEventListener('click', function(){ stopPulse(); showStep(+b.dataset.i); }); });
showStep(0);
/* attention pulse: one pass over the steps, then stop */
var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches, pi = 0, timer = null;
function stopPulse(){ if (timer) { clearInterval(timer); timer = null; } document.querySelectorAll('#flow .step').forEach(function(b){ b.classList.remove('pulse'); }); }
if (!reduce) timer = setInterval(function(){ var bs = document.querySelectorAll('#flow .step'); bs.forEach(function(b){ b.classList.remove('pulse'); }); if (pi >= bs.length) { stopPulse(); return; } bs[pi].classList.add('pulse'); pi++; }, 900);

/* tooltips */
var tip = $('#tip'), tipFor = null;
function showTip(el){
  var g = GL[el.dataset.term]; if (!g) return; tipFor = el;
  tip.innerHTML = '<b>' + esc(g[0]) + '.</b> ' + esc(g[1]) + ' <a href="#g-' + el.dataset.term + '">Glossary</a>';
  tip.style.display = 'block';
  var r = el.getBoundingClientRect(), tw = tip.offsetWidth, th = tip.offsetHeight;
  var x = Math.max(8, Math.min(r.left, window.innerWidth - tw - 8)), y = r.bottom + 6;
  if (y + th > window.innerHeight - 8) y = r.top - th - 6;
  tip.style.left = x + 'px'; tip.style.top = y + 'px';
}
function hideTip(){ tip.style.display = 'none'; tipFor = null; }
document.addEventListener('mouseover', function(e){ var t = e.target.closest && e.target.closest('.term'); if (t) showTip(t); else if (!(e.target.closest && e.target.closest('#tip'))) hideTip(); });
document.addEventListener('focusin', function(e){ if (e.target.classList && e.target.classList.contains('term')) showTip(e.target); });
document.addEventListener('focusout', function(e){ if (e.target.classList && e.target.classList.contains('term')) setTimeout(function(){ if (!tip.contains(document.activeElement)) hideTip(); }, 100); });
document.addEventListener('click', function(e){ var t = e.target.closest && e.target.closest('.term'); if (t && !(tipFor === t && tip.style.display === 'block')) showTip(t); else hideTip(); });
document.addEventListener('keydown', function(e){ if (e.key === 'Escape') { hideTip(); endTour(); } });

/* guided tour (shown automatically on the first visit only) */
var initTxt = v1 ? money(v1.initial) : 'simulated';
var TOUR = [
  ['home', 'Welcome', 'This app explains a crypto research and paper-trading engine in plain words. Nothing here uses real money, and it is a snapshot: the banner at the top says how old the data is.'],
  ['home', 'The loop', 'The engine runs in a loop: data in, forecasts, a cost check, simulated trades, and a reality check. Tap any step to learn more.'],
  ['market', 'Market', 'Stored prices, how jumpy they are, and the last labelled market "weather" (regime) from the research data.'],
  ['signals', 'Signals today', 'What each strategy version wants to hold per coin. Values that were not recorded say "not available", never zero.'],
  ['paper', 'Paper trading', 'The simulated ' + initTxt + ' account: its value over time, its worst fall, its trades, costs and funding payments.'],
  ['models', 'Models', 'Which models are working, shown as traffic lights, and how their forecasts compare with reality.'],
  ['research', 'Research lab', 'Every idea, how it was judged, and whether the locked test data is still unseen.'],
  ['data', 'Data health', 'Whether the price data passed its checks and how fresh each dataset is.'],
  ['glossary', 'Glossary', 'Any underlined word has a one-sentence meaning. You can replay this tour from the sidebar.']
];
var KEY = 'engine-app-tour-done', ti = 0, tourEl = $('#tour'), tourOpener = null;
function store(set){ try { if (set) localStorage.setItem(KEY, '1'); return localStorage.getItem(KEY) === '1'; } catch (e) { return false; } }
function clearHl(){ document.querySelectorAll('.tour-hl').forEach(function(x){ x.classList.remove('tour-hl'); }); }
function tourStep(){
  var s = TOUR[ti]; location.hash = s[0]; go(s[0]); clearHl();
  var a = document.querySelector('#nav a[data-s="' + s[0] + '"]'); if (a) a.classList.add('tour-hl');
  if (ti === 1) { var f = $('#flow'); if (f) f.classList.add('tour-hl'); }
  tourEl.innerHTML = '<div aria-live="polite"><span class="prog">' + (ti + 1) + ' of ' + TOUR.length + '</span><h3 id="tourTitle">' + esc(s[1]) + '</h3><p>' + esc(s[2]) + '</p></div><div class="row" style="justify-content:flex-end">'
    + '<button class="btn" type="button" id="tSkip">' + (ti === TOUR.length - 1 ? 'Close' : 'Skip tour') + '</button>'
    + (ti < TOUR.length - 1 ? '<button class="btn primary" type="button" id="tNext">Next</button>' : '') + '</div>';
  tourEl.style.display = 'block';
  $('#tSkip').onclick = endTour; var n = $('#tNext'); if (n) { n.onclick = function(){ ti++; tourStep(); }; n.focus(); } else $('#tSkip').focus();
}
tourEl.addEventListener('keydown', function(e){
  if (e.key !== 'Tab') return;
  var f = tourEl.querySelectorAll('button'); if (!f.length) return;
  var first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});
function endTour(){
  if (tourEl.style.display !== 'block') return;
  tourEl.style.display = 'none'; clearHl(); store(true);
  location.hash = 'home'; go('home');
  var b = tourOpener || $('#tourBtn'); if (!b || b.offsetParent === null) { b = $('#home h1'); if (b) b.setAttribute('tabindex', '-1'); } if (b) b.focus(); tourOpener = null;
}
function startTour(opener){ tourOpener = opener || null; ti = 0; tourStep(); }
$('#tourBtn').addEventListener('click', function(){ startTour($('#tourBtn')); });
if (!store(false)) { store(true); startTour(null); }
})();
"""

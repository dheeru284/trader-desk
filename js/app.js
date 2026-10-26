// UI wiring: forms in, agent outputs rendered out. State lives in memory and,
// for portfolio/journal/alerts/keys, in this browser's localStorage.
(function (TD) {
  'use strict';
  const A = TD.agents, C = TD.chart;
  const $ = s => document.querySelector(s);
  const esc = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  const f2 = v => isFinite(v) ? (+v).toFixed(2) : '–';
  const pct = (v, d = 1) => isFinite(v) ? (v * 100).toFixed(d) + '%' : '–';
  const money = (v, ccy) => isFinite(v) ? C.fmtMoney(v, ccy) : '–';
  const D = TD.data;
  const cls = v => v > 0 ? 'up' : v < 0 ? 'down' : '';
  const DISC = '<p class="disclaimer">This is not financial advice. Trade at your own risk.</p>';
  const SIM_DISC = '<p class="disclaimer">This is a simulation based on historical data. Past performance does not guarantee future results.</p>';

  const store = {
    get(k, d) { try { const v = localStorage.getItem('td.' + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('td.' + k, JSON.stringify(v)); } catch (e) { /* storage blocked: keep in memory only */ } },
  };
  const state = { bars: null, symbol: null, scan: null, news: [], synthetic: false };

  // Tabs and theme ----------------------------------------------------------
  $('#nav').addEventListener('click', e => {
    const b = e.target.closest('button[data-tab]');
    if (!b) return;
    document.querySelectorAll('#nav button').forEach(x => x.classList.toggle('active', x === b));
    document.querySelectorAll('section.tab').forEach(s => s.classList.toggle('active', s.id === 'tab-' + b.dataset.tab));
    store.set('tab', b.dataset.tab);
    if (b.dataset.tab === 'flows' && TD.flows && !state.flowsLoaded) { state.flowsLoaded = true; TD.flows.render(); }
    else if (b.dataset.tab === 'flows' && TD.flows) requestAnimationFrame(TD.flows.redraw);
    if (state.lastRender) requestAnimationFrame(state.lastRender);
  });
  const savedTab = store.get('tab', 'desk');
  const tabBtn = document.querySelector('#nav button[data-tab="' + savedTab + '"]');
  if (tabBtn) tabBtn.click();
  const applyTheme = t => { if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; };
  applyTheme(store.get('theme', null));
  $('#themeBtn').addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme === 'dark'
      || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
    const t = dark ? 'light' : 'dark';
    applyTheme(t); store.set('theme', t);
    if (state.lastRender) state.lastRender();
  });
  window.addEventListener('resize', () => { if (state.lastRender) state.lastRender(); });
  const applyColors = c => {
    if (c === 'classic') document.documentElement.dataset.colors = 'classic'; else delete document.documentElement.dataset.colors;
    $('#colorsBtn').textContent = 'Colours: ' + (c === 'classic' ? 'classic green/red' : 'colour-blind safe');
  };
  applyColors(store.get('colors', 'safe'));
  $('#colorsBtn').addEventListener('click', () => {
    const c = document.documentElement.dataset.colors === 'classic' ? 'safe' : 'classic';
    applyColors(c); store.set('colors', c);
    if (state.lastRender) state.lastRender();
    if (TD.flows) TD.flows.redraw();
  });

  // Settings -----------------------------------------------------------------
  const keys = () => store.get('keys', {});
  const keyForm = $('#keyForm');
  for (const [k, v] of Object.entries(keys())) if (keyForm[k]) keyForm[k].value = v;
  keyForm.addEventListener('submit', e => {
    e.preventDefault();
    store.set('keys', { twelve: keyForm.twelve.value.trim(), alpha: keyForm.alpha.value.trim(), finnhub: keyForm.finnhub.value.trim() });
    $('#keyMsg').textContent = 'Saved in this browser.';
  });
  $('#clearKeys').addEventListener('click', () => { store.set('keys', {}); keyForm.reset(); $('#keyMsg').textContent = 'Keys cleared.'; });
  $('#exportBtn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ positions: store.get('positions', []), cash: store.get('cash', 0), journal: store.get('journal', []), alerts: store.get('alerts', []) }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'trader-desk-backup.json'; a.click();
  });
  $('#importFile').addEventListener('change', async e => {
    try {
      const j = JSON.parse(await e.target.files[0].text());
      for (const k of ['positions', 'cash', 'journal', 'alerts']) if (j[k] !== undefined) store.set(k, j[k]);
      renderPortfolio(); renderJournal(); renderAlerts();
      $('#keyMsg').textContent = 'Imported.';
    } catch (err) { $('#keyMsg').textContent = 'Import failed: ' + err.message; }
  });

  // Desk ---------------------------------------------------------------------
  const idea = $('#ideaForm');
  const syncIdea = e => {
    if (!e || e.target === idea.market) {
      const mk = D.MARKETS[idea.market.value];
      document.querySelectorAll('.ccy').forEach(el => { el.textContent = mk.ccy; });
      // US options are 100 shares; Indian F&O lot sizes differ per contract and change, so the user enters them.
      idea.mult.value = isFinite(mk.mult) ? mk.mult : '';
      idea.mult.placeholder = isFinite(mk.mult) ? '' : 'from NSE lot-size list';
      $('#btForm').costBps.value = mk.costBps;
      // Swap the example account size between markets unless the user has typed their own.
      const DEF = { '$': '25000', '₹': '500000' };
      if (Object.values(DEF).includes(idea.account.value)) idea.account.value = DEF[mk.ccy];
      if (e && /\.(NS|BO)$/.test(idea.symbol.value.toUpperCase()) && idea.market.value === 'US') idea.symbol.value = idea.symbol.value.replace(/\.(NS|BO)$/i, '');
    }
    $('#csvWrap').hidden = idea.source.value !== 'csv';
    const opt = idea.instrument.value !== 'stock';
    document.querySelectorAll('#ideaForm .opt').forEach(el => { el.hidden = !opt; });
    idea.side.disabled = opt;
    idea.stop.disabled = opt; idea.target.disabled = opt;
  };
  idea.addEventListener('change', syncIdea);
  syncIdea();

  // Watchlist prices committed by the scheduled job (data/prices). Yahoo uses
  // BRK-B for class shares and .NS / .BO for India, which matches our ids.
  let priceIndex = null;
  async function repoIndex() {
    if (priceIndex) return priceIndex;
    const r = await fetch('data/prices/index.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error('The daily watchlist is not available yet (HTTP ' + r.status + '). It appears after the scheduled job first runs.');
    return (priceIndex = await r.json());
  }
  async function repoBars(sym) {
    const idx = await repoIndex();
    const id = sym.india ? sym.id : sym.base.replace('.', '-');
    const hit = idx.tickers[id];
    if (!Object.keys(idx.tickers).length) throw new Error('The daily watchlist has no prices yet. Save your Twelve Data key as the repository secret TWELVE_DATA_KEY (see README), or pick Twelve Data as the source.');
    if (!hit) throw new Error(sym.id + ' is not in the daily watchlist (' + Object.keys(idx.tickers).length + ' tickers). Add it to data/watchlist.json on GitHub, or use Twelve Data or a CSV.');
    const r = await fetch('data/prices/' + encodeURIComponent(hit.file), { cache: 'no-cache' });
    if (!r.ok) throw new Error('Could not read ' + hit.file + ' (HTTP ' + r.status + ').');
    const j = await r.json();
    state.repoMeta = { last: hit.last, source: j.source, fetched: j.fetched };
    return j.bars.map(b => ({ t: b[0], o: b[1], h: b[2], l: b[3], c: b[4], v: b[5] }));
  }
  repoIndex().then(idx => {
    $('#watchlist').innerHTML = Object.keys(idx.tickers).sort().map(t => '<option value="' + esc(t.replace(/-/, '.')) + '">').join('');
  }).catch(() => { /* offline or first run: the source reports it when chosen */ });

  async function loadBars(sym, source) {
    const k = keys();
    if (source === 'repo') return repoBars(sym);
    if (source === 'twelve') return D.twelveData(sym, k.twelve);
    if (source === 'alpha') return D.alphaVantage(sym, k.alpha);
    if (source === 'csv') {
      const file = idea.csv.files[0];
      if (!file) throw new Error('Choose a CSV file.');
      return D.parseCSV(await file.text(), sym.india);
    }
    return D.synthetic(sym.id);
  }

  idea.addEventListener('submit', async e => {
    e.preventDefault();
    $('#deskErr').textContent = '';
    const btn = $('#runBtn');
    btn.disabled = true; btn.textContent = 'Running…';
    try { await runDesk(); } catch (err) { $('#deskErr').textContent = err.message; console.error(err); }
    btn.disabled = false; btn.textContent = 'Run desk';
  });

  async function runDesk() {
    const sym = D.parseSymbol(idea.symbol.value, idea.market.value);
    if (sym.market !== idea.market.value) { idea.market.value = sym.market; syncIdea({ target: idea.market }); }
    const symbol = sym.id;
    TD.ccy = sym.ccy;
    const source = idea.source.value;
    const num = n => idea[n].value === '' ? NaN : +idea[n].value;
    const bars = await loadBars(sym, source);
    if (bars.length < 60) throw new Error('Only ' + bars.length + ' bars returned; need at least 60.');
    state.bars = bars; state.symbol = symbol; state.synthetic = source === 'demo';

    let newsErr = '';
    state.news = [];
    if (source === 'demo') newsErr = 'Demo mode: no news (synthetic ticker).';
    else {
      try { state.news = await D.finnhubNews(sym, keys().finnhub); } catch (err) { newsErr = err.message; }
    }

    const scan = A.chartScanner(bars);
    state.scan = scan;
    const instrument = idea.instrument.value;
    const side = instrument === 'put' ? 'short' : instrument === 'call' ? 'long' : idea.side.value;
    const entry = isFinite(num('entry')) ? num('entry') : scan.price;
    const horizon = Math.round(num('horizon')), account = num('account');

    let exit = A.exitPlanner(entry, side, scan);
    if (instrument === 'stock') {
      const dir = side === 'short' ? -1 : 1;
      if (isFinite(num('stop'))) {
        if (dir * (entry - num('stop')) <= 0) throw new Error('Stop must be ' + (dir > 0 ? 'below' : 'above') + ' entry for a ' + side + '.');
        exit.stop = num('stop'); exit.R = Math.abs(entry - exit.stop); exit.why.unshift('Stop set by you.');
      }
      if (isFinite(num('target'))) {
        if (dir * (num('target') - entry) <= 0) throw new Error('Target must be ' + (dir > 0 ? 'above' : 'below') + ' entry for a ' + side + '.');
        exit.target = num('target'); exit.why.unshift('Target set by you.');
      }
      exit.rr = Math.abs(exit.target - entry) / exit.R;
    }
    let strike = num('strike'), premium = num('premium');
    if (instrument !== 'stock') {
      if (!isFinite(premium) || premium <= 0) throw new Error('Option premium is required. This app has no options-chain data, so enter the ask you see at your broker.');
      if (!isFinite(strike)) strike = Math.round(entry);
    }
    const mult = num('mult');
    if (instrument !== 'stock' && !(mult > 0)) throw new Error('Enter the lot size. NSE sets it per contract and revises it, so check the current F&O lot-size list on nseindia.com or your broker\'s option chain.');
    const timer = A.entryTimer(scan, side, entry, exit);
    const positions = store.get('positions', []);
    const risk = A.riskManager({
      instrument, account, riskPct: num('riskPct'), maxPosPct: num('maxPosPct'), entry, stop: exit.stop,
      premium, mult, atr: scan.atr, symbol, side, india: sym.india,
      exposure: positions.filter(p => D.ccyOf(p.symbol) === sym.ccy).reduce((s, p) => s + p.shares * p.price, 0),
      heldAlready: positions.some(p => p.symbol === symbol),
    });
    const tm = A.timeMachine({
      bars, symbol, side, instrument, entry, stop: exit.stop, target: exit.target, horizon,
      sims: Math.round(num('sims')), lookback: Math.round(num('lookback')), drift: idea.drift.value,
      qty: Math.max(1, risk.qty), strike, premium, mult,
    });
    const nm = A.newsMonitor(state.news), sent = A.sentiment(state.news);
    const call = A.deskCall(timer, tm, sent, nm);
    const fired = A.checkAlerts(store.get('alerts', []), symbol, scan, bars, state.news);
    notify(fired, symbol);

    const ctx = { symbol, sym, mult, source, bars, scan, instrument, side, entry, exit, timer, risk, tm, nm, sent, newsErr, call, fired, strike, premium, horizon };
    renderDesk(ctx);

    // Keep a held position's price fresh when the desk loads that ticker.
    const held = positions.find(p => p.symbol === symbol);
    if (held && source !== 'demo') { held.price = +scan.price.toFixed(2); store.set('positions', positions); renderPortfolio(); }
  }

  function renderDesk(x) {
    const s = x.scan, opt = x.instrument !== 'stock';
    const optLabel = opt ? x.symbol + ' ' + f2(x.strike) + ' ' + x.instrument.toUpperCase() + ' @ ' + f2(x.premium) : '';
    const html = [];
    if (x.source === 'demo') html.push('<div class="banner">Demo mode: these prices are SYNTHETIC, generated from the ticker name. They are not ' + esc(x.symbol) + '\'s real prices. Add a free data key in Settings for real data.</div>');
    if (x.source === 'repo' && state.repoMeta) html.push('<div class="banner" style="background:var(--raised);color:var(--muted);border-color:var(--line)">Daily watchlist data: last bar ' + esc(state.repoMeta.last) + ', from ' + esc(state.repoMeta.source) + '. Updated once each weekday after the US close; not intraday.</div>');
    if (x.source === 'alpha' && x.sym.market === 'NSE') html.push('<div class="banner">Alpha Vantage lists Indian stocks on BSE only, so these are ' + esc(x.sym.base) + '\'s BSE prices. They track NSE closely but not exactly.</div>');
    if (x.bars.length < 200) html.push('<div class="banner">Only ' + x.bars.length + ' bars loaded: the 200-day average and 52-week stats are partial.</div>');
    if (x.fired.length) html.push('<div class="banner">Alerts triggered: ' + x.fired.map(f => esc(A.ALERT_TYPES[f.alert.type] + ' ' + f.alert.value + ' (' + f.detail + ')')).join('; ') + '</div>');

    // Summary first: what a desk lead wants to see.
    html.push('<div class="panel"><h2>Desk summary: ' + esc(x.symbol) + ' · ' + esc(x.sym.name) + ' · ' + (opt ? esc(optLabel) : x.side.toUpperCase()) + '</h2><div class="call">'
      + '<div><b>Entry</b><span>' + f2(x.entry) + '</span></div>'
      + (opt ? '<div><b>Max loss</b><span class="down">' + money(-x.premium * x.mult * Math.max(1, x.risk.qty)) + '</span></div>'
        + '<div><b>Breakeven at expiry</b><span>' + f2(x.instrument === 'call' ? x.strike + x.premium : x.strike - x.premium) + '</span></div>'
        : '<div><b>Stop loss</b><span class="down">' + f2(x.exit.stop) + '</span></div>'
        + '<div><b>Take profit</b><span class="up">' + f2(x.exit.target) + '</span></div>'
        + '<div><b>Reward : risk</b><span>' + f2(x.exit.rr) + '</span></div>')
      + '<div><b>Size</b><span>' + x.risk.qty + ' ' + x.risk.unit + '</span></div>'
      + '<div><b>Sim win rate</b><span>' + pct(x.tm.winRate) + '</span></div>'
      + '<div><b>Setup confidence</b><span>' + x.call.level + '</span></div></div>'
      + '<p class="muted">Confidence is a rules-based grade, not a probability: ' + esc(x.call.reasons.join('; ')) + '.</p>' + DISC + '</div>');

    // 1. Chart Scanner.
    html.push('<div class="panel"><h2><span class="n">1</span>Chart Scanner</h2><canvas id="cv"></canvas>'
      + '<div class="legend"><span><i style="background:var(--s1)"></i>SMA 20</span><span><i style="background:var(--s2)"></i>SMA 50</span><span><i style="background:var(--s3)"></i>SMA 200</span><span><i style="background:var(--muted)"></i>support / resistance</span>' + (opt ? '' : '<span><i style="background:var(--up)"></i>target</span><span><i style="background:var(--down)"></i>stop</span>') + '</div>'
      + '<div class="grid" style="margin-top:12px"><dl class="kv">'
      + kv('Last close (' + s.date + ')', f2(s.price)) + kv('Trend', s.trend) + kv('SMA 20 / 50 / 200', f2(s.sma20) + ' / ' + f2(s.sma50) + ' / ' + f2(s.sma200))
      + kv('RSI 14', f2(s.rsi)) + kv('MACD / signal / hist', f2(s.macd) + ' / ' + f2(s.macdSignal) + ' / ' + f2(s.macdHist))
      + '</dl><dl class="kv">'
      + kv('ATR 14', f2(s.atr) + ' (' + f2(s.atrPct) + '%)') + kv('Bollinger 20,2', f2(s.bbLower) + ' – ' + f2(s.bbUpper))
      + kv('Volume z (today)', f2(s.volZ)) + kv('52w range', f2(s.low52) + ' – ' + f2(s.high52)) + kv('Realised vol (1y, ann.)', f2(s.annVol) + '%')
      + '</dl><dl class="kv">'
      + kv('Support', s.support.map(l => f2(l.price) + '×' + l.touches).join(', ') || 'none found')
      + kv('Resistance', s.resistance.map(l => f2(l.price) + '×' + l.touches).join(', ') || 'none found')
      + '</dl></div>'
      + (s.notes.length ? '<ul class="plain" style="margin-top:8px">' + s.notes.map(n => '<li>' + esc(n) + '</li>').join('') + '</ul>' : '') + '</div>');

    // 2 + 8. News and sentiment.
    const newsRows = x.nm.items.slice(0, 12).map(n => '<li><span class="muted">' + n.time.toISOString().slice(0, 10) + ' · ' + esc(n.source) + '</span> '
      + (n.url ? '<a href="' + esc(n.url) + '" target="_blank" rel="noopener noreferrer">' + esc(n.headline) + '</a>' : esc(n.headline))
      + n.tags.map(t => '<span class="tag">' + esc(t) + '</span>').join('') + '</li>').join('');
    html.push('<div class="grid"><div class="panel news"><h2><span class="n">2</span>News Monitor</h2>'
      + (x.newsErr ? '<p class="muted">News unavailable: ' + esc(x.newsErr) + '</p>'
        : x.nm.items.length ? '<p>' + x.nm.items.length + ' headlines in 14 days' + (x.nm.dupes ? ' (' + x.nm.dupes + ' duplicates removed)' : '') + ', <b>' + x.nm.highCount + '</b> flagged as events.</p><ul class="plain">' + newsRows + '</ul>'
          : '<p class="muted">No headlines in the last 14 days.</p>')
      + '<p class="muted">Upcoming earnings dates are not in this feed: check your broker before holding through one.</p></div>'
      + '<div class="panel"><h2><span class="n">8</span>Sentiment Analyzer</h2>'
      + (x.sent.n ? '<dl class="kv">' + kv('Headline sentiment', x.sent.label) + kv('Score (−1 to +1)', f2(x.sent.score)) + kv('Positive / negative / neutral', x.sent.pos + ' / ' + x.sent.neg + ' / ' + x.sent.neutral) + '</dl>' : '<p class="muted">No headlines to score.</p>')
      + '<p class="muted">Keyword count on headlines only. No social-media data is connected, so this is not crowd sentiment.</p></div></div>');

    // 3 + 4. Entry and exit.
    html.push('<div class="grid"><div class="panel"><h2><span class="n">3</span>Entry Timer</h2><p><b>' + x.timer.grade + '</b> (' + x.timer.score + ' / ' + x.timer.max + ')</p><ul class="checks">'
      + x.timer.checks.map(c => '<li class="' + (c.ok ? 'ok' : 'no') + '" data-mark="' + (c.ok ? '✓' : '✗') + '">' + esc(c.text) + '</li>').join('') + '</ul>'
      + '<dl class="kv" style="margin-top:8px">' + kv('Pullback zone', f2(x.timer.pullback[0]) + ' – ' + f2(x.timer.pullback[1]))
      + kv((x.side === 'short' ? 'Breakdown' : 'Breakout') + ' trigger', x.timer.breakout ? f2(x.timer.breakout) : 'no level in range') + '</dl></div>'
      + '<div class="panel"><h2><span class="n">4</span>Exit Planner</h2>'
      + (opt ? '<p class="muted">Option is simulated to expiry. Underlying levels to watch as invalidation:</p>' : '')
      + '<dl class="kv">' + kv(opt ? 'Underlying invalidation' : 'Stop loss', f2(x.exit.stop) + ' (' + pct(Math.abs(x.entry - x.exit.stop) / x.entry) + ')')
      + kv(opt ? 'Underlying objective' : 'Take profit 1', f2(x.exit.target) + ' (' + f2(x.exit.rr) + 'R)')
      + (isFinite(x.exit.room) && x.exit.room < x.exit.rr ? kv('Next ' + (x.side === 'short' ? 'support' : 'resistance') + ' at', f2(x.exit.room) + 'R') : '')
      + kv(opt ? 'Stretch objective' : 'Take profit 2', f2(x.exit.target2) + ' (' + f2(Math.abs(x.exit.target2 - x.entry) / x.exit.R) + 'R)') + '</dl>'
      + '<ul class="plain" style="margin-top:8px">' + x.exit.why.map(w => '<li>' + esc(w) + '</li>').join('') + '</ul></div></div>');

    // 6. Time Machine.
    const t = x.tm;
    html.push('<div class="panel"><h2><span class="n">6</span>Time Machine: Monte Carlo</h2>'
      + '<p class="muted">' + t.sims.toLocaleString() + ' paths × ' + t.horizon + ' trading days, bootstrapped from ' + t.returnsUsed + ' historical daily returns (daily σ ' + pct(t.dailyVol, 2) + '). '
      + (t.driftRemoved ? 'Historical drift (' + pct(t.histDrift * 252, 1) + '/yr) removed.' : 'Historical drift (' + pct(t.histDrift * 252, 1) + '/yr) kept: this assumes the past year\'s trend continues.')
      + (opt ? ' Option valued at intrinsic at expiry; no early exit.' : ' Stop and target checked on daily closes; exits at the breaching close (gaps included).') + '</p>'
      + '<div class="grid"><div class="scroll"><table><tbody>'
      + row('Win rate (P&L > 0)', pct(t.winRate)) + row('Average P&L', money(t.avg), cls(t.avg)) + row('Median P&L', money(t.median), cls(t.median))
      + row('5th percentile', money(t.p5), cls(t.p5)) + row('95th percentile', money(t.p95), cls(t.p95))
      + row(opt ? 'P(expires worthless)' : 'P(hit stop first)', pct(t.pStop)) + row(opt ? 'P(≥ 2× premium)' : 'P(hit target first)', pct(t.pTarget))
      + row(opt ? 'P(in the money, < 2×)' : 'P(neither, time exit)', pct(t.pNeither))
      + (opt ? row('Max drawdown', 'n/a (needs intra-life option pricing)') : row('Max drawdown: mean / 95th pct', money(-t.maxDDavg) + ' / ' + money(-t.maxDD95), 'down'))
      + (opt ? '' : row('Average holding (days)', f2(t.avgDays)))
      + '</tbody></table><p class="muted">Sized at ' + Math.max(1, x.risk.qty) + ' ' + x.risk.unit + (x.risk.qty === 0 ? ' (risk manager says 0; shown per 1 unit)' : '') + '.</p></div>'
      + '<div><canvas id="hist"></canvas><p class="muted">Distribution of simulated P&L.</p></div></div>' + SIM_DISC + '</div>');

    // 5. Risk Manager.
    html.push('<div class="panel"><h2><span class="n">5</span>Risk Manager</h2><dl class="kv" style="max-width:520px">'
      + kv('Risk budget', money(x.risk.riskDollars)) + kv('Position size', x.risk.qty + ' ' + x.risk.unit)
      + kv('Position value', money(x.risk.posValue) + ' (' + f2(x.risk.pctOfAccount) + '% of account)') + kv('Max loss at stop', money(-x.risk.maxLoss)) + '</dl>'
      + (x.risk.warnings.length ? '<ul class="plain" style="margin-top:8px">' + x.risk.warnings.map(w => '<li>' + esc(w) + '</li>').join('') + '</ul>' : '')
      + DISC + '</div>');

    html.push('<div class="row"><button class="ghost" id="toJournal">Log this plan to the Journal</button><button class="ghost" id="toAlerts">Add stop/target alerts</button></div>');
    $('#deskOut').innerHTML = html.join('');

    const draw = () => {
      if (!document.getElementById('cv') || !$('#tab-desk').classList.contains('active')) return;
      const lines = [
        ...s.support.map(l => ({ price: l.price, label: 'S ' + f2(l.price), color: getComputedStyle(document.documentElement).getPropertyValue('--muted').trim(), dash: true })),
        ...s.resistance.map(l => ({ price: l.price, label: 'R ' + f2(l.price), color: getComputedStyle(document.documentElement).getPropertyValue('--muted').trim(), dash: true })),
      ];
      if (!opt) lines.push({ price: x.exit.stop, label: 'stop ' + f2(x.exit.stop), color: getComputedStyle(document.documentElement).getPropertyValue('--down').trim() },
        { price: x.exit.target, label: 'target ' + f2(x.exit.target), color: getComputedStyle(document.documentElement).getPropertyValue('--up').trim() });
      C.candles($('#cv'), x.bars, s, lines);
      C.histogram($('#hist'), x.tm.pnl);
    };
    state.lastRender = draw;
    draw();

    $('#toJournal').addEventListener('click', () => {
      const j = store.get('journal', []);
      j.push({ id: Date.now(), date: new Date().toISOString().slice(0, 10), symbol: x.symbol, side: x.side, size: x.risk.qty,
        entry: +x.entry.toFixed(2), stop: opt ? 0 : +x.exit.stop.toFixed(2), exit: NaN, setup: 'desk plan',
        notes: 'Planned. Target ' + f2(x.exit.target) + '. Confidence ' + x.call.level + '. Sim win rate ' + pct(x.tm.winRate) + '.' });
      store.set('journal', j); renderJournal();
      $('#toJournal').textContent = 'Logged ✓';
    });
    $('#toAlerts').addEventListener('click', () => {
      const al = store.get('alerts', []);
      const dir = x.side === 'short' ? -1 : 1;
      al.push({ id: Date.now(), symbol: x.symbol, type: dir > 0 ? 'price_below' : 'price_above', value: +x.exit.stop.toFixed(2) },
        { id: Date.now() + 1, symbol: x.symbol, type: dir > 0 ? 'price_above' : 'price_below', value: +x.exit.target.toFixed(2) });
      store.set('alerts', al); renderAlerts();
      $('#toAlerts').textContent = 'Alerts added ✓';
    });
  }
  const kv = (k, v) => '<dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd>';
  const row = (k, v, c = '') => '<tr><td>' + esc(k) + '</td><td class="num ' + c + '">' + esc(v) + '</td></tr>';

  // Backtester ---------------------------------------------------------------
  const btSel = $('#btStrategy');
  btSel.innerHTML = Object.entries(A.STRATEGIES).map(([k, v]) => '<option value="' + k + '">' + esc(v) + '</option>').join('');
  $('#btForm').addEventListener('submit', e => {
    e.preventDefault();
    $('#btErr').textContent = '';
    if (!state.bars) { $('#btErr').textContent = 'Load a ticker on the Desk tab first.'; return; }
    const fm = e.target;
    try {
      const r = A.backtest(state.bars, { strategy: fm.strategy.value, months: +fm.months.value, stopAtr: +fm.stopAtr.value, tpAtr: +fm.tpAtr.value, costBps: +fm.costBps.value });
      const html = (state.synthetic ? '<div class="banner">Running on SYNTHETIC demo prices.</div>' : '')
        + '<div class="panel"><h2>' + esc(state.symbol) + ': ' + esc(r.strategy) + '</h2><p class="muted">' + r.from + ' → ' + r.to + ' (' + r.days + ' trading days)</p>'
        + '<div class="grid"><table><tbody>'
        + row('Trades', String(r.trades.length)) + row('Win rate', pct(r.winRate)) + row('Total return', pct(r.totalReturn), cls(r.totalReturn))
        + row('Buy & hold, same window', pct(r.buyHold), cls(r.buyHold)) + row('Annualised', pct(r.cagr), cls(r.cagr))
        + row('Max drawdown', pct(-r.maxDD), 'down') + row('Profit factor', r.profitFactor === Infinity ? 'no losing trades' : f2(r.profitFactor)) + row('Average R per trade', f2(r.avgR))
        + '</tbody></table><div><canvas id="eqc"></canvas><div class="legend"><span><i style="background:var(--accent)"></i>strategy</span><span><i style="background:var(--muted)"></i>buy &amp; hold</span></div></div></div>'
        + (r.trades.length < 20 ? '<p class="muted">' + r.trades.length + ' trades is too small a sample to trust a win rate. Treat this as a sanity check, not evidence.</p>' : '')
        + '<div class="scroll"><table><thead><tr><th>In</th><th>Out</th><th class="num">Entry</th><th class="num">Exit</th><th class="num">Return</th><th class="num">R</th><th>Exit reason</th></tr></thead><tbody>'
        + r.trades.map(t => '<tr><td>' + t.in + '</td><td>' + t.out + '</td><td class="num">' + f2(t.entry) + '</td><td class="num">' + f2(t.exit) + '</td><td class="num ' + cls(t.ret) + '">' + pct(t.ret, 2) + '</td><td class="num">' + f2(t.R) + '</td><td>' + esc(t.why) + '</td></tr>').join('')
        + '</tbody></table></div>' + SIM_DISC + DISC + '</div>';
      $('#btOut').innerHTML = html;
      const startPx = state.bars[state.bars.length - r.curve.length].o;
      const bh = state.bars.slice(-r.curve.length).map(b => b.c / startPx);
      const drawBt = () => {
        if (!document.getElementById('eqc') || !$('#tab-backtest').classList.contains('active')) return;
        const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
        C.lines($('#eqc'), [{ label: 'strategy', color: css('--accent'), points: r.curve.map(p => p.eq) }, { label: 'buy & hold', color: css('--muted'), points: bh }]);
      };
      state.lastRender = drawBt; drawBt();
    } catch (err) { $('#btErr').textContent = err.message; }
  });

  // Portfolio ----------------------------------------------------------------
  // Holdings are grouped by currency; a rupee is never added to a dollar.
  const GROUPS = [{ ccy: '$', key: 'US', label: 'US ($)', title: 'US holdings ($)', note: 'Check taxes and US wash-sale rules before selling.' },
    { ccy: '₹', key: 'IN', label: 'India (₹)', title: 'India holdings (₹)', note: 'Check STCG/LTCG tax and delivery charges before selling.' }];
  const canon = raw => D.parseSymbol(raw, 'US').id;
  const cashMap = () => { const c = store.get('cash', {}); return typeof c === 'number' ? { US: c } : c; };
  const pf = $('#posForm');
  $('#cashUS').value = cashMap().US || '';
  $('#cashIN').value = cashMap().IN || '';
  for (const [id, k] of [['#cashUS', 'US'], ['#cashIN', 'IN']]) {
    $(id).addEventListener('change', e => { const c = cashMap(); c[k] = +e.target.value || 0; store.set('cash', c); renderPortfolio(); });
  }
  pf.addEventListener('submit', e => {
    e.preventDefault();
    const p = { symbol: canon(pf.symbol.value), shares: +pf.shares.value, cost: +pf.cost.value, price: +pf.price.value, target: pf.target.value === '' ? 0 : +pf.target.value };
    const ps = store.get('positions', []).filter(x => x.symbol !== p.symbol);
    ps.push(p); store.set('positions', ps); pf.reset(); renderPortfolio();
  });
  function renderPortfolio() {
    const all = store.get('positions', []);
    if (!all.length) { $('#pfOut').innerHTML = '<div class="panel muted">No positions yet. Prices are entered by hand; the Desk tab\'s last close updates a matching ticker.</div>'; return; }
    $('#pfOut').innerHTML = GROUPS.map(g => {
      const r = A.portfolio(all.filter(p => D.ccyOf(p.symbol) === g.ccy), cashMap()[g.key] || 0);
      if (!r.rows.length) return '';
      const m = v => money(v, g.ccy);
      return '<div class="panel"><h2>' + g.title + '</h2><div class="scroll"><table><thead><tr><th>Ticker</th><th class="num">Shares</th><th class="num">Cost</th><th class="num">Price</th><th class="num">Value</th><th class="num">P&L</th><th class="num">Weight</th>'
        + (r.hasTargets ? '<th class="num">Target</th><th class="num">Drift</th><th class="num">Rebalance (shares)</th>' : '') + '<th></th></tr></thead><tbody>'
        + r.rows.map(p => '<tr><td>' + esc(p.symbol) + '</td><td class="num">' + p.shares + '</td><td class="num">' + f2(p.cost) + '</td><td class="num">' + f2(p.price) + '</td><td class="num">' + m(p.value) + '</td><td class="num ' + cls(p.pnl) + '">' + m(p.pnl) + '</td><td class="num">' + f2(p.weight) + '%</td>'
          + (r.hasTargets ? '<td class="num">' + f2(p.target) + '%</td><td class="num ' + (Math.abs(p.drift) > 5 ? 'down' : '') + '">' + f2(p.drift) + '</td><td class="num">' + (Math.abs(p.drift) > 5 ? (p.trade > 0 ? 'buy ' : 'sell ') + Math.abs(Math.round(p.trade)) : 'within band') + '</td>' : '')
          + '<td><button class="ghost" data-del="' + esc(p.symbol) + '">×</button></td></tr>').join('')
        + '</tbody></table></div><dl class="kv" style="max-width:360px;margin-top:10px">' + kv('Invested', m(r.invested)) + kv('Cash', m(r.cash)) + kv('Total', m(r.total)) + '</dl>'
        + (r.warnings.length ? '<ul class="plain" style="margin-top:8px">' + r.warnings.map(w => '<li>' + esc(w) + '</li>').join('') + '</ul>' : '')
        + '<p class="muted">Weights and targets are within this market. Rebalance suggestions only appear for drift beyond ±5 percentage points. ' + g.note + '</p>' + DISC + '</div>';
    }).join('');
    document.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => {
      store.set('positions', store.get('positions', []).filter(p => p.symbol !== b.dataset.del)); renderPortfolio();
    }));
  }

  // Journal ------------------------------------------------------------------
  const jf = $('#jForm');
  jf.date.value = new Date().toISOString().slice(0, 10);
  jf.addEventListener('submit', e => {
    e.preventDefault();
    const j = store.get('journal', []);
    j.push({ id: Date.now(), date: jf.date.value, symbol: canon(jf.symbol.value), side: jf.side.value, size: +jf.size.value,
      entry: +jf.entry.value, stop: +jf.stop.value || 0, exit: jf.exit.value === '' ? NaN : +jf.exit.value, setup: jf.setup.value.trim(), notes: jf.notes.value });
    store.set('journal', j); jf.reset(); jf.date.value = new Date().toISOString().slice(0, 10); renderJournal();
  });
  function renderJournal() {
    const trades = store.get('journal', []).map(t => ({ ...t, exit: t.exit === null ? NaN : t.exit }));
    const out = [];
    const groups = GROUPS.filter(g => trades.some(t => D.ccyOf(t.symbol) === g.ccy));
    if (!groups.length) out.push('<div class="panel"><h2>What worked</h2><p class="muted">No trades yet.</p></div>');
    for (const g of groups) {
      const st = A.journalStats(trades.filter(t => D.ccyOf(t.symbol) === g.ccy));
      const m = v => money(v, g.ccy);
      out.push('<div class="panel"><h2>What worked · ' + g.label + '</h2>');
      if (!st.closed.length) out.push('<p class="muted">No closed trades yet. Stats appear once trades have an exit.</p>');
      else {
        out.push('<dl class="kv" style="max-width:420px">' + kv('Closed / open', st.closed.length + ' / ' + st.open) + kv('Win rate', pct(st.all.winRate)) + kv('Net P&L', m(st.all.pnl)) + kv('Average R', f2(st.all.avgR)) + '</dl>');
        out.push('<div class="scroll"><table style="margin-top:10px"><thead><tr><th>Setup</th><th class="num">Trades</th><th class="num">Win rate</th><th class="num">P&L</th><th class="num">Avg R</th></tr></thead><tbody>'
          + st.bySetup.map(b => '<tr><td>' + esc(b.setup) + '</td><td class="num">' + b.n + '</td><td class="num">' + pct(b.winRate) + '</td><td class="num ' + cls(b.pnl) + '">' + m(b.pnl) + '</td><td class="num">' + f2(b.avgR) + '</td></tr>').join('') + '</tbody></table></div>');
        const worst = st.bySetup[st.bySetup.length - 1];
        if (st.bySetup.length > 1 && worst.pnl < 0) out.push('<p>Weakest setup so far: <b>' + esc(worst.setup) + '</b> (' + m(worst.pnl) + ' over ' + worst.n + ' trades).' + (worst.n < 10 ? ' Small sample.' : '') + '</p>');
        if (st.closed.some(t => !(t.stop > 0))) out.push('<p class="muted">Trades logged without a stop have no R multiple. Planning a stop is the habit this column measures.</p>');
      }
      out.push('</div>');
    }
    out.push('<div class="panel"><h2>Log</h2><div class="scroll"><table><thead><tr><th>Date</th><th>Ticker</th><th>Side</th><th class="num">Size</th><th class="num">Entry</th><th class="num">Stop</th><th class="num">Exit</th><th>Setup</th><th>Notes</th><th></th></tr></thead><tbody>'
      + trades.slice().reverse().map(t => '<tr><td>' + esc(t.date) + '</td><td>' + esc(t.symbol) + '</td><td>' + esc(t.side) + '</td><td class="num">' + t.size + '</td><td class="num">' + f2(t.entry) + '</td><td class="num">' + (t.stop ? f2(t.stop) : '–') + '</td><td class="num">'
        + (isFinite(t.exit) ? f2(t.exit) : '<input data-close="' + t.id + '" type="number" step="any" placeholder="close at" style="width:90px">') + '</td><td>' + esc(t.setup || '') + '</td><td>' + esc(t.notes || '') + '</td><td><button class="ghost" data-jdel="' + t.id + '">×</button></td></tr>').join('')
      + '</tbody></table></div></div>');
    $('#jOut').innerHTML = out.join('');
    document.querySelectorAll('[data-jdel]').forEach(b => b.addEventListener('click', () => {
      store.set('journal', store.get('journal', []).filter(t => String(t.id) !== b.dataset.jdel)); renderJournal();
    }));
    document.querySelectorAll('[data-close]').forEach(inp => inp.addEventListener('change', () => {
      const j = store.get('journal', []);
      const t = j.find(t => String(t.id) === inp.dataset.close);
      if (t && +inp.value > 0) { t.exit = +inp.value; store.set('journal', j); renderJournal(); }
    }));
  }

  // Alerts -------------------------------------------------------------------
  $('#aType').innerHTML = Object.entries(A.ALERT_TYPES).map(([k, v]) => '<option value="' + k + '">' + esc(v) + '</option>').join('');
  const af = $('#aForm');
  af.addEventListener('submit', e => {
    e.preventDefault();
    const al = store.get('alerts', []);
    const v = af.type.value === 'news_keyword' ? af.value.value.trim() : +af.value.value;
    if (af.type.value !== 'news_keyword' && !isFinite(v)) return;
    al.push({ id: Date.now(), symbol: canon(af.symbol.value), type: af.type.value, value: v });
    store.set('alerts', al); af.reset(); renderAlerts();
  });
  $('#notifyBtn').addEventListener('click', async () => {
    if (!('Notification' in window)) { $('#notifyBtn').textContent = 'Not supported in this browser'; return; }
    const p = await Notification.requestPermission();
    $('#notifyBtn').textContent = 'Notifications: ' + p;
  });
  function notify(fired, symbol) {
    if (!fired.length || !('Notification' in window) || Notification.permission !== 'granted') return;
    try { new Notification('Trader Desk: ' + symbol, { body: fired.map(f => A.ALERT_TYPES[f.alert.type] + ' ' + f.alert.value).join('\n') }); } catch (e) { /* some browsers need a service worker */ }
  }
  function renderAlerts() {
    const al = store.get('alerts', []);
    $('#aOut').innerHTML = '<div class="panel"><h2>Active alerts</h2>' + (al.length ? '<div class="scroll"><table><thead><tr><th>Ticker</th><th>Condition</th><th>Value</th><th></th></tr></thead><tbody>'
      + al.map(a => '<tr><td>' + esc(a.symbol) + '</td><td>' + esc(A.ALERT_TYPES[a.type]) + '</td><td>' + esc(a.value) + '</td><td><button class="ghost" data-adel="' + a.id + '">×</button></td></tr>').join('') + '</tbody></table></div>'
      : '<p class="muted">No alerts.</p>') + '<p class="muted">An alert is information, never an order. Nothing here can place a trade.</p></div>';
    document.querySelectorAll('[data-adel]').forEach(b => b.addEventListener('click', () => {
      store.set('alerts', store.get('alerts', []).filter(a => String(a.id) !== b.dataset.adel)); renderAlerts();
    }));
  }

  TD.openOnDesk = (ticker, market) => {
    idea.market.value = market;
    syncIdea({ target: idea.market });
    idea.symbol.value = ticker;
    // Use the no-key watchlist when it has the ticker, else a keyed source if one is saved.
    const id = market === 'US' ? ticker.replace('.', '-') : ticker + (market === 'BSE' ? '.BO' : '.NS');
    const inRepo = priceIndex && priceIndex.tickers[id];
    idea.source.value = inRepo || !keys().twelve ? 'repo' : 'twelve';
    syncIdea();
    document.querySelector('#nav button[data-tab="desk"]').click();
    idea.requestSubmit();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  if (TD.flows) TD.flows.init();
  if (store.get('tab', 'desk') === 'flows' && TD.flows) { state.flowsLoaded = true; TD.flows.render(); }

  renderPortfolio(); renderJournal(); renderAlerts();
})(window.TD = window.TD || {});

// Indices: every NSE index from the daily snapshot the scheduled job commits to
// data/indices/index.json. Heat grid by group, key tiles, breadth, and a
// sortable table. Clicking an index opens it on the Desk.
(function (TD) {
  'use strict';
  const $ = s => document.querySelector(s);
  const esc = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  const GROUP_ORDER = ['Broad market', 'Sectoral', 'Thematic', 'Strategy', 'Volatility', 'Fixed income'];
  const PERIODS = { chg: '1 day', r1w: '1 week', r1m: '1 month', r3m: '3 months', r1y: '1 year' };
  // Return that maps to the strongest tint, per period, so a quiet day is not all pale.
  const SCALE = { chg: 2, r1w: 4, r1m: 8, r3m: 15, r1y: 30 };
  const KEY = ['NIFTY 50', 'NIFTY BANK', 'NIFTY NEXT 50', 'NIFTY MIDCAP 100', 'NIFTY SMALLCAP 100', 'NIFTY IT', 'NIFTY FINANCIAL SERVICES', 'INDIA VIX'];
  const ui = { group: 'All', period: 'chg', q: '', sort: 'chg', dir: -1 };
  let data = null;

  const pct = v => v == null || !isFinite(v) ? '–' : (v > 0 ? '▲ ' : v < 0 ? '▼ ' : '') + Math.abs(v).toFixed(2) + '%';
  const cls = v => v > 0 ? 'up' : v < 0 ? 'down' : '';
  const num = (v, d = 2) => v == null || !isFinite(v) || v === 0 ? '–' : (+v).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
  // Drop the "Nifty" prefix only where the rest still reads as a name (keep "Nifty 50").
  const short = n => { const r = n.replace(/^NIFTY\s?/i, '').trim(); return !r || /^\d/.test(r) ? n : r; };
  const tint = v => {
    if (v == null || !isFinite(v)) return 'var(--raised)';
    const k = Math.min(1, Math.abs(v) / SCALE[ui.period]);
    return 'color-mix(in srgb, var(' + (v >= 0 ? '--up' : '--down') + ') ' + Math.round(10 + k * 48) + '%, var(--panel))';
  };

  async function render() {
    const out = $('#idxOut');
    let status = {};
    try { status = await (await fetch('data/status.json', { cache: 'no-cache' })).json(); } catch (e) { /* none yet */ }
    const st = status.angel;
    const banner = !st ? '<div class="banner">No index data yet: the scheduled job has not run. It runs every weekday evening, or on demand from the repo\'s Actions tab, once the Angel One secrets are added (see README).</div>'
      : !st.ok ? '<div class="banner">The last update failed (' + esc(st.error || 'unknown error') + ')' + (st.last_ok ? '; showing data from ' + esc(st.last_ok.slice(0, 10)) : '') + '.</div>' : '';
    try {
      data = data || await TD.repoIndices();
    } catch (err) {
      out.innerHTML = banner + '<div class="panel"><p class="err">' + esc(err.message) + '</p></div>';
      return;
    }
    const all = Object.values(data.indices).map(v => ({ ...v, NAME: v.name.toUpperCase() }));
    const last = all.reduce((m, v) => v.last > m ? v.last : m, '');
    const today = all.filter(v => v.last === last);
    const up = today.filter(v => v.chg > 0).length, down = today.filter(v => v.chg < 0).length;
    const keyTiles = KEY.map(k => all.find(v => v.NAME === k)).filter(Boolean);

    const list = all.filter(v => (ui.group === 'All' || v.group === ui.group) && (!ui.q || v.NAME.includes(ui.q.toUpperCase())));
    const groups = GROUP_ORDER.filter(g => list.some(v => v.group === g));
    const grid = groups.map(g => {
      const items = list.filter(v => v.group === g).sort((a, b) => (b[ui.period] ?? -1e9) - (a[ui.period] ?? -1e9));
      return '<h3 class="idx-group">' + esc(g) + ' <span class="muted">· ' + items.length + '</span></h3><div class="heat">'
        + items.map(v => '<button class="cell" data-idx="' + esc(v.NAME) + '" style="background:' + tint(v[ui.period]) + '" title="' + esc(v.name) + ' · ' + PERIODS[ui.period] + ' ' + pct(v[ui.period]) + '">'
          + '<span class="nm">' + esc(short(v.name)) + '</span><span class="val">' + num(v.close) + '</span><span class="ch">' + pct(v[ui.period]) + '</span></button>').join('')
        + '</div>';
    }).join('');

    const col = (key, label, numeric = true) => '<th class="' + (numeric ? 'num' : '') + '"><button class="sortbtn" data-sort="' + key + '">' + label + (ui.sort === key ? (ui.dir < 0 ? ' ↓' : ' ↑') : '') + '</button></th>';
    const hasVal = all.some(v => v.pe || v.pb || v.dy);
    const rows = list.slice().sort((a, b) => {
      const x = a[ui.sort], y = b[ui.sort];
      if (typeof x === 'string' || typeof y === 'string') return ui.dir * String(x || '').localeCompare(String(y || ''));
      return ui.dir * ((x ?? -1e12) - (y ?? -1e12));
    });

    out.innerHTML = banner
      + '<div class="tiles">' + keyTiles.map(v => '<button class="tile tile-btn" data-idx="' + esc(v.NAME) + '"><b>' + esc(v.name) + '</b><span>' + num(v.close) + '</span><small class="' + cls(v.chg) + '">' + pct(v.chg) + ' today · 1Y ' + pct(v.r1y) + '</small></button>').join('') + '</div>'
      + '<div class="panel"><h2>NSE indices · ' + all.length + ' · ' + esc(last || '–') + '</h2>'
      + '<p>Breadth: <b class="up">▲ ' + up + ' up</b> · <b class="down">▼ ' + down + ' down</b> · ' + (today.length - up - down) + ' flat, of ' + today.length + ' indices. Colour shows the <b>' + PERIODS[ui.period] + '</b> return; stronger tint = bigger move (full tint at ±' + SCALE[ui.period] + '%).</p>'
      + (grid || '<p class="muted">No index matches.</p>')
      + '<p class="muted">India VIX rises when expected volatility rises, so "up" there means more fear, not gains. Fixed-income indices move in small steps; read their returns, not their tint. These are the ' + all.length + ' NSE indices in Angel One\'s instrument list; NSE publishes more (for example some newer thematic indices), which SmartAPI does not carry.</p></div>'
      + '<div class="panel"><h2>Table view · returns' + (hasVal ? ' and valuation' : '') + '</h2><div class="scroll"><table><thead><tr>' + col('name', 'Index', false) + col('group', 'Group', false) + col('close', 'Close')
      + col('chg', '1D') + col('r1w', '1W') + col('r1m', '1M') + col('r3m', '3M') + col('r1y', '1Y') + (hasVal ? col('pe', 'P/E') + col('pb', 'P/B') + col('dy', 'Div yield') : '') + '</tr></thead><tbody>'
      + rows.map(v => '<tr><td><button class="linkbtn" data-idx="' + esc(v.NAME) + '">' + esc(v.name) + '</button></td><td>' + esc(v.group) + '</td><td class="num">' + num(v.close) + '</td>'
        + ['chg', 'r1w', 'r1m', 'r3m', 'r1y'].map(k => '<td class="num ' + cls(v[k]) + '">' + pct(v[k]) + '</td>').join('')
        + (hasVal ? '<td class="num">' + num(v.pe) + '</td><td class="num">' + num(v.pb) + '</td><td class="num">' + (v.dy ? num(v.dy) + '%' : '–') + '</td>' : '') + '</tr>').join('')
      + '</tbody></table></div><p class="muted">Source: ' + esc(data.source || 'NSE') + '. Returns are close-to-close over 5, 21, 63 and 250 trading days and need that much history; "–" means not enough yet. Updated ' + esc((data.updated || '').slice(0, 10)) + '.</p>'
      + '<p class="disclaimer">This is not financial advice. Trade at your own risk.</p></div>';

    out.querySelectorAll('[data-idx]').forEach(b => b.addEventListener('click', () => TD.openOnDesk(b.dataset.idx, 'IDX')));
    out.querySelectorAll('[data-sort]').forEach(b => b.addEventListener('click', () => {
      ui.dir = ui.sort === b.dataset.sort ? -ui.dir : (b.dataset.sort === 'name' || b.dataset.sort === 'group' ? 1 : -1);
      ui.sort = b.dataset.sort; render();
    }));
  }

  function init() {
    $('#idxGroup').innerHTML = ['All', ...GROUP_ORDER].map(g => '<button data-g="' + esc(g) + '" aria-pressed="' + (g === ui.group) + '">' + esc(g) + '</button>').join('');
    $('#idxGroup').addEventListener('click', e => {
      const b = e.target.closest('button[data-g]'); if (!b) return;
      ui.group = b.dataset.g;
      $('#idxGroup').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
      render();
    });
    $('#idxPeriod').addEventListener('change', e => { ui.period = e.target.value; ui.sort = e.target.value; ui.dir = -1; render(); });
    $('#idxSearch').addEventListener('input', e => { ui.q = e.target.value.trim(); render(); });
  }

  TD.indices = { init, render };
})(window.TD = window.TD || {});

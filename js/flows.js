// Big Money: where large players moved money, from data the scheduled job
// commits to data/flows/. Sellers on the left, the stock in the middle, buyers
// on the right; band width is money. Hand-built SVG, no chart library.
(function (TD) {
  'use strict';
  const $ = s => document.querySelector(s);
  const esc = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  const SVGNS = 'http://www.w3.org/2000/svg';
  const DISC = '<p class="disclaimer">Disclosed trades and filings, not recommendations. Big players are often wrong, hedged elsewhere, or already out by the time this is public. This is not financial advice. Trade at your own risk.</p>';

  // Money in the market's own convention: $1.2B / $340M, ₹1,234 Cr / ₹56 L.
  function fmtFlow(v, ccy) {
    const a = Math.abs(v), s = v < 0 ? '−' : '';
    if (ccy === '₹') {
      if (a >= 1e7) return s + '₹' + (a / 1e7).toLocaleString('en-IN', { maximumFractionDigits: a >= 1e9 ? 0 : 1 }) + ' Cr';
      if (a >= 1e5) return s + '₹' + (a / 1e5).toFixed(1) + ' L';
      return s + '₹' + Math.round(a).toLocaleString('en-IN');
    }
    if (a >= 1e9) return s + '$' + (a / 1e9).toFixed(a >= 1e10 ? 1 : 2) + 'B';
    if (a >= 1e6) return s + '$' + (a / 1e6).toFixed(a >= 1e8 ? 0 : 1) + 'M';
    if (a >= 1e3) return s + '$' + (a / 1e3).toFixed(0) + 'K';
    return s + '$' + Math.round(a);
  }
  const ago = iso => {
    const d = Math.round((Date.now() - new Date(iso)) / 864e5);
    return d <= 0 ? 'today' : d === 1 ? 'yesterday' : d + ' days ago';
  };
  // Shorten legal suffixes so client names fit; the full name stays in tooltips.
  const shortName = n => String(n).replace(/\b(PRIVATE|PVT\.?|LIMITED|LTD\.?|LLC|L\.?P\.?|INC\.?|PTE\.?|CO\.?|CORP(ORATION)?\.?|MANAGEMENT|CAPITAL MANAGEMENT)\b/gi, '')
    .replace(/[,.\s]+$/g, '').replace(/\s{2,}/g, ' ').replace(/\(\s*\)/g, '').trim() || n;
  const trunc = (s, n) => s.length > n ? s.slice(0, n - 1) + '…' : s;

  const cache = {};
  async function load(path) {
    if (cache[path]) return cache[path];
    const r = await fetch(path, { cache: 'no-cache' });
    if (!r.ok) throw new Error(path + ': HTTP ' + r.status);
    return (cache[path] = await r.json());
  }

  // ---------------------------------------------------------------- Sankey
  // flows: [{player, stock, key, side: 'buy'|'sell', value}]
  function sankey(host, flows, opts) {
    const { ccy, topStocks = 12, topPlayers = 10, onStock } = opts;
    const byStock = new Map();
    for (const f of flows) {
      const s = byStock.get(f.key) || { key: f.key, label: f.stock, ticker: f.ticker, buy: 0, sell: 0 };
      s[f.side] += f.value;
      byStock.set(f.key, s);
    }
    const stocks = [...byStock.values()].sort((a, b) => (b.buy + b.sell) - (a.buy + a.sell)).slice(0, topStocks);
    const keep = new Set(stocks.map(s => s.key));
    const shown = flows.filter(f => keep.has(f.key));

    // Players per side; the long tail folds into "Other buyers/sellers".
    const side = sd => {
      const tot = new Map();
      for (const f of shown) if (f.side === sd) tot.set(f.player, (tot.get(f.player) || 0) + f.value);
      const ranked = [...tot.entries()].sort((a, b) => b[1] - a[1]);
      const top = new Set(ranked.slice(0, topPlayers).map(r => r[0]));
      const other = ranked.length > topPlayers ? (sd === 'buy' ? 'Other buyers' : 'Other sellers') : null;
      const links = new Map();
      for (const f of shown) {
        if (f.side !== sd) continue;
        const p = top.has(f.player) ? f.player : other;
        const k = p + '\u0000' + f.key;
        const l = links.get(k) || { player: p, key: f.key, value: 0, rows: [] };
        l.value += f.value; l.rows.push(f);
        links.set(k, l);
      }
      const nodes = new Map();
      for (const l of links.values()) nodes.set(l.player, (nodes.get(l.player) || 0) + l.value);
      const list = [...nodes.entries()].map(([name, value]) => ({ name, value, other: name === other }))
        .sort((a, b) => (a.other - b.other) || (b.value - a.value));
      return { nodes: list, links: [...links.values()] };
    };
    const L = side('sell'), R = side('buy');

    host.innerHTML = '';
    if (!stocks.length) { host.innerHTML = '<p class="muted">No flows match these filters.</p>'; return; }

    const W = Math.max(560, host.clientWidth || 900);
    const narrow = W < 760;
    const labelW = narrow ? 120 : 190, nodeW = 12, gap = 8;
    const colX = [labelW, W / 2 - nodeW / 2, W - labelW - nodeW];
    const n = Math.max(L.nodes.length, R.nodes.length, stocks.length);
    let H = Math.max(360, n * 34 + 40);
    const top = 30, avail = H - top - 10, SLOT = 20;
    const sum = a => a.reduce((s, x) => s + x, 0);
    const midTot = sum(stocks.map(s => Math.max(s.buy, s.sell)));
    const k = Math.min(
      (avail - gap * (L.nodes.length - 1)) / (sum(L.nodes.map(x => x.value)) || 1),
      (avail - gap * (R.nodes.length - 1)) / (sum(R.nodes.map(x => x.value)) || 1),
      (avail - gap * (stocks.length - 1)) / (midTot || 1));

    // Each node gets at least a label's height, so small nodes never stack their labels.
    const place = (list, val, total, colGap) => {
      const slots = list.map(x => Math.max(SLOT, Math.max(2, val(x) * k)));
      const used = sum(slots) + colGap * (list.length - 1);
      let y = top + Math.max(0, (avail - used) / 2);
      return list.map((x, i) => { const h = Math.max(2, val(x) * k); const r = { y: y + (slots[i] - h) / 2, h }; y += slots[i] + colGap; H = Math.max(H, y + 10); return r; });
    };
    const lPos = place(L.nodes, x => x.value, 0, gap);
    const rPos = place(R.nodes, x => x.value, 0, gap);
    const mPos = place(stocks, s => Math.max(s.buy, s.sell), 0, gap);
    const lIdx = new Map(L.nodes.map((x, i) => [x.name, i]));
    const rIdx = new Map(R.nodes.map((x, i) => [x.name, i]));
    const mIdx = new Map(stocks.map((s, i) => [s.key, i]));

    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('width', W); svg.setAttribute('height', H);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Money flow: sellers on the left, stocks in the middle, buyers on the right. The table below lists every flow.');
    // Trim a label until its rendered width fits; the full name stays in the tooltip.
    const fit = (t, text, maxW) => {
      t.textContent = text;
      if (!t.getComputedTextLength || t.getComputedTextLength() <= maxW) return;
      let lo = 1, hi = text.length;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; t.textContent = text.slice(0, mid) + '…'; if (t.getComputedTextLength() <= maxW) lo = mid; else hi = mid - 1; }
      t.textContent = text.slice(0, lo) + '…';
    };
    const el = (tag, attrs, parent = svg) => { const e = document.createElementNS(SVGNS, tag); for (const a in attrs) e.setAttribute(a, attrs[a]); parent.appendChild(e); return e; };
    const gLinks = el('g', {}), gNodes = el('g', {});
    host.appendChild(svg);

    const tip = $('#tip');
    const showTip = (ev, html) => {
      tip.innerHTML = html; tip.style.display = 'block';
      const x = Math.min(ev.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
      const y = Math.min(ev.clientY + 14, window.innerHeight - tip.offsetHeight - 8);
      tip.style.left = x + 'px'; tip.style.top = y + 'px';
    };
    const hideTip = () => { tip.style.display = 'none'; };
    const band = (x0, y0, x1, y1, h) => {
      const c = (x0 + x1) / 2;
      return 'M' + x0 + ',' + y0 + 'C' + c + ',' + y0 + ' ' + c + ',' + y1 + ' ' + x1 + ',' + y1
        + 'L' + x1 + ',' + (y1 + h) + 'C' + c + ',' + (y1 + h) + ' ' + c + ',' + (y0 + h) + ' ' + x0 + ',' + (y0 + h) + 'Z';
    };

    // Stack link ends inside each node, largest first.
    const lOff = L.nodes.map(() => 0), rOff = R.nodes.map(() => 0);
    const mIn = stocks.map(() => 0), mOut = stocks.map(() => 0);
    const linkEls = [];
    const drawLinks = (links, isSell) => {
      links.sort((a, b) => b.value - a.value);
      for (const l of links) {
        const h = Math.max(1, l.value * k), mi = mIdx.get(l.key);
        let d;
        if (isSell) {
          const pi = lIdx.get(l.player);
          d = band(colX[0] + nodeW, lPos[pi].y + lOff[pi], colX[1], mPos[mi].y + mIn[mi], h);
          lOff[pi] += h; mIn[mi] += h;
        } else {
          const pi = rIdx.get(l.player);
          d = band(colX[1] + nodeW, mPos[mi].y + mOut[mi], colX[2], rPos[pi].y + rOff[pi], h);
          rOff[pi] += h; mOut[mi] += h;
        }
        const p = el('path', { d, class: 'lk', fill: isSell ? 'var(--down)' : 'var(--up)', tabindex: 0 }, gLinks);
        p.dataset.player = l.player; p.dataset.key = l.key;
        const st = stocks[mi];
        const html = '<b>' + esc(l.player) + (isSell ? ' ▼ sold ' : ' ▲ bought ') + esc(st.label) + '</b>' + fmtFlow(l.value, ccy)
          + (l.rows.length > 1 ? '<br><span class="muted">' + l.rows.length + ' disclosures combined</span>' : '');
        p.addEventListener('mousemove', ev => showTip(ev, html));
        p.addEventListener('mouseleave', hideTip);
        p.addEventListener('focus', () => { const r = p.getBoundingClientRect(); showTip({ clientX: r.left + r.width / 2, clientY: r.top }, html); });
        p.addEventListener('blur', hideTip);
        linkEls.push(p);
      }
    };
    drawLinks(L.links, true);
    drawLinks(R.links, false);

    const highlight = (fn) => {
      svg.classList.toggle('dim', !!fn);
      for (const p of linkEls) p.classList.toggle('hi', !!fn && fn(p));
    };

    // Column headers.
    el('text', { x: colX[0] + nodeW, y: 16, class: 'col', 'text-anchor': 'end' }, gNodes).textContent = '▼ SELLERS';
    el('text', { x: W / 2, y: 16, class: 'col', 'text-anchor': 'middle' }, gNodes).textContent = 'STOCK';
    el('text', { x: colX[2], y: 16, class: 'col', 'text-anchor': 'start' }, gNodes).textContent = 'BUYERS ▲';

    const playerNode = (node, pos, x, isSell) => {
      const g = el('g', { class: 'nd', tabindex: 0 }, gNodes);
      el('rect', { x, y: pos.y, width: nodeW, height: pos.h, rx: 2, fill: isSell ? 'var(--down)' : 'var(--up)' }, g);
      const tx = isSell ? x - 6 : x + nodeW + 6, anchor = isSell ? 'end' : 'start';
      const t = el('text', { x: tx, y: pos.y + pos.h / 2 + 4, 'text-anchor': anchor }, g);
      fit(t, shortName(node.name), labelW - 12);
      const html = '<b>' + esc(node.name) + '</b>' + (isSell ? '▼ sold ' : '▲ bought ') + fmtFlow(node.value, ccy) + ' across the stocks shown';
      g.addEventListener('mouseenter', () => highlight(p => p.dataset.player === node.name));
      g.addEventListener('mousemove', ev => showTip(ev, html));
      g.addEventListener('mouseleave', () => { highlight(null); hideTip(); });
    };
    L.nodes.forEach((n, i) => playerNode(n, lPos[i], colX[0], true));
    R.nodes.forEach((n, i) => playerNode(n, rPos[i], colX[2], false));

    stocks.forEach((s, i) => {
      const pos = mPos[i];
      const g = el('g', { class: 'nd', tabindex: 0, role: 'button' }, gNodes);
      el('rect', { x: colX[1], y: pos.y, width: nodeW, height: pos.h, rx: 2, fill: 'var(--muted)' }, g);
      const net = s.buy - s.sell;
      const t = el('text', { x: colX[1] + nodeW + 6, y: pos.y + pos.h / 2 + 4 }, g);
      fit(t, s.ticker || s.label, W / 2 - colX[0] - 40);
      const t2 = el('text', { x: colX[1] - 6, y: pos.y + pos.h / 2 + 4, 'text-anchor': 'end', class: 'sub' }, g);
      t2.textContent = Math.abs(net) < 0.005 * (s.buy + s.sell) ? '= even' : (net > 0 ? '▲ ' : '▼ ') + fmtFlow(Math.abs(net), ccy);
      const html = '<b>' + esc(s.label) + (s.ticker ? ' (' + esc(s.ticker) + ')' : '') + '</b>' + [s.buy ? '▲ bought ' + fmtFlow(s.buy, ccy) : '', s.sell ? '▼ sold ' + fmtFlow(s.sell, ccy) : ''].filter(Boolean).join('<br>')
        + '<br>Net ' + (net >= 0 ? '▲ ' : '▼ ') + fmtFlow(Math.abs(net), ccy) + (s.ticker && onStock ? '<br><span class="muted">Click to analyse on the Desk</span>' : '');
      g.addEventListener('mouseenter', () => highlight(p => p.dataset.key === s.key));
      g.addEventListener('mousemove', ev => showTip(ev, html));
      g.addEventListener('mouseleave', () => { highlight(null); hideTip(); });
      if (s.ticker && onStock) {
        const go = () => { hideTip(); onStock(s); };
        g.addEventListener('click', go);
        g.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); go(); } });
      }
    });
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('height', H);
    return { stocks: byStock.size, shown: stocks.length };
  }

  // ---------------------------------------------------------------- FII / DII bars
  function dailyBars(host, days, who) {
    const pts = days.filter(d => d[who]).map(d => ({ t: d.date, v: d[who].net }));
    if (!pts.length) { host.innerHTML = '<p class="muted">No ' + who + ' data yet.</p>'; return; }
    const W = Math.max(300, host.clientWidth || 600), H = 190, padL = 56, padB = 22, padT = 10;
    const max = Math.max(...pts.map(p => Math.abs(p.v))) || 1;
    const y0 = padT + (H - padT - padB) / 2, sc = (H - padT - padB) / 2 / max;
    const bw = (W - padL) / pts.length;
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H); svg.setAttribute('height', H);
    svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', who + ' net buying per day in rupees crore');
    const el = (tag, a) => { const e = document.createElementNS(SVGNS, tag); for (const k in a) e.setAttribute(k, a[k]); svg.appendChild(e); return e; };
    for (const v of [max, 0, -max]) {
      el('line', { x1: padL, x2: W, y1: y0 - v * sc, y2: y0 - v * sc, stroke: 'var(--grid)', 'stroke-width': 1 });
      el('text', { x: padL - 6, y: y0 - v * sc + 4, 'text-anchor': 'end' }).textContent = Math.round(v).toLocaleString('en-IN');
    }
    const tip = $('#tip');
    pts.forEach((p, i) => {
      const h = Math.max(1, Math.abs(p.v) * sc), x = padL + i * bw + bw * 0.15;
      const r = el('rect', { x, y: p.v >= 0 ? y0 - h : y0, width: Math.max(2, bw * 0.7), height: h, rx: 2, fill: p.v >= 0 ? 'var(--up)' : 'var(--down)' });
      const html = '<b>' + who + ' · ' + p.t + '</b>' + (p.v >= 0 ? '▲ net bought ₹' : '▼ net sold ₹') + Math.abs(p.v).toLocaleString('en-IN', { maximumFractionDigits: 0 }) + ' Cr';
      r.addEventListener('mousemove', ev => { tip.innerHTML = html; tip.style.display = 'block'; tip.style.left = Math.min(ev.clientX + 14, innerWidth - 240) + 'px'; tip.style.top = (ev.clientY + 14) + 'px'; });
      r.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
    });
    const step = Math.ceil(pts.length / 6);
    pts.forEach((p, i) => { if (i % step === 0) el('text', { x: padL + i * bw + bw / 2, y: H - 6, 'text-anchor': 'middle' }).textContent = p.t.slice(5); });
    host.innerHTML = ''; host.appendChild(svg);
  }

  // ---------------------------------------------------------------- page
  const ui = { view: 'india', days: 5, topN: 12, player: '', roundTrips: false };
  let redraw = null;

  function flowTable(rows, ccy, onStock) {
    const top = rows.slice().sort((a, b) => b.value - a.value).slice(0, 200);
    return '<div class="scroll"><table><thead><tr><th>Player</th><th>Action</th><th>Stock</th><th class="num">Value</th>' + (top[0] && top[0].date ? '<th>Date</th>' : '') + '</tr></thead><tbody>'
      + top.map(r => '<tr><td>' + esc(r.player) + '</td><td><span class="pill ' + (r.side === 'buy' ? 'up' : 'down') + '">' + (r.side === 'buy' ? '▲ ' : '▼ ') + esc(r.action) + '</span></td><td>'
        + (r.ticker && onStock ? '<button class="linkbtn" data-open="' + esc(r.ticker) + '">' + esc(r.ticker) + '</button> ' : '') + esc(r.stock) + '</td><td class="num">' + fmtFlow(r.value, ccy) + '</td>'
        + (r.date ? '<td>' + esc(r.date) + '</td>' : '') + '</tr>').join('')
      + '</tbody></table></div>' + (rows.length > 200 ? '<p class="muted">Showing the 200 largest of ' + rows.length + ' rows.</p>' : '');
  }

  async function render() {
    const out = $('#flowOut');
    out.innerHTML = '<div class="panel muted">Loading…</div>';
    let status = {};
    try { status = await load('data/status.json'); } catch (e) { /* first run not done yet */ }
    const statusNote = name => {
      const s = status[name];
      if (!s) return '<div class="banner">No data yet: the scheduled job has not run this section. It runs weekdays after the US close, or on demand from the repo\'s Actions tab.</div>';
      if (!s.ok) return '<div class="banner">The last update failed (' + esc(s.error || 'unknown error') + ')' + (s.last_ok ? '; showing data from ' + esc(s.last_ok.slice(0, 10)) : '') + '.</div>';
      return '';
    };
    const onStock = TD.openOnDesk;
    try {
      if (ui.view === 'india') {
        const d = await load('data/flows/in_deals.json');
        const dates = d.dates.slice(-ui.days);
        const deals = d.deals.filter(x => dates.includes(x.date) && (!ui.player || x.client === ui.player));
        // Prop and arbitrage desks buy and sell the same stock the same day. Net each
        // client's day in a stock; unless asked, drop near-even round trips (< 10% net).
        const groups = new Map();
        for (const x of deals) {
          const k = x.date + '|' + x.client + '|' + x.symbol;
          const g = groups.get(k) || { date: x.date, client: x.client, symbol: x.symbol, name: x.name, buy: 0, sell: 0, types: new Set() };
          g[x.side] += x.value; g.types.add(x.type); groups.set(k, g);
        }
        let hidden = 0, hiddenValue = 0;
        const rows = [];
        for (const g of groups.values()) {
          const types = [...g.types].join(' + ');
          const both = g.buy > 0 && g.sell > 0;
          if (ui.roundTrips || !both) {
            for (const sd of ['buy', 'sell']) if (g[sd] > 0) rows.push({ player: g.client, stock: g.name || g.symbol, ticker: g.symbol, key: g.symbol, side: sd, value: g[sd], action: (sd === 'buy' ? 'Bought' : 'Sold') + ' · ' + types, date: g.date });
            continue;
          }
          const net = g.buy - g.sell;
          if (Math.abs(net) < 0.1 * (g.buy + g.sell)) { hidden++; hiddenValue += g.buy + g.sell; continue; }
          rows.push({ player: g.client, stock: g.name || g.symbol, ticker: g.symbol, key: g.symbol, side: net > 0 ? 'buy' : 'sell', value: Math.abs(net), action: (net > 0 ? 'Net bought' : 'Net sold') + ' · ' + types, date: g.date });
        }
        const buy = rows.filter(r => r.side === 'buy').reduce((s, r) => s + r.value, 0), sell = rows.filter(r => r.side === 'sell').reduce((s, r) => s + r.value, 0);
        out.innerHTML = statusNote('india_deals')
          + '<div class="panel"><h2>India · NSE bulk &amp; block deals · ' + (dates.length ? esc(dates[0]) + ' → ' + esc(dates[dates.length - 1]) : 'no days yet') + '</h2>'
          + '<div class="tiles"><div class="tile"><b>▲ Bought</b><span class="up">' + fmtFlow(buy, '₹') + '</span><small>' + rows.filter(r => r.side === 'buy').length + ' deals</small></div>'
          + '<div class="tile"><b>▼ Sold</b><span class="down">' + fmtFlow(sell, '₹') + '</span><small>' + rows.filter(r => r.side === 'sell').length + ' deals</small></div>'
          + '<div class="tile"><b>Trading days</b><span>' + dates.length + '</span><small>history kept: ' + d.dates.length + ' days · updated ' + ago(d.updated) + '</small></div></div>'
          + '<label class="row" style="flex-direction:row;gap:8px;margin-bottom:10px;color:var(--fg)"><input type="checkbox" id="rtToggle" style="width:auto;min-height:0"' + (ui.roundTrips ? ' checked' : '') + '> Show same-day round trips (prop / arbitrage desks buying and selling the same stock)</label>'
          + (!ui.roundTrips && hidden ? '<p class="muted">' + hidden + ' same-day round trip(s) worth ' + fmtFlow(hiddenValue, '₹') + ' gross are hidden: those clients ended the day roughly flat, so no money stayed in the stock.</p>' : '')
          + '<div class="sankey-wrap" id="sk"></div><p class="muted" id="skNote"></p>'
          + '<p class="muted">' + esc(d.method) + ' A buyer and seller in the same stock are often the two sides of one negotiated trade.</p>' + DISC + '</div>'
          + '<div class="panel"><h2>Every deal (table view)</h2>' + flowTable(rows, '₹', onStock) + '</div>';
        fillPlayers(d.deals.filter(x => dates.includes(x.date)).map(x => x.client));
        redraw = () => { const r = sankey($('#sk'), rows, { ccy: '₹', topStocks: ui.topN, onStock: s => onStock(s.ticker, 'NSE') }); if (r) $('#skNote').textContent = 'Top ' + r.shown + ' of ' + r.stocks + ' stocks by money moved. Band width is rupee value (quantity × price). Hover to trace a client; click a stock to analyse it.'; };
      } else {
        const d = await load('data/flows/in_fiidii.json');
        const days = Object.keys(d.days).sort().slice(-Math.max(ui.days, 20)).map(k => ({ date: k, ...d.days[k] }));
        const last = days[days.length - 1] || {};
        const sumNet = (who, n) => days.slice(-n).reduce((s, x) => s + (x[who] ? x[who].net : 0), 0);
        const tile = (label, v, sub) => '<div class="tile"><b>' + label + '</b><span class="' + (v >= 0 ? 'up' : 'down') + '">' + (v >= 0 ? '▲ ₹' : '▼ ₹') + Math.abs(v).toLocaleString('en-IN', { maximumFractionDigits: 0 }) + ' Cr</span><small>' + sub + '</small></div>';
        out.innerHTML = statusNote('india_fiidii')
          + '<div class="panel"><h2>India · FII/FPI vs DII · net cash-market flow</h2>'
          + '<div class="tiles">' + (last.FII ? tile('FII/FPI · ' + last.date, last.FII.net, 'buy ₹' + Math.round(last.FII.buy).toLocaleString('en-IN') + ' · sell ₹' + Math.round(last.FII.sell).toLocaleString('en-IN') + ' Cr') : '')
          + (last.DII ? tile('DII · ' + last.date, last.DII.net, 'buy ₹' + Math.round(last.DII.buy).toLocaleString('en-IN') + ' · sell ₹' + Math.round(last.DII.sell).toLocaleString('en-IN') + ' Cr') : '')
          + tile('FII · last ' + Math.min(5, days.length) + ' days', sumNet('FII', 5), 'sum of daily net') + tile('DII · last ' + Math.min(5, days.length) + ' days', sumNet('DII', 5), 'sum of daily net') + '</div>'
          + '<div class="grid"><div><h3>FII / FPI net (₹ crore)</h3><div class="bars" id="barsF"></div></div><div><h3>DII net (₹ crore)</h3><div class="bars" id="barsD"></div></div></div>'
          + '<p class="muted">' + esc(d.method) + ' ' + days.length + ' day(s) collected so far; the chart fills in as the daily job runs. Updated ' + ago(d.updated) + '.</p>' + DISC + '</div>';
        fillPlayers([]);
        redraw = () => { dailyBars($('#barsF'), days, 'FII'); dailyBars($('#barsD'), days, 'DII'); };
      }
      redraw();
      const rt = $('#rtToggle');
      if (rt) rt.addEventListener('change', () => { ui.roundTrips = rt.checked; render(); });
      document.querySelectorAll('#flowOut [data-open]').forEach(b => b.addEventListener('click', () => onStock(b.dataset.open, 'NSE')));
    } catch (err) {
      out.innerHTML = statusNote(ui.view === 'india' ? 'india_deals' : 'india_fiidii')
        + '<div class="panel"><p class="err">Could not load this view: ' + esc(err.message) + '</p><p class="muted">Data files appear after the scheduled job\'s first successful run. Opened from a file:// URL, browsers block reading them; use the GitHub Pages site.</p></div>';
      redraw = null;
    }
  }

  function fillPlayers(names) {
    const sel = $('#flowPlayer');
    const uniq = [...new Set(names)].sort();
    sel.innerHTML = '<option value="">All players</option>' + uniq.map(n => '<option' + (n === ui.player ? ' selected' : '') + ' value="' + esc(n) + '">' + esc(trunc(n, 60)) + '</option>').join('');
    sel.disabled = !uniq.length;
    $('#flowDaysWrap').hidden = false;
  }

  function init() {
    document.querySelectorAll('#flowView button').forEach(b => b.addEventListener('click', () => {
      document.querySelectorAll('#flowView button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
      ui.view = b.dataset.view; ui.player = ''; render();
    }));
    $('#flowPlayer').addEventListener('change', e => { ui.player = e.target.value; render(); });
    $('#flowDays').addEventListener('change', e => { ui.days = +e.target.value; render(); });
    $('#flowTop').addEventListener('change', e => { ui.topN = +e.target.value; if (redraw) redraw(); });
    window.addEventListener('resize', () => { if (redraw && $('#tab-flows').classList.contains('active')) redraw(); });
  }

  TD.flows = { init, render, redraw: () => redraw && redraw(), fmtFlow, sankey };
})(window.TD = window.TD || {});

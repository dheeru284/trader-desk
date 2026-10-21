// Data sources. Every fetch runs in the user's browser with the user's own
// free API key; nothing passes through a server we control.
// Bars come back oldest first as {t: 'YYYY-MM-DD', o, h, l, c, v}.
(function (TD) {
  'use strict';

  // Markets. A symbol's id carries its market: AAPL (US), RELIANCE.NS (NSE),
  // RELIANCE.BO (BSE), the suffixes Indian brokers and Yahoo use.
  const MARKETS = {
    US: { name: 'US', ccy: '$', locale: 'en-US', suffix: '', mult: 100, costBps: 5 },
    NSE: { name: 'India · NSE', ccy: '₹', locale: 'en-IN', suffix: '.NS', mult: NaN, costBps: 15 },
    BSE: { name: 'India · BSE', ccy: '₹', locale: 'en-IN', suffix: '.BO', mult: NaN, costBps: 15 },
  };
  function parseSymbol(raw, market = 'US') {
    let base = String(raw).trim().toUpperCase(), m = market;
    const sfx = base.match(/\.(NS|NSE|BO|BSE)$/);
    if (sfx) { m = sfx[1].startsWith('N') ? 'NSE' : 'BSE'; base = base.slice(0, sfx.index); }
    return { base, market: m, id: base + MARKETS[m].suffix, india: m !== 'US', ...MARKETS[m] };
  }
  const marketOf = id => /\.NS$/.test(id) ? 'NSE' : /\.BO$/.test(id) ? 'BSE' : 'US';
  const ccyOf = id => MARKETS[marketOf(id)].ccy;

  async function getJSON(url) {
    let res;
    try {
      res = await fetch(url);
    } catch (e) {
      throw new Error('Network error (offline, blocked, or the provider refused cross-origin requests).');
    }
    // Providers explain errors in the body (Twelve Data sends a JSON message
    // with its 4xx), so read it before giving up on the status code.
    let body = null;
    try { body = await res.json(); } catch (e) { /* not JSON */ }
    if (!res.ok && !(body && (body.message || body.status === 'error'))) {
      throw new Error('HTTP ' + res.status + ' from ' + new URL(url).host);
    }
    if (body === null) throw new Error('Unreadable response from ' + new URL(url).host);
    return body;
  }

  function clean(bars) {
    return bars
      .filter(b => b.t && [b.o, b.h, b.l, b.c].every(x => isFinite(x) && x > 0))
      .map(b => ({ ...b, v: isFinite(b.v) ? b.v : 0 }))
      .sort((a, b) => a.t < b.t ? -1 : a.t > b.t ? 1 : 0);
  }

  // Twelve Data: free tier, up to 5000 daily bars, 8 req/min, 800/day. Indian
  // exchanges are requested with exchange=NSE/BSE; whether the free plan covers
  // them is Twelve Data's call, so its own error message is passed through.
  async function twelveData(sym, key) {
    if (!key) throw new Error('No Twelve Data key. Add a free one in Settings.');
    const url = 'https://api.twelvedata.com/time_series?interval=1day&outputsize=600'
      + '&symbol=' + encodeURIComponent(sym.base) + (sym.india ? '&exchange=' + sym.market : '')
      + '&apikey=' + encodeURIComponent(key);
    const j = await getJSON(url);
    if (j.status === 'error' || j.code >= 400) {
      const msg = String(j.message || '');
      let hint = '';
      if (/plan|upgrade|subscri|access|available starting/i.test(msg)) {
        hint = sym.india ? ' Your Twelve Data plan does not cover ' + sym.market + '. Try Alpha Vantage (BSE, last 100 days) or upload a CSV from nseindia.com / your broker.' : '';
      } else if (/symbol|figi|not found|invalid/i.test(msg)) {
        hint = ' Check that ' + sym.base + ' trades on ' + (sym.india ? sym.market + ' (Indian tickers look like RELIANCE, TCS, INFY)' : 'a US exchange') + ', and that the Market setting matches.';
      }
      throw new Error('Twelve Data: ' + msg + ' (looked up ' + sym.base + (sym.india ? ' on ' + sym.market : ' in the US') + ').' + hint);
    }
    return clean((j.values || []).map(v => ({
      t: v.datetime.slice(0, 10), o: +v.open, h: +v.high, l: +v.low, c: +v.close, v: +v.volume,
    })));
  }

  // Alpha Vantage: free tier returns only the last 100 daily bars ("compact").
  // It lists Indian stocks on BSE only (RELIANCE.BSE), so NSE requests use the
  // BSE listing of the same company.
  async function alphaVantage(sym, key) {
    if (!key) throw new Error('No Alpha Vantage key. Add a free one in Settings.');
    const avSymbol = sym.india ? sym.base + '.BSE' : sym.base;
    const url = 'https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&outputsize=compact'
      + '&symbol=' + encodeURIComponent(avSymbol) + '&apikey=' + encodeURIComponent(key);
    const j = await getJSON(url);
    const series = j['Time Series (Daily)'];
    if (!series) throw new Error('Alpha Vantage: ' + (j['Error Message'] || j.Note || j.Information || 'no data'));
    return clean(Object.entries(series).map(([t, v]) => ({
      t, o: +v['1. open'], h: +v['2. high'], l: +v['3. low'], c: +v['4. close'], v: +v['5. volume'],
    })));
  }

  // Finnhub company news (free tier). Returns [{time, headline, source, summary, url}].
  async function finnhubNews(sym, key, days = 14) {
    if (sym.india) throw new Error('the free Finnhub feed covers North American companies only, so there are no NSE/BSE headlines here. Check Moneycontrol, Economic Times or NSE corporate announcements before entering.');
    if (!key) throw new Error('No Finnhub key. News needs a free key from finnhub.io.');
    const symbol = sym.base;
    const to = new Date(), from = new Date(Date.now() - days * 864e5);
    const d = x => x.toISOString().slice(0, 10);
    const url = 'https://finnhub.io/api/v1/company-news?symbol=' + encodeURIComponent(symbol)
      + '&from=' + d(from) + '&to=' + d(to) + '&token=' + encodeURIComponent(key);
    const j = await getJSON(url);
    if (!Array.isArray(j)) throw new Error('Finnhub: ' + (j.error || 'unexpected response'));
    return j.map(n => ({
      time: new Date(n.datetime * 1000), headline: n.headline || '', source: n.source || '',
      summary: n.summary || '', url: n.url || '',
    }));
  }

  // CSV with a header row. Accepts Yahoo/Stooq/broker exports and NSE/BSE
  // historical-data downloads (quoted "1,234.50" numbers, DD-MMM-YYYY dates,
  // newest-first rows, headers like "OPEN " or "Close Price").
  function splitCSVLine(line, delim) {
    const out = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
      else if (ch === delim && !q) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out.map(f => f.trim());
  }
  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  function parseDate(raw, dayFirst) {
    const s = raw.trim(), pad = n => String(n).padStart(2, '0');
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return m[1] + '-' + pad(m[2]) + '-' + pad(m[3]);
    m = s.match(/^(\d{1,2})[-\/ ]([A-Za-z]{3})[A-Za-z]*[-\/ ,]+(\d{4})/);
    if (m && MONTHS[m[2].toLowerCase()]) return m[3] + '-' + pad(MONTHS[m[2].toLowerCase()]) + '-' + pad(m[1]);
    m = s.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})/);
    if (m) {
      let d = +m[1], mo = +m[2];
      if (!dayFirst && mo <= 12 && d <= 12) [d, mo] = [mo, d];   // US style MM/DD/YYYY
      else if (mo > 12) [d, mo] = [mo, d];
      return m[3] + '-' + pad(mo) + '-' + pad(d);
    }
    const dt = new Date(s);
    return isNaN(dt) ? '' : dt.toISOString().slice(0, 10);
  }
  function parseCSV(text, dayFirst = false) {
    const lines = text.replace(/^﻿/, '').trim().split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) throw new Error('CSV has no data rows.');
    const delim = [',', ';', '\t'].sort((a, b) => lines[0].split(b).length - lines[0].split(a).length)[0];
    const head = splitCSVLine(lines[0], delim).map(h => h.toLowerCase().replace(/\s+/g, ' ').trim());
    const find = (...names) => {
      for (const n of names) { const i = head.indexOf(n); if (i >= 0) return i; }
      for (const n of names) { const i = head.findIndex(h => h.startsWith(n)); if (i >= 0) return i; }
      return -1;
    };
    const iT = find('date', 'timestamp', 'time'), iO = find('open'), iH = find('high'), iL = find('low');
    const iC = find('close', 'close price', 'closing price');
    const iV = find('volume', 'total traded quantity', 'no.of shares', 'no. of shares', 'shares traded', 'vol');
    if ([iT, iO, iH, iL, iC].some(i => i < 0)) {
      throw new Error('CSV needs Date, Open, High, Low, Close columns. Found: ' + head.join(', '));
    }
    const num = s => +String(s || '').replace(/[",$₹\s]/g, '');
    const bars = lines.slice(1).map(line => {
      const f = splitCSVLine(line, delim);
      return { t: parseDate(f[iT] || '', dayFirst), o: num(f[iO]), h: num(f[iH]), l: num(f[iL]), c: num(f[iC]), v: iV >= 0 ? num(f[iV]) : 0 };
    });
    const out = clean(bars);
    if (out.length < 30) throw new Error('CSV parsed to only ' + out.length + ' valid rows; need at least 30.');
    return out;
  }

  // Synthetic prices for trying the app without any key. Seeded by symbol so
  // it is reproducible. These are NOT real prices and the UI says so.
  function synthetic(symbol, n = 500) {
    const rnd = TD.ind.mulberry32(TD.ind.hashString(symbol.toUpperCase()));
    const gauss = () => {
      let u = 0, v = 0;
      while (u === 0) u = rnd();
      while (v === 0) v = rnd();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
    let p = 50 + rnd() * 250, vol = 0.018;
    const bars = [];
    const d = new Date();
    d.setDate(d.getDate() - Math.round(n * 1.45));
    while (bars.length < n) {
      d.setDate(d.getDate() + 1);
      if (d.getDay() === 0 || d.getDay() === 6) continue;
      vol = Math.min(0.05, Math.max(0.008, vol * (0.94 + 0.12 * rnd())));
      const r = 0.0003 + vol * gauss();
      const o = p * (1 + vol * 0.3 * gauss());
      const c = p * Math.exp(r);
      const h = Math.max(o, c) * (1 + Math.abs(vol * 0.5 * gauss()));
      const l = Math.min(o, c) * (1 - Math.abs(vol * 0.5 * gauss()));
      bars.push({ t: d.toISOString().slice(0, 10), o, h, l, c, v: Math.round(1e6 * (1 + 3 * rnd()) * (1 + 20 * Math.abs(r))) });
      p = c;
    }
    return bars;
  }

  TD.data = { MARKETS, parseSymbol, marketOf, ccyOf, twelveData, alphaVantage, finnhubNews, parseCSV, parseDate, synthetic };
})(window.TD = window.TD || {});

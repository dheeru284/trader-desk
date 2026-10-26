#!/usr/bin/env python3
"""Scheduled data job for Trader Desk (Indian markets). Standard library only.

Runs on GitHub Actions and writes JSON the static site reads from its own
origin:

    data/indices/index.json     every NSE index: latest close, change, returns, P/E, P/B, yield
    data/indices/<slug>.json    daily history per index (~14 months, grows daily)
    data/prices/index.json      which watchlist stocks have daily bars
    data/prices/<file>.json     daily OHLCV per watchlist stock
    data/flows/in_deals.json    NSE bulk and block deals, last 30 trading days
    data/flows/in_fiidii.json   FII/FPI and DII net cash-market flows, daily
    data/status.json            what worked and what failed on the last run

Sources: NSE's published daily report files (index snapshot ind_close_all and
the equity bhavcopy), requested with a user agent that names this project.
If NSE does not serve those to an automated client, the run says so, and
watchlist stocks fall back to Twelve Data when the TWELVE_DATA_KEY secret is
set. Every section is independent; a failure keeps the previous files.

    python3 scripts/fetch_data.py                   # everything
    python3 scripts/fetch_data.py nse_daily india_deals
"""

import csv
import datetime as dt
import gzip
import http.cookiejar
import io
import json
import os
import re
import sys
import time
import traceback
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
BROWSER_UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
              "Chrome/126.0 Safari/537.36")
HONEST_UA = "trader-desk/1.0 (+https://github.com/dheeru284/trader-desk)"
ARCHIVE = "https://nsearchives.nseindia.com"
NOW = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()
BACKFILL_DAYS = 430


def log(*a):
    print(*a, flush=True)


def write_json(rel, obj):
    path = os.path.join(DATA, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, separators=(",", ":"), ensure_ascii=False)
    os.replace(tmp, path)


def read_json(rel, default):
    try:
        with open(os.path.join(DATA, rel), encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return default


def http_get(url, headers=None, opener=None, timeout=30):
    h = {"User-Agent": BROWSER_UA, "Accept": "*/*", "Accept-Encoding": "gzip"}
    h.update(headers or {})
    req = urllib.request.Request(url, headers=h)
    with (opener or urllib.request.build_opener()).open(req, timeout=timeout) as resp:
        data = resp.read()
        if resp.headers.get("Content-Encoding") == "gzip":
            data = gzip.decompress(data)
        return data


def safe_name(symbol):
    return re.sub(r"[^A-Za-z0-9.\-]", "_", symbol) + ".json"


def slug(name):
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


# ------------------------------------------------------------------ Twelve Data

def twelve_daily(symbol, key):
    """Twelve Data's official time_series API with the repository's key."""
    india = symbol.endswith(".NS") or symbol.endswith(".BO")
    base = symbol.rsplit(".", 1)[0] if india else symbol.replace("-", ".")
    url = ("https://api.twelvedata.com/time_series?interval=1day&outputsize=520&symbol=%s%s&apikey=%s"
           % (urllib.request.quote(base), ("&exchange=" + ("NSE" if symbol.endswith(".NS") else "BSE")) if india else "",
              urllib.request.quote(key)))
    try:
        j = json.loads(http_get(url, {"User-Agent": "trader-desk/1.0 (github.com/dheeru284/trader-desk)"}, timeout=30).decode("utf-8"))
    except urllib.error.HTTPError as exc:
        j = json.loads(exc.read().decode("utf-8") or "{}")
    if j.get("status") == "error" or j.get("code", 200) >= 400:
        raise ValueError(j.get("message") or "error")
    bars = {}
    for v in j.get("values") or []:
        b = [v["datetime"][:10], num(v["open"]), num(v["high"]), num(v["low"]), num(v["close"]), int(num(v.get("volume", 0)))]
        if min(b[1:5]) > 0:
            bars[b[0]] = b
    return [bars[k] for k in sorted(bars)]


def save_prices(index, sym, bars, label, ccy):
    fname = safe_name(sym)
    write_json("prices/" + fname, {"symbol": sym, "currency": ccy, "source": label, "fetched": NOW, "bars": bars})
    index["tickers"][sym] = {"file": fname, "last": bars[-1][0], "bars": len(bars), "source": label}


# ------------------------------------------------------------------ India (NSE)

def nse_opener():
    jar = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    try:  # the API wants the cookies the home page sets
        http_get("https://www.nseindia.com/", {"Accept": "text/html", "Accept-Language": "en-US,en;q=0.9"}, op)
    except Exception as exc:
        log("  nse home page:", exc)
    return op


def num(s):
    try:
        return float(str(s).replace(",", "").strip())
    except ValueError:
        return 0.0


def parse_deals_csv(text, kind):
    rows = list(csv.reader(io.StringIO(text)))
    if not rows:
        return []
    head = [h.strip().lower() for h in rows[0]]

    def col(*names):
        for n in names:
            for i, h in enumerate(head):
                if h.startswith(n):
                    return i
        return -1
    iD, iS, iN, iC, iB, iQ, iP = (col("date"), col("symbol"), col("security"), col("client"),
                                  col("buy"), col("quantity"), col("trade price", "price"))
    out = []
    for r in rows[1:]:
        if len(r) <= max(iD, iS, iC, iB, iQ, iP):
            continue
        try:
            day = dt.datetime.strptime(r[iD].strip(), "%d-%b-%Y").strftime("%Y-%m-%d")
        except ValueError:
            continue
        qty, px = num(r[iQ]), num(r[iP])
        side = "buy" if r[iB].strip().upper().startswith("B") else "sell"
        out.append({"date": day, "symbol": r[iS].strip(), "name": r[iN].strip() if iN >= 0 else "",
                    "client": re.sub(r"\s+", " ", r[iC].strip()), "side": side, "qty": qty,
                    "price": px, "value": round(qty * px), "type": kind})
    return out


def section_india_deals():
    op = nse_opener()
    got, errors = [], {}
    for kind in ("bulk", "block"):
        for host in ("https://nsearchives.nseindia.com", "https://archives.nseindia.com"):
            try:
                text = http_get(host + "/content/equities/%s.csv" % kind,
                                {"Referer": "https://www.nseindia.com/"}, op).decode("utf-8", "replace")
                rows = parse_deals_csv(text, kind)
                got.extend(rows)
                errors.pop(kind, None)
                log("  NSE", kind, len(rows), "rows from", host)
                break
            except Exception as exc:
                errors[kind] = "%s: %s" % (host, str(exc)[:200])
    if not got and errors:
        raise RuntimeError("NSE deals unavailable: %s" % json.dumps(errors))
    old = read_json("flows/in_deals.json", {}).get("deals", [])
    key = lambda d: (d["date"], d["symbol"], d["client"], d["side"], d["qty"], d["price"], d["type"])
    merged = {key(d): d for d in old}
    for d in got:
        merged[key(d)] = d
    dates = sorted({d["date"] for d in merged.values()})[-30:]
    deals = sorted((d for d in merged.values() if d["date"] in dates), key=lambda d: (d["date"], d["value"]), reverse=True)
    write_json("flows/in_deals.json", {
        "updated": NOW, "source": "NSE bulk and block deal reports (nseindia.com)",
        "dates": dates, "deals": deals, "errors": errors,
        "method": "Each row is a disclosed bulk deal (one client trading more than 0.5% of a company's shares "
                  "in a day) or block deal (a single trade of at least the block-window minimum). Value = "
                  "quantity × trade price, in rupees. The last 30 trading days are kept.",
    })
    return {"new_rows": len(got), "days": len(dates), "errors": errors}


def section_india_fiidii():
    op = nse_opener()
    raw = http_get("https://www.nseindia.com/api/fiidiiTradeReact",
                   {"Accept": "application/json", "Referer": "https://www.nseindia.com/reports/fii-dii"}, op)
    rows = json.loads(raw.decode("utf-8"))
    hist = read_json("flows/in_fiidii.json", {}).get("days", {})
    for r in rows:
        try:
            day = dt.datetime.strptime(r["date"].strip(), "%d-%b-%Y").strftime("%Y-%m-%d")
        except (KeyError, ValueError):
            continue
        who = "FII" if "FII" in r.get("category", "").upper() else "DII"
        hist.setdefault(day, {})[who] = {"buy": num(r.get("buyValue")), "sell": num(r.get("sellValue")),
                                         "net": num(r.get("netValue"))}
    keep = sorted(hist)[-90:]
    write_json("flows/in_fiidii.json", {
        "updated": NOW, "source": "NSE FII/FPI and DII trading activity (provisional, cash market)",
        "unit": "₹ crore", "days": {k: hist[k] for k in keep},
        "method": "Provisional daily gross buy, gross sell and net figures NSE publishes after the close. "
                  "History builds up one day per run.",
    })
    return {"days": len(keep)}


# ------------------------------------------------------------------ NSE daily files

def nse_report(path, timeout=60):
    """One of NSE's published daily report files. None when there is no file for that day."""
    try:
        return http_get(ARCHIVE + path, {"User-Agent": HONEST_UA}, timeout=timeout).decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return None
        raise


def parse_day(s):
    s = s.strip()
    for fmt in ("%d-%m-%Y", "%d-%b-%Y", "%Y-%m-%d", "%d/%m/%Y"):
        try:
            return dt.datetime.strptime(s, fmt).date()
        except ValueError:
            pass
    return None


def parse_index_snapshot(text, day):
    """ind_close_all: one row per NSE index for that day."""
    rows = list(csv.reader(io.StringIO(text)))
    head = [h.strip().lower() for h in rows[0]]

    def col(*names):
        for n in names:
            for i, h in enumerate(head):
                if h.startswith(n):
                    return i
        return -1
    i = {k: col(*v) for k, v in {
        "name": ("index name",), "date": ("index date",), "open": ("open",), "high": ("high",), "low": ("low",),
        "close": ("closing", "close"), "pct": ("change(%)", "change (%)", "% change"), "vol": ("volume",),
        "turn": ("turnover",), "pe": ("p/e",), "pb": ("p/b",), "dy": ("div",)}.items()}
    if i["name"] < 0 or i["close"] < 0:
        raise ValueError("unexpected index snapshot columns: %s" % ", ".join(head))
    out = []
    for r in rows[1:]:
        if len(r) <= i["close"] or not r[i["name"]].strip():
            continue
        g = lambda k: num(r[i[k]]) if i[k] >= 0 and i[k] < len(r) and r[i[k]].strip() not in ("-", "") else 0.0
        c = g("close")
        if c <= 0:
            continue
        o, h, l = g("open") or c, g("high") or c, g("low") or c
        d = parse_day(r[i["date"]]) if i["date"] >= 0 else None
        out.append({"name": re.sub(r"\s+", " ", r[i["name"]].strip()), "bar": [(d or day).isoformat(), o, max(h, o, c), min(l, o, c), c, int(g("vol"))],
                    "pct": g("pct"), "turnover_cr": g("turn"), "pe": g("pe"), "pb": g("pb"), "dy": g("dy")})
    return out


def parse_bhavcopy(text, day):
    """sec_bhavdata_full: {symbol: bar} for EQ-series stocks."""
    rows = list(csv.reader(io.StringIO(text)))
    head = [h.strip().upper() for h in rows[0]]
    ix = {k: head.index(k) for k in ("SYMBOL", "SERIES", "OPEN_PRICE", "HIGH_PRICE", "LOW_PRICE", "CLOSE_PRICE", "TTL_TRD_QNTY")}
    out = {}
    for r in rows[1:]:
        if len(r) < len(head) or r[ix["SERIES"]].strip() != "EQ":
            continue
        out[r[ix["SYMBOL"]].strip()] = [day.isoformat(), num(r[ix["OPEN_PRICE"]]), num(r[ix["HIGH_PRICE"]]),
                                        num(r[ix["LOW_PRICE"]]), num(r[ix["CLOSE_PRICE"]]), int(num(r[ix["TTL_TRD_QNTY"]]))]
    return out


GROUPS = [
    ("Volatility", r"\bVIX\b"),
    ("Fixed income", r"G-?SEC|\bGILT\b|\bBOND|T-?BILL|\bSDL\b|\bAAA\b|1D RATE|TARGET MATURITY|LIQUID|MONEY MARKET|CORPORATE"),
    ("Strategy", r"ALPHA|LOW[ -]?VOL|\bLV\b|QUALITY|QLTY|VALUE|MOMENTUM|\bMOM\b|EQUAL[ -]?WEIGHT|EQL ?WGT|\bEW\b|DIV(IDEND)? OPP|HIGH BETA|GROWTH|ARBITRAGE|LEVERAGE|INVERSE"),
    ("Broad market", r"^NIFTY ?(50|NEXT 50|100|200|500|MIDCAP|SMALLCAP|SMLCAP|MICROCAP|LARGEMIDCAP|LARGEMID|MIDSMALLCAP|MIDSMLCAP|TOTAL MARKET|TOTAL MKT|MIDCAP SELECT|MID SELECT)( ?\d+)?( SELECT)?$|^NIFTY ?500 (MULTICAP|LARGEMIDSMALL)"),
    ("Sectoral", r"\b(BANK|AUTO|FIN|FINANCIAL|FMCG|IT|MEDIA|METAL|PHARMA|PSU BANK|PVT BANK|PRIVATE BANK|REALTY|HEALTHCARE|CONSUMER DURABLES|OIL ?& ?GAS|OIL AND GAS|CHEMICALS|ENERGY|COMMODITIES|INFRA(STRUCTURE)?|SERVICES SECTOR|CAPITAL MARKETS|INSURANCE|TELECOM)\b"),
]


def group_of(name):
    u = name.upper()
    for g, rx in GROUPS:
        if re.search(rx, u):
            return g
    return "Thematic"


def ret(bars, n):
    if len(bars) <= n:
        return None
    a, b = bars[-1 - n][4], bars[-1][4]
    return round((b / a - 1) * 100, 2) if a else None


def section_nse_daily():
    wl = read_json("watchlist.json", {})
    stocks = [s for s in (wl.get("india") or []) if s.endswith(".NS")]
    idx_meta = read_json("indices/index.json", {"indices": {}})
    hist = {}
    for key, m in idx_meta["indices"].items():
        hist[key] = {b[0]: b for b in read_json("indices/" + m["file"], {}).get("bars", [])}
    shist = {s: {b[0]: b for b in read_json("prices/" + safe_name(s), {}).get("bars", [])} for s in stocks}
    snap = {}
    have_days = set().union(*[set(h) for h in hist.values()]) if hist else set()
    start = (max(have_days) if len(have_days) >= 200 else None)
    start = dt.date.fromisoformat(start) + dt.timedelta(days=1) if start else dt.date.today() - dt.timedelta(days=BACKFILL_DAYS)
    day, ok_files, fails, stock_files = start, 0, [], 0
    while day <= dt.date.today():
        if day.weekday() < 5:
            stamp = day.strftime("%d%m%Y")
            try:
                text = nse_report("/content/indices/ind_close_all_%s.csv" % stamp)
                if text:
                    for row in parse_index_snapshot(text, day):
                        key = slug(row["name"])
                        hist.setdefault(key, {})[row["bar"][0]] = row["bar"]
                        snap[key] = row
                    ok_files += 1
                    btext = nse_report("/products/content/sec_bhavdata_full_%s.csv" % stamp) if stocks else None
                    if btext:
                        bars = parse_bhavcopy(btext, day)
                        stock_files += 1
                        for s in stocks:
                            b = bars.get(s[:-3])
                            if b:
                                shist[s][b[0]] = b
            except Exception as exc:
                fails.append("%s: %s" % (day, str(exc)[:120]))
                log("  nse", day, exc)
                if ok_files == 0 and len(fails) >= 3:
                    raise RuntimeError("NSE's report archive did not answer this job (it identifies itself as "
                                       "trader-desk, not as a browser): %s" % fails[-1])
            time.sleep(0.3)
        day += dt.timedelta(days=1)
    log("  NSE index files:", ok_files, "equity files:", stock_files)
    if ok_files == 0 and not idx_meta["indices"]:
        raise RuntimeError("no NSE index files read: %s" % "; ".join(fails[-3:]))

    out = {}
    for key, h in hist.items():
        bars = [h[k] for k in sorted(h)][-520:]
        if not bars:
            continue
        prev = idx_meta["indices"].get(key, {})
        name = snap.get(key, {}).get("name") or prev.get("name") or key
        fname = key + ".json"
        write_json("indices/" + fname, {"name": name, "source": "NSE daily index snapshot (ind_close_all)", "bars": bars})
        s = snap.get(key) or {}
        chg = s.get("pct") if s else (ret(bars, 1) if len(bars) > 1 else None)
        out[key] = {"name": name, "group": group_of(name), "file": fname, "last": bars[-1][0], "close": bars[-1][4],
                    "chg": chg if chg is not None else ret(bars, 1),
                    "r1w": ret(bars, 5), "r1m": ret(bars, 21), "r3m": ret(bars, 63), "r1y": ret(bars, 250),
                    "pe": s.get("pe") or prev.get("pe"), "pb": s.get("pb") or prev.get("pb"), "dy": s.get("dy") or prev.get("dy"),
                    "turnover_cr": s.get("turnover_cr") or prev.get("turnover_cr"), "bars": len(bars)}
    write_json("indices/index.json", {"updated": NOW, "source": "NSE daily index snapshot (ind_close_all), nseindia.com", "indices": out})

    pindex = read_json("prices/index.json", {"tickers": {}})
    pindex["tickers"] = {k: v for k, v in pindex["tickers"].items() if k.endswith(".NS") or k.endswith(".BO")}
    nstock = 0
    for s in stocks:
        bars = [shist[s][k] for k in sorted(shist[s])][-520:]
        if len(bars) >= 60:
            save_prices(pindex, s, bars, "NSE daily bhavcopy (nseindia.com)", "INR")
            nstock += 1
    pindex["updated"] = NOW
    write_json("prices/index.json", pindex)
    return {"index_files": ok_files, "indices": len(out), "equity_files": stock_files, "stocks": nstock, "recent_failures": fails[-5:]}


def section_prices_twelve():
    """Fallback for watchlist stocks the NSE files did not cover, using the repo's Twelve Data key."""
    key = os.environ.get("TWELVE_DATA_KEY", "").strip()
    wl = read_json("watchlist.json", {})
    pindex = read_json("prices/index.json", {"tickers": {}})
    missing = [s for s in (wl.get("india") or []) if s not in pindex["tickers"]
               or pindex["tickers"][s].get("last", "") < (dt.date.today() - dt.timedelta(days=7)).isoformat()]
    if not missing:
        return {"skipped": "NSE files covered every watchlist stock"}
    if not key:
        raise RuntimeError("%d watchlist stocks have no recent prices and the TWELVE_DATA_KEY secret is not set." % len(missing))
    ok, failed = 0, {}
    for s in missing:
        try:
            bars = twelve_daily(s, key)
            if len(bars) < 60:
                raise ValueError("only %d bars" % len(bars))
            save_prices(pindex, s, bars, "Twelve Data", "INR")
            ok += 1
        except Exception as exc:
            failed[s] = str(exc)[:160]
            if re.search(r"plan|upgrade|available starting|run out of API credits", str(exc), re.I):
                failed["(rest)"] = "stopped: " + str(exc)[:160]
                break
        time.sleep(8.5)
    pindex["updated"] = NOW
    write_json("prices/index.json", pindex)
    if not ok:
        raise RuntimeError("Twelve Data returned no Indian prices: %s" % json.dumps(failed)[:400])
    return {"ok": ok, "failed": failed}


SECTIONS = {"nse_daily": section_nse_daily, "prices_twelve": section_prices_twelve,
            "india_deals": section_india_deals, "india_fiidii": section_india_fiidii}


def main(argv):
    want = argv or list(SECTIONS)
    status = {k: v for k, v in read_json("status.json", {}).items() if k in SECTIONS}
    for name in want:
        log("==", name)
        t0 = time.time()
        try:
            detail = SECTIONS[name]()
            status[name] = {"ok": True, "at": NOW, "detail": detail}
        except Exception as exc:
            traceback.print_exc()
            prev = status.get(name, {})
            status[name] = {"ok": False, "at": NOW, "error": str(exc)[:500],
                            "last_ok": prev.get("at") if prev.get("ok") else prev.get("last_ok")}
        log("   %s in %.1fs" % ("ok" if status[name]["ok"] else "FAILED", time.time() - t0))
    write_json("status.json", status)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

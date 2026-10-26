#!/usr/bin/env python3
"""Scheduled data job for Trader Desk. Standard library only.

Runs on GitHub Actions (servers, so no browser cross-origin limits) and writes
JSON the static site reads from its own origin:

    data/prices/index.json        which tickers have daily bars, and when
    data/prices/<file>.json       ~2 years of daily OHLCV per watchlist ticker
    data/flows/us_13f.json        what big US funds bought and sold last quarter
    data/flows/in_deals.json      NSE bulk and block deals, last 30 trading days
    data/flows/in_fiidii.json     FII/FPI and DII net cash-market flows, daily
    data/status.json              what worked and what failed on the last run

Every section is independent: a failure is recorded in status.json and the
previous file is kept, so one blocked source never blanks the site.

    python3 scripts/fetch_data.py                 # everything
    python3 scripts/fetch_data.py prices flows13f # some sections
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
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
sys.path.insert(0, os.path.join(ROOT, "scripts", "vendor"))
import edgar13f as E  # noqa: E402  (vendored, MIT: see scripts/vendor/NOTICE.md)

BROWSER_UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
              "Chrome/126.0 Safari/537.36")
NOW = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


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


# ------------------------------------------------------------------ prices

def safe_name(symbol):
    return re.sub(r"[^A-Za-z0-9.\-]", "_", symbol) + ".json"


def yahoo_daily(symbol):
    """~2 years of daily bars from Yahoo's chart endpoint (unofficial)."""
    q = urllib.request.quote(symbol, safe="")
    last = None
    for host in ("query1", "query2"):
        url = "https://%s.finance.yahoo.com/v8/finance/chart/%s?range=2y&interval=1d&includePrePost=false" % (host, q)
        try:
            j = json.loads(http_get(url).decode("utf-8"))
            break
        except Exception as exc:  # try the other host once
            last = exc
            time.sleep(1.5)
    else:
        raise last
    res = (j.get("chart") or {}).get("result") or []
    if not res:
        err = (j.get("chart") or {}).get("error") or {}
        raise ValueError(err.get("description") or "no result")
    r = res[0]
    ts = r.get("timestamp") or []
    qd = (r.get("indicators") or {}).get("quote", [{}])[0]
    offset = (r.get("meta") or {}).get("gmtoffset", 0)
    bars = []
    for i, t in enumerate(ts):
        o, h, l, c, v = (qd.get(k, [None] * len(ts))[i] for k in ("open", "high", "low", "close", "volume"))
        if None in (o, h, l, c) or min(o, h, l, c) <= 0:
            continue
        day = dt.datetime.fromtimestamp(t + offset, dt.timezone.utc).strftime("%Y-%m-%d")
        bars.append([day, round(o, 4), round(h, 4), round(l, 4), round(c, 4), int(v or 0)])
    # Yahoo can repeat the current day; keep the last row per date.
    dedup = {}
    for b in bars:
        dedup[b[0]] = b
    bars = [dedup[k] for k in sorted(dedup)]
    meta = r.get("meta") or {}
    return bars, meta.get("currency"), meta.get("exchangeName")


def section_prices():
    wl = read_json("watchlist.json", {})
    symbols = list(dict.fromkeys((wl.get("us") or []) + (wl.get("india") or [])))
    index = read_json("prices/index.json", {"tickers": {}})
    ok, failed = 0, {}
    for s in symbols:
        try:
            bars, ccy, exch = yahoo_daily(s)
            if len(bars) < 60:
                raise ValueError("only %d bars" % len(bars))
            fname = safe_name(s)
            write_json("prices/" + fname, {"symbol": s, "currency": ccy, "exchange": exch,
                                           "source": "Yahoo Finance chart data (unofficial)",
                                           "fetched": NOW, "bars": bars})
            index["tickers"][s] = {"file": fname, "last": bars[-1][0], "bars": len(bars),
                                   "currency": ccy, "exchange": exch}
            ok += 1
        except Exception as exc:
            failed[s] = str(exc)[:200]
            log("  price fail", s, exc)
        time.sleep(0.6)
    index["updated"] = NOW
    index["source"] = "Yahoo Finance chart data (unofficial), fetched by a scheduled GitHub Action"
    write_json("prices/index.json", index)
    if ok == 0:
        raise RuntimeError("no prices fetched: %s" % json.dumps(failed)[:500])
    return {"ok": ok, "failed": failed}


# ------------------------------------------------------------------ US 13F

FUNDS = ["0001067983", "0001336528", "0001350694", "0001697748", "0001536411",
         "0001656456", "0001061768", "0001040273", "0001029160", "0001037389",
         "0001167483", "0001135730", "0001791786", "0000949509", "0001166559"]
FLOWS_PER_FUND = 25


def section_flows13f():
    ua = os.environ.get("SEC_USER_AGENT", "").strip()
    if not ua:
        raise RuntimeError("SEC_USER_AGENT is not set. SEC requires a name and email on every request.")
    fetcher = E.Fetcher(ua=ua, pause=0.15)
    filers = {f["cik"]: f for f in E.load_filers()}
    index = E.ticker_index(fetcher)
    overrides = E.load_overrides([E.CLASSES])
    funds, flows, errors = [], [], {}
    for cik in FUNDS:
        info = filers.get(cik, {})
        try:
            meta, rows, _ = E.load_quarter(fetcher, cik)
            pmeta, prows, _ = E.load_quarter(fetcher, cik, before=meta["period"])
            now, total = E.build(meta, rows, index, overrides)
            prev, _ = E.build(pmeta, prows, index, overrides)
            now = [p for p in now if E.is_stock(p)]
            prev = [p for p in prev if E.is_stock(p)]
            names = {p["cusip"]: p.get("name") or p["issuer"] for p in prev + now}
            moves = []
            for d in E.diff(now, prev):
                if d["status"] == "UNCHANGED":
                    continue
                sh, val = (d["shares_after"], d["value_after"]) if d["shares_after"] else (d["shares_before"], d["value_before"])
                price = val / sh if sh else 0
                value = abs(d["change"]) * price
                if value <= 0:
                    continue
                moves.append({"player": info.get("name") or meta["filer"], "cik": cik,
                              "stock": names.get(d["cusip"]) or E.pretty_name(d["issuer"]), "ticker": d.get("ticker"),
                              "cusip": d["cusip"],
                              "side": "buy" if d["status"] in ("NEW", "ADDED") else "sell",
                              "kind": d["status"].lower().replace(" ", "_"),
                              "shares": d["change"], "value": round(value),
                              "change_pct": d["change_pct"]})
            moves.sort(key=lambda m: -m["value"])
            flows.extend(moves[:FLOWS_PER_FUND])
            funds.append({"name": info.get("name") or meta["filer"], "person": info.get("person", ""),
                          "cik": cik, "period": meta["period"], "prior_period": pmeta["period"],
                          "filed": meta["filed"], "accession": meta["accession"],
                          "portfolio_value": round(total), "moves": len(moves)})
            log("  13F", meta["filer"], meta["period"], len(moves), "moves")
        except Exception as exc:
            errors[cik] = str(exc)[:300]
            log("  13F fail", cik, exc)
    if not funds:
        raise RuntimeError("no 13F filings read: %s" % json.dumps(errors)[:500])
    periods = sorted({f["period"] for f in funds})
    write_json("flows/us_13f.json", {
        "updated": NOW, "source": "SEC EDGAR 13F-HR information tables",
        "latest_period": periods[-1], "periods": periods, "funds": funds, "flows": flows,
        "errors": errors,
        "method": "Change in shares between the two latest 13F-HR filings of each fund, valued at the "
                  "quarter-end price implied by the filing (value / shares). Long US stock positions only; "
                  "options, bonds, shorts and trades inside the quarter are not visible.",
    })
    return {"funds": len(funds), "flows": len(flows), "errors": errors}


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
    deals = sorted((d for d in merged.values() if d["date"] in dates), key=lambda d: (d["date"], -d["value"]), reverse=True)
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


SECTIONS = {"prices": section_prices, "flows13f": section_flows13f,
            "india_deals": section_india_deals, "india_fiidii": section_india_fiidii}


def main(argv):
    want = argv or list(SECTIONS)
    status = read_json("status.json", {})
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

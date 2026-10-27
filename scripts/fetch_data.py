#!/usr/bin/env python3
"""Scheduled data job for Trader Desk (Indian markets). Standard library only.

Runs on GitHub Actions and writes JSON the static site reads from its own
origin:

    data/indices/index.json     every NSE index: latest close, change and 1D-1Y returns
    data/indices/<slug>.json    ~2 years of daily history per index
    data/prices/index.json      which watchlist stocks have daily bars
    data/prices/<file>.json     daily OHLCV per watchlist stock
    data/flows/in_deals.json    NSE bulk and block deals, last 30 trading days
    data/flows/in_fiidii.json   FII/FPI and DII net cash-market flows, daily
    data/status.json            what worked and what failed on the last run

Sources: Angel One SmartAPI (your own account, via repository secrets) for
daily candles of every NSE index and the watchlist stocks; Twelve Data as an
optional fallback for stocks; NSE's bulk/block deal and FII/DII reports for
Big Money. Every section is independent; a failure keeps the previous files.

    python3 scripts/fetch_data.py                   # everything
    python3 scripts/fetch_data.py angel india_deals
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


# ------------------------------------------------------------------ Angel One SmartAPI

ANGEL_ROOT = "https://apiconnect.angelone.in"
SCRIP_MASTER = "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json"
HISTORY_DAYS = 760  # ~2 years of trading days; ONE_DAY candles allow far more per request


def totp_now(secret_b32, step=30, digits=6):
    """RFC 6238 TOTP (the code an authenticator app shows), from the base32 secret."""
    import base64, hashlib, hmac, struct
    key = base64.b32decode(secret_b32.replace(" ", "").upper() + "=" * (-len(secret_b32.replace(" ", "")) % 8))
    mac = hmac.new(key, struct.pack(">Q", int(time.time()) // step), hashlib.sha1).digest()
    o = mac[-1] & 0x0F
    return str((struct.unpack(">I", mac[o:o + 4])[0] & 0x7FFFFFFF) % 10 ** digits).zfill(digits)


class Angel(object):
    """The two SmartAPI calls this job needs, with the headers Angel One's official client sends."""

    def __init__(self, api_key):
        self.api_key, self.jwt = api_key, None

    def _post(self, route, payload):
        h = {"Content-Type": "application/json", "Accept": "application/json", "X-UserType": "USER",
             "X-SourceID": "WEB", "X-ClientLocalIP": "127.0.0.1", "X-ClientPublicIP": "127.0.0.1",
             "X-MACAddress": "00:00:00:00:00:00", "X-PrivateKey": self.api_key, "User-Agent": HONEST_UA}
        if self.jwt:
            h["Authorization"] = "Bearer " + self.jwt
        req = urllib.request.Request(ANGEL_ROOT + route, data=json.dumps(payload).encode(), headers=h, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                j = json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", "replace")[:200]
            raise RuntimeError("Angel One HTTP %s: %s" % (exc.code, body))
        if not j.get("status"):
            raise RuntimeError("Angel One: %s (%s)" % (j.get("message") or "error", j.get("errorcode") or j.get("errorCode") or "-"))
        return j.get("data")

    def login(self, client, mpin, totp_secret):
        d = self._post("/rest/auth/angelbroking/user/v1/loginByPassword",
                       {"clientcode": client, "password": mpin, "totp": totp_now(totp_secret)})
        self.jwt = d["jwtToken"]

    def daily(self, exchange, token, days=HISTORY_DAYS):
        end = dt.datetime.now()
        start = end - dt.timedelta(days=days)
        for attempt in range(3):
            try:
                rows = self._post("/rest/secure/angelbroking/historical/v1/getCandleData", {
                    "exchange": exchange, "symboltoken": str(token), "interval": "ONE_DAY",
                    "fromdate": start.strftime("%Y-%m-%d 09:15"), "todate": end.strftime("%Y-%m-%d 15:30")}) or []
                break
            except RuntimeError:
                if attempt == 2:
                    raise
                time.sleep(2 + attempt * 3)  # rate limit or a transient error: back off and retry
        bars = {}
        for r in rows:
            day = str(r[0])[:10]
            o, h, l, c = (float(x) for x in r[1:5])
            if c > 0:
                bars[day] = [day, o or c, max(h, o, c), min(l or c, o or c, c), c, int(r[5] or 0)]
        return [bars[k] for k in sorted(bars)]


GROUPS = [
    ("Volatility", r"\bVIX\b"),
    ("Fixed income", r"G-?SEC|\bGS\b|\bGILT\b|\bBOND|T-?BILL|\bSDL\b|\bAAA\b|1D RATE|TARGET MATURITY|LIQUID (FUND|RATE)|MONEY MARKET|CORPORATE"),
    ("Strategy", r"ALPHA|LOW[ -]?VOL|\bLV\b|QUALITY|QUALTY|QLTY|LIQUID \d|LIQ \d|GROWTH SECTORS|GROWSECT|DIVIDEND POINTS|DIV POINT|\dX (INV|LEV)|VALUE|MOMENTUM|\bMOM\b|EQUAL[ -]?WEIGHT|EQL ?WGT|\bEW\b|DIV(IDEND)? OPP|HIGH BETA|GROWTH|ARBITRAGE|LEVERAGE|INVERSE"),
    ("Broad market", r"^NIFTY ?(50|NEXT 50|100|200|500|MIDCAP|SMALLCAP|SMLCAP|MICROCAP|LARGEMIDCAP|LARGEMID|MIDSMALLCAP|MIDSMLCAP|TOTAL MARKET|TOTAL MKT|MIDCAP SELECT|MID SELECT|MIDSMALLCAP|MIDSML)( ?\d+)?( SELECT)?$|^NIFTY ?500 (MULTICAP|LARGEMIDSMALL)"),
    ("Sectoral", r"\b(BANK|AUTO|FIN|FINANCIAL|FMCG|IT|MEDIA|METAL|PHARMA|PSU BANK|PVT BANK|PRIVATE BANK|REALTY|HEALTHCARE|CONSUMER DURABLES|OIL ?& ?GAS|OIL AND GAS|CHEMICALS|ENERGY|COMMODITIES|INFRA(STRUCTURE)?|SERVICES SECTOR|CAPITAL MARKETS|INSURANCE|TELECOM)\b"),
]


# Angel One's instrument list abbreviates index names; spell them out as NSE does.
PRETTY = [(r"\bSMLCAP\b", "Smallcap"), (r"\bMIDSML\b", "MidSmallcap"), (r"\bMID SELECT\b", "Midcap Select"),
          (r"\bEQL Wgt\b", "Equal Weight"), (r"LowVol ?(\d+)", r"Low Volatility \1"), (r"Qualty ?(\d+)", r"Quality \1"),
          (r"\bQUALTY ?(\d+)", r"Quality \1"), (r"\bFin Service\b", "Financial Services"), (r"\bPvt Bank\b", "Private Bank"),
          (r"\bGS Compsite\b", "G-Sec Composite"), (r"\bGS\b", "G-Sec"), (r"\bCln\b", "Clean Price"),
          (r"\b(\d+) (\d+)Yr\b", r"\1-\2 Yr"), (r"\bDiv Opps\b", "Dividend Opportunities"), (r"\bDiv Point\b", "Dividend Points"),
          (r"\bServ Sector\b", "Services Sector"), (r"\bLiq (\d+)", r"Liquid \1"), (r"\bGrowSect (\d+)", r"Growth Sectors \1"),
          (r"\bPR 1x Inv\b", "1x Inverse (PR)"), (r"\bTR 1x Inv\b", "1x Inverse (TR)"), (r"\bPR 2x Lev\b", "2x Leverage (PR)"),
          (r"\bTR 2x Lev\b", "2x Leverage (TR)"), (r"^NIFTY(?=\b|\d)", "Nifty")]


def pretty_index(name):
    for rx, rep in PRETTY:
        name = re.sub(rx, rep, name, flags=re.I if rx.startswith("^") else 0)
    name = re.sub(r"\b(MIDCAP|ALPHA)\b", lambda m: m.group(1).capitalize(), name)
    return re.sub(r"\s+", " ", name).strip()


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


def section_angel():
    env = {k: os.environ.get(k, "").strip() for k in ("ANGEL_API_KEY", "ANGEL_CLIENT_CODE", "ANGEL_MPIN", "ANGEL_TOTP_SECRET")}
    missing = [k for k, v in env.items() if not v]
    if missing:
        raise RuntimeError("Add these repository secrets for Angel One SmartAPI: %s "
                           "(Settings > Secrets and variables > Actions > New repository secret)." % ", ".join(missing))
    api = Angel(env["ANGEL_API_KEY"])
    api.login(env["ANGEL_CLIENT_CODE"], env["ANGEL_MPIN"], env["ANGEL_TOTP_SECRET"])
    log("  logged in to SmartAPI")

    master = json.loads(http_get(SCRIP_MASTER, {"User-Agent": HONEST_UA}, timeout=120).decode("utf-8"))
    indices = [m for m in master if m.get("exch_seg") == "NSE" and m.get("instrumenttype") == "AMXIDX"]
    eq = {m["symbol"][:-3]: m for m in master if m.get("exch_seg") == "NSE" and str(m.get("symbol", "")).endswith("-EQ")}
    log("  scrip master: %d NSE indices, %d NSE equities" % (len(indices), len(eq)))
    del master

    out, failed = {}, {}
    for m in indices:
        # The instrument list keeps the readable index name ("Nifty Bank") in "symbol" and a
        # short code ("BANKNIFTY") in "name"; use whichever is the longer, readable one.
        cands = [str(m.get("symbol") or "").strip(), str(m.get("name") or "").strip()]
        raw = re.sub(r"\s+", " ", max(cands, key=lambda x: (" " in x, len(x))))
        if re.search(r"BEES|-NAV\b", raw, re.I):
            continue  # an ETF's net asset value, not an index
        name = pretty_index(raw)
        key = slug(name)
        if not key or key in out:
            continue
        try:
            bars = api.daily("NSE", m["token"])
            if len(bars) < 2:
                raise ValueError("only %d bars" % len(bars))
            fname = key + ".json"
            write_json("indices/" + fname, {"name": name, "token": m["token"], "source": "Angel One SmartAPI", "bars": bars[-520:]})
            out[key] = {"name": name, "group": group_of(name), "file": fname, "last": bars[-1][0], "close": bars[-1][4],
                        "chg": ret(bars, 1), "r1w": ret(bars, 5), "r1m": ret(bars, 21), "r3m": ret(bars, 63), "r1y": ret(bars, 250),
                        "pe": None, "pb": None, "dy": None, "bars": len(bars),
                        "aliases": sorted({slug(raw), slug(m.get("name") or "")} - {key, ""})}
        except Exception as exc:
            failed[name] = str(exc)[:160]
            if "token" in str(exc).lower() and "invalid" in str(exc).lower():
                raise
        time.sleep(0.4)  # SmartAPI historical data: a few requests a second
    if out:
        write_json("indices/index.json", {"updated": NOW, "source": "Angel One SmartAPI daily candles (NSE)", "indices": out})

    wl = read_json("watchlist.json", {})
    pindex = read_json("prices/index.json", {"tickers": {}})
    nstock = 0
    for s in [x for x in (wl.get("india") or []) if x.endswith(".NS")]:
        m = eq.get(s[:-3])
        if not m:
            failed[s] = "not an NSE -EQ symbol in Angel One's instrument list"
            continue
        try:
            bars = api.daily("NSE", m["token"])
            if len(bars) < 60:
                raise ValueError("only %d bars" % len(bars))
            save_prices(pindex, s, bars[-520:], "Angel One SmartAPI", "INR")
            nstock += 1
        except Exception as exc:
            failed[s] = str(exc)[:160]
        time.sleep(0.4)
    pindex["updated"] = NOW
    write_json("prices/index.json", pindex)
    if not out and not nstock:
        raise RuntimeError("SmartAPI returned no data: %s" % json.dumps(failed)[:400])
    return {"indices": len(out), "stocks": nstock, "failed_count": len(failed), "failed": dict(list(failed.items())[:12])}


def section_prices_twelve():
    """Fallback for watchlist stocks SmartAPI did not cover, using the repo's Twelve Data key."""
    key = os.environ.get("TWELVE_DATA_KEY", "").strip()
    wl = read_json("watchlist.json", {})
    pindex = read_json("prices/index.json", {"tickers": {}})
    missing = [s for s in (wl.get("india") or []) if s not in pindex["tickers"]
               or pindex["tickers"][s].get("last", "") < (dt.date.today() - dt.timedelta(days=7)).isoformat()]
    if not missing:
        return {"skipped": "every watchlist stock already has recent prices"}
    if not key:
        return {"skipped": "optional TWELVE_DATA_KEY not set", "without_recent_prices": missing[:20]}
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


SECTIONS = {"angel": section_angel, "prices_twelve": section_prices_twelve,
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

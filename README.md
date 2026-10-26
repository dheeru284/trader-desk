# Trader Desk India

A research and simulation desk for NSE and BSE stocks and every NSE index:
chart scan, entry/exit planning, position sizing, Monte Carlo, backtests,
money-flow of big players, portfolio, journal and alerts. It runs in your
browser as a static site, hosted free on GitHub Pages.

**Not financial advice.** This is software that does arithmetic on historical
data. It cannot see the future and cannot place orders.

## Tabs and agents

| # | Agent | Tab | What it does |
|---|-------|-----|--------------|
| – | Indices | Indices | Every NSE index (broad, sectoral, thematic, strategy, India VIX, fixed income): heat grid coloured by 1D/1W/1M/3M/1Y return, key index tiles, breadth, sortable table; click to analyse |
| – | Big Money | Big Money | Sellers → stock → buyers money-flow diagram of NSE bulk and block deals (same-day round trips netted out), FII/FPI vs DII daily net flows |
| 1 | Chart Scanner | Desk | SMA 20/50/200, RSI 14, MACD, Bollinger, ATR, volume anomalies, support/resistance, 52-week range, realised volatility |
| 2 | News Monitor | Desk | No free feed covers Indian companies; points you to NSE announcements |
| 3 | Entry Timer | Desk | Confluence checklist (reward:risk measured to the next level), pullback zone, breakout trigger |
| 4 | Exit Planner | Desk | Structure-based stop (1 ATR minimum), target at the next level or 2R, a second target |
| 5 | Risk Manager | Desk | Fixed-fractional sizing, position cap, NSE lot sizes for options, India warnings (no overnight cash shorts, circuit limits, STT and charges, indices only via ETFs/F&O) |
| 6 | Time Machine | Desk | Monte Carlo (10,000 paths) bootstrapping historical daily returns: win rate, P&L percentiles, P(stop) vs P(target), drawdown |
| 7 | Portfolio Tracker | Portfolio | Weights, P&L, concentration warnings, rebalance trades vs target weights, in ₹ |
| 8 | Sentiment Analyzer | Desk | Headline keyword score when headlines exist |
| 9 | Trade Journal | Journal | Log and close trades; win rate, P&L and average R by setup |
| 10 | Backtester | Backtester | SMA cross, RSI mean reversion, MACD cross, Donchian breakout over 3–24 months with ATR stops and Indian cost defaults |
| 11 | Alert System | Alerts | Price, RSI and % move alerts with browser notifications |

## Tickers

Pick **Market** on the Desk: NSE stock (`RELIANCE`), NSE index (`NIFTY 50`,
`NIFTY BANK`, `INDIA VIX`; typing a name that starts with NIFTY switches to
index automatically) or BSE stock (`RELIANCE.BO`).

## Data

| Source | What | Setup |
|---|---|---|
| **Daily NSE data** (default) | Every NSE index and the stocks in `data/watchlist.json`, ~2 years of daily candles | A scheduled GitHub Action, through your Angel One SmartAPI account (below) |
| Twelve Data | Stocks on request (its free plan may not include Indian exchanges; its own message is shown) | Free key in the app's Settings |
| Alpha Vantage | BSE listings, last 100 days | Free key in Settings |
| CSV | Any stock or index | Download from nseindia.com, niftyindices.com, bseindia.com or your broker (e.g. Zerodha Console) |
| NSE reports | Bulk/block deals and FII/DII flows for Big Money | Automatic (see caveat) |

### One-time setup: Angel One SmartAPI

The daily job logs in to **your** Angel One account with SmartAPI's documented
TOTP login and downloads daily candles. It only reads market data; it never
places orders.

1. Sign in at **smartapi.angelbroking.com** with your Angel One client ID and
   create an app whose type includes historical data. Copy its **API key**.
2. Enable TOTP for SmartAPI (the "Enable TOTP" option on the SmartAPI site).
   When the QR code is shown, also copy the **text key** shown with it (a
   base32 string of letters A–Z and digits 2–7).
   Add it to your authenticator app too, so you keep using it normally.
3. In this repo: **Settings → Secrets and variables → Actions → New repository
   secret**, add:
   - `ANGEL_API_KEY`: the app's API key
   - `ANGEL_CLIENT_CODE`: your Angel One client ID
   - `ANGEL_MPIN`: your 4-digit MPIN
   - `ANGEL_TOTP_SECRET`: the base32 TOTP secret from step 2
4. **Actions → "Update data and deploy" → Run workflow**. It then runs every
   weekday at 19:10 IST.

Secrets are encrypted by GitHub, passed only to the job, and never written to
logs or data files. Anyone with write access to the repo's workflows could use
them, so keep the repo's collaborators to yourself. You can revoke the API key
at any time on smartapi.angelbroking.com.

Optional: `TWELVE_DATA_KEY` as a secret fills in watchlist stocks SmartAPI
did not return.

**Caveat on Big Money:** NSE serves its deal and FII/DII reports only to
clients that present a browser user agent, so those two downloads do. NSE can
block that at any time and its terms may not permit automated access; delete
the `india_deals` and `india_fiidii` sections in `scripts/fetch_data.py` if
that matters to you. NSE's index and price files are not used, for the same
reason.

## Host it free

**GitHub Pages:** `.github/workflows/pages.yml` updates data and publishes the
site. Once: repo **Settings → Pages → Source: GitHub Actions**. The site is at
`https://dheeru284.github.io/trader-desk/`.

**Locally:** open `index.html` in a browser (no build step); the daily-data
source needs the site served over http.

## Known limits

- Daily bars only, updated once each weekday evening; nothing is intraday.
- The Monte Carlo checks stop and target on closes, so it misses intraday touches but includes gap-through-stop losses. Bootstrapped returns keep the past year's fat tails but not volatility clustering or regime changes.
- Options are valued at intrinsic at expiry only: no Greeks or IV. You enter the premium and the lot size.
- The backtest is long-only, without survivorship-bias or dividend adjustment. A handful of trades is not evidence.
- Index valuation (P/E, P/B, dividend yield) is not available from SmartAPI.
- Alerts only check while the page is open.

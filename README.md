# Trader Desk

An eleven-agent trade research desk that runs entirely in your browser. It has no
server, no account and no build step, so it hosts free on GitHub Pages, Netlify
or Cloudflare Pages.

**Not financial advice.** This is software that does arithmetic on historical
data. It cannot see the future and cannot place orders.

## The agents

| # | Agent | Where | What it does |
|---|-------|-------|--------------|
| 1 | Chart Scanner | Desk | SMA 20/50/200, RSI 14, MACD 12/26/9, Bollinger 20/2, ATR 14, volume z-score anomalies, swing-pivot support/resistance, 52-week range, realised vol |
| 2 | News Monitor | Desk | Finnhub company news (14 days), flags high-impact keywords (earnings, guidance, downgrade, FDA, lawsuit, M&A…) |
| 3 | Entry Timer | Desk | Confluence checklist, pullback zone, breakout trigger |
| 4 | Exit Planner | Desk | Structure-based stop (1 ATR minimum), target at the next level or 2R, a second target |
| 5 | Risk Manager | Desk | Fixed-fractional sizing, position cap, gap and losing-streak warnings, overlap with your portfolio |
| 6 | Time Machine | Desk | Monte Carlo (default 10,000 paths) bootstrapping historical daily returns: win rate, mean/median P&L, 5th/95th percentile, P(stop) vs P(target), max drawdown |
| 7 | Portfolio Tracker | Portfolio | Weights, P&L, concentration warnings, rebalance trades vs target weights |
| 8 | Sentiment Analyzer | Desk | Headline keyword score (no social data: see limits) |
| 9 | Trade Journal | Journal | Log trades, close them, win rate / P&L / average R by setup tag |
| 10 | Backtester | Backtester | SMA cross, RSI mean reversion, MACD cross, Donchian breakout over 3–24 months, with ATR stops, costs and buy-and-hold comparison |
| 11 | Alert System | Alerts | Price, RSI, % move and headline-keyword alerts, with browser notifications |

## Data

Paste free keys in **Settings**. They're stored only in your browser and sent
only to their provider.

- **Twelve Data** (recommended for prices): ~600 daily bars, 800 calls/day free.
- **Alpha Vantage**: the free tier gives only 100 daily bars, too short for a 200-day average or a 12-month backtest.
- **Finnhub**: news.
- **CSV upload**: any `Date,Open,High,Low,Close[,Adj Close],Volume` export.
- **Demo**: synthetic prices seeded from the ticker name, clearly bannered. Not real.

## US and Indian markets

Pick **Market** on the Desk (US, India · NSE, India · BSE), or type the suffix
yourself: `RELIANCE.NS` (NSE), `RELIANCE.BO` (BSE). The suffix is how the
Portfolio, Journal and Alerts tabs know a ticker's market.

| | US | India |
|---|---|---|
| Prices | Twelve Data (free) | Twelve Data with `exchange=NSE/BSE` (the free plan may not include Indian exchanges; its message is shown), Alpha Vantage BSE listing (free, 100 bars), or CSV |
| CSV | Yahoo/broker exports, MM/DD dates | nseindia.com / bseindia.com historical downloads, broker exports; quoted `"2,912.40"` numbers, `18-Oct-2025` and DD/MM dates |
| News | Finnhub | Not available on free feeds |
| Currency | $ | ₹ with Indian digit grouping (₹1,00,000) |
| Options | 100 shares per contract | Lot size entered by you (NSE sets and revises it per contract) |
| Backtest cost default | 5 bps per side | 15 bps per side (STT, exchange, GST, stamp duty) |
| Extra risk warnings | | No overnight shorts in cash equities, circuit limits, delivery charges |

Portfolio and Journal keep US and Indian holdings in separate sections with
separate totals. Rupees and dollars are never added together.

## Host it free

**GitHub Pages:** the workflow in `.github/workflows/pages.yml` publishes the
site whenever `main` changes. Once: repo **Settings → Pages → Source: GitHub
Actions**. The site appears at `https://dheeru284.github.io/trader-desk/`.

**Netlify / Cloudflare Pages:** connect the repo, leave the build command empty,
set the publish directory to `.` (the repo root).

**Locally:** open `index.html` in a browser. It uses no modules, so `file://`
works.

## Known limits

- Daily bars only; the Monte Carlo checks stop and target on closes, so it misses intraday touches but does include gap-through-stop losses.
- Bootstrapped i.i.d. returns keep the fat tails of the past year but not volatility clustering, regime changes, or earnings jumps that didn't occur in the window.
- Options are valued at intrinsic at expiry only: no Greeks, IV, early exit or options-chain data. You enter the premium.
- The backtest is long-only and has no survivorship-bias or dividend adjustment. A handful of trades is not evidence.
- Sentiment is a word count on headlines. No social-media feed is connected.
- Alerts only check while the page is open and a ticker is loaded.
- Whether a provider allows browser (CORS) requests is the provider's choice and can change. If a source fails, switch source or use CSV.

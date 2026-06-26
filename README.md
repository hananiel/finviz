# Sector Rotation Scanner

S&P 500 sector rotation dashboard that detects institutional capital flows across the 11 GICS sectors. Deploys as a static site to GitHub Pages, updated daily after market close.

**Live site:** `https://<owner>.github.io/finviz/`

---

## Architecture

```
src/
├── scraper.ts     Data fetching (Finviz, Yahoo Finance, SEC EDGAR)
├── analyzer.ts    All analytical computations
├── build.ts       Static site builder (→ docs/)
├── verify.ts      Post-build validation (27 checks)
├── index.ts       CLI entry point (terminal output with chalk)
├── display.ts     Terminal table rendering (chalk + cli-table3)
├── server.ts      Optional local dev server
├── types.ts       All TypeScript interfaces
docs/
├── index.html     Single-file dashboard (HTML + inline CSS + JS)
├── data.json      Latest build output (consumed by dashboard)
├── data.js        Same data as window.__FINVIZ_DATA (file:// fallback)
├── history/       Daily snapshots for historical AUM flow computation
│   ├── index.json   Manifest of available dates
│   └── YYYY-MM-DD.json
```

---

## Data Pipeline

### Sources

| Source | What | How |
|--------|------|-----|
| **Finviz Map API** | Per-stock % returns (1W, 1M, 3M) for ~500 S&P 500 stocks | `finviz.com/api/map_perf.ashx?t=sec&st={w1,w4,w13}` |
| **Finviz Screener** | Sector mapping, market cap, ETF performance, technicals | HTML scraping with cheerio (views v=152, v=140, v=171) |
| **Yahoo Finance** | Current AUM (totalAssets), price, 6-month daily close history | `query2.finance.yahoo.com` (crumb+cookie auth) |
| **SEC EDGAR** | Quarterly net assets from N-PORT filings (4 most recent quarters) | `data.sec.gov/submissions/CIK0001064641.json` → XML parsing |

### ETFs Tracked

**Sector ETFs** (11): XLK, XLF, XLE, XLV, XLY, XLP, XLI, XLB, XLC, XLRE, XLU

**Asset Class ETFs** (13): SPY, TLT, IEF, SHY, BIL, GLD, GDX, DBC, USO, IBIT, BITO, EFA, EEM

### Computation Flow

```
fetchAllData()
  ├── 3× fetchMapPerformance (1W/1M/3M)     → per-stock returns
  ├── fetchSectorMapping                      → ticker → sector/industry/mcap
  ├── fetchSectorETFs                         → ETF perf + volume
  ├── fetchAssetClassETFs                     → cross-asset perf
  ├── fetchTechnicalData                      → SMA20/50/200, RSI
  ├── fetchYahooAUM                           → current totalAssets + price
  ├── fetchNPortData                          → quarterly netAssets from SEC
  └── fetchYahooChart                         → 6mo daily closes (~124 prices)

build()
  ├── loadHistoricalAUM(docs/history/)        → Map<ticker, snapshot[]>
  ├── computeFundFlows(...)                   → ETFFundFlow[] (11 sectors)
  ├── aggregateBySector(stocks)               → SectorPerformance[]
  ├── calculateRotationSignals(sectorPerfs)   → RotationSignal[]
  ├── computeSectorDiagnostics(...)           → SectorDiagnostic[]
  ├── validateWithETFs(...)                   → ETFValidation[]
  ├── calculateAssetClassFlows(...)           → AssetClassFlow[]
  ├── buildETFTrendDetails(...)               → ETFTrendDetail[]
  ├── generateActionSignals(...)              → ActionRecommendation[] (×6 modes)
  └── write docs/{data.json, data.js, history/}
```

---

## Features

### 1. Rotation Signal Detection

Composite score per sector from 4 smoothed components:
- **Rank shift** (35%): 3M rank minus 1W rank — positive = sector rising in relative standing
- **Momentum acceleration** (25%): Blended short-term rate (40% 1W + 60% 1M) vs 3M baseline, annualized
- **Institutional spread** (20%): MCW − EW performance (positive = large-cap led = institutional buying)
- **Breadth divergence** (20%): Short-term participation vs 3M participation

Signal thresholds: INFLOW (>10), OUTFLOW (<-10), NEUTRAL (within ±10). Uses hysteresis to prevent whipsaw.

### 2. Fund Flow Computation

Real dollar flows using creation/redemption mechanics:

**Short-term (5d, 1m):** From daily AUM snapshots stored in `docs/history/`.
- Formula: `Flow = AUM_today − AUM_past × (1 + price_return)`
- Fallback when snapshots unavailable: linear shares interpolation from N-PORT anchor + Yahoo chart prices

**Long-term (3m, 6m, 1y):** From SEC N-PORT quarterly netAssets.
- Price return stripped using actual chart prices at N-PORT reporting dates
- Formula: `Flow = AUM_today − N-PORT_netAssets × (1 + return_since_quarter_end)`

**Shares outstanding:** Derived as `totalAssets / price`. Shares % change computed per timeframe to detect creation/redemption independent of price movement.

### 3. Sector Phase Diagnostics

5 independent diagnostic dimensions combined into lifecycle phases:

| Dimension | What it measures | Thresholds |
|-----------|-----------------|------------|
| Momentum regime | 1W annualized vs 3M annualized | ±10% annualized diff |
| Breadth direction | 1W breadth vs 3M breadth | ±5 percentage points |
| Size leadership | MCW − EW spread | ±0.5% |
| Flow-price alignment | Shares % change vs price change | Shares ±0.1%, price ±0.5% |
| Rank velocity | 3M rank − 1W rank | ±2/±4 positions |

**Phases** (ordered by lifecycle):
1. `EARLY_ACCUMULATION` — Breadth broadening + flows in + price flat
2. `CONFIRMED_UPTREND` — Accelerating + confirmed bull or broadening
3. `LATE_STAGE` — Price up + narrowing breadth + flows still positive
4. `DISTRIBUTION` — Price up + shares declining
5. `EARLY_DECLINE` — Decelerating + narrowing
6. `CONFIRMED_DOWNTREND` — Decelerating + confirmed bear or negative shares
7. `NEUTRAL` — No clear pattern

Each phase includes plain-English `evidence[]` strings with raw numbers.

### 4. Trend Phase Classification

Per-ETF trend maturity from SMA distances:
- `EARLY_UPTREND` — Just crossed above SMA50
- `ESTABLISHED_UPTREND` — Above SMA50 and SMA200
- `EXTENDED` — Far above both SMAs (overextended)
- `EARLY_DOWNTREND` — Just crossed below SMA50
- `ESTABLISHED_DOWNTREND` — Below both SMAs
- `COUNTER_TREND_BOUNCE` — Above SMA20, below SMA50
- `PULLBACK_IN_UPTREND` — Below SMA20, above SMA50

### 5. Action Recommendations

Generated for 6 mode combinations (2 capital × 3 strategy):
- **Capital modes:** `deploy` (new capital), `rotate` (rebalancing existing)
- **Strategies:** `momentum`, `contrarian`, `rotation`

Each recommendation has: ticker, action (BUY/SELL/HOLD/TRIM), confidence 0–100, rationale, and supporting factors.

### 6. Asset Class Rotation

Cross-asset flow tracking (equities, bonds, gold, commodities, crypto, international) with flow scores and trend phases.

### 7. Dashboard Visualization

Single-file `docs/index.html` with:
- **Treemap** (squarified algorithm): Sized by AUM, colored by flow magnitude, shows ticker/sector/flow/shares%
- **Diagnostics panel**: Phase cards with evidence lists + metric grids
- **Rotation heatmap**: Sector signals with score breakdown
- **Action signals**: Mode-switchable BUY/SELL/HOLD/TRIM table with confidence bars
- **ETF tables**: Sector + asset class performance with trend phases
- **RRG-style chart**: Relative rotation visualization

Data loaded from `data.js` (embedded) for file:// or fetched from `data.json` for HTTP.

---

## Commands

```bash
npm run build         # Fetch all data, compute analytics, write docs/
npm run verify        # Validate build output (27 checks)
npm run build:check   # Build + verify in one step
npm start             # CLI output (terminal tables with chalk)
npm run start:json    # CLI output as JSON
npm run web           # Local dev server
```

---

## CI/CD

**GitHub Actions** (`.github/workflows/update-data.yml`):
- Runs weekdays at 9:30 PM UTC (4:30 PM ET, after market close)
- Manual trigger via `workflow_dispatch`
- Steps: `npm install` → `npm run build` → `npm run verify` → git push → wait for Pages deploy → verify live site

**Post-deploy verification** checks the live GitHub Pages URL for:
- `renderDashboard` function present
- `__FINVIZ_DATA` reference present
- `squarify` treemap function present
- `flow-treemap` CSS present
- `data.js` returns HTTP 200

---

## Key Interfaces

```typescript
// Per-stock raw data (from Finviz)
StockData { ticker, company, sector, industry, marketCap, perf1W, perf1M, perf3M }

// Aggregated sector metrics
SectorPerformance { sector, stockCount, mcw1W/1M/3M, ew1W/1M/3M, breadth1W/1M/3M, topMovers }

// Rotation signal per sector
RotationSignal { sector, signal, rotationScore, rankShift, momentumAccel, institutionalSpread, breadthDivergence, rank1W, rank3M }

// Fund flow per sector ETF
ETFFundFlow { ticker, sector, totalAssets, sharesOutstanding, sharesPct5Day/1Month/3Month/1Year, flow5Day/1Month/3Month/6Month/1Year }

// Lifecycle phase diagnosis
SectorDiagnostic { sector, ticker, momentumRegime, breadthDirection, sizeLeadership, flowPriceSignal, rankSignal, phase, evidence[] }

// Technical overlay
TechnicalData { ticker, sma20, sma50, sma200, rsi, from52WHigh, from52WLow }
ETFTrendDetail { ticker, label, sma20, sma50, sma200, rsi, trendPhase }

// Action output
ActionRecommendation { ticker, label, action, confidence, rationale, factors[] }

// Data sources
ETFAUMSnapshot { ticker, sector, totalAssets, price, date }
NPortQuarterlyData { seriesId, ticker, sector, netAssets, periodEnd, filingDate }
ChartPriceHistory { ticker, prices: Map<date, price> }
```

---

## Design Decisions

- **No framework** — Single HTML file with inline JS. Zero build step for the frontend.
- **Squarified treemap** — Bruls/Huizing/van Wijk algorithm. Sized by AUM so visual weight = real capital.
- **Price-adjusted flows** — Raw AUM diff includes price appreciation. We strip it using chart prices at N-PORT dates.
- **Linear shares interpolation** — When daily snapshots unavailable, assume constant daily creation/redemption rate from N-PORT anchor to today.
- **Smoothed signals** — Blend 1W (40%) with 1M (60%) for momentum/breadth/spread to prevent single-week whipsaw.
- **Hysteresis thresholds** — Rotation signals use ±10 band to prevent NEUTRAL↔INFLOW oscillation.
- **Dual data format** — `data.json` for HTTP fetch, `data.js` as `window.__FINVIZ_DATA` for local file:// opening.
- **Historical snapshots** — Each build saves to `docs/history/YYYY-MM-DD.json`. Used for short-term flow computation next day.

---

## Rate Limits & Auth

| Source | Auth | Rate Limit |
|--------|------|-----------|
| Finviz | None (User-Agent header) | 300ms between batches, retry on 429 |
| Yahoo Finance | Cookie + crumb (fetched at runtime) | 200ms between requests |
| SEC EDGAR | User-Agent with email | 150ms (10 req/sec policy) |

---

## Adding Features

When adding a new data source or analytical dimension:
1. Define interfaces in `src/types.ts`
2. Add fetcher in `src/scraper.ts` (include in `fetchAllData()` return)
3. Add computation in `src/analyzer.ts` (export function)
4. Wire it in `src/build.ts` (call analyzer, include in `result` object)
5. Render in `docs/index.html` (add to `renderDashboard()`)
6. Add verification checks in `src/verify.ts`
7. Update this README

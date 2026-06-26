// Generates static data.json for GitHub Pages deployment
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchAllData } from "./scraper.js";
import {
  aggregateBySector,
  calculateRotationSignals,
  validateWithETFs,
  calculateAssetClassFlows,
  buildETFTrendDetails,
  generateActionSignals,
  computeSectorDiagnostics,
} from "./analyzer.js";
import type { CapitalMode, Strategy, ETFFundFlow, ETFAUMSnapshot, NPortQuarterlyData, DarkPoolData, DarkPoolAggregate, DarkPoolTrend, OptionsData } from "./types.js";
import type { ChartPriceHistory } from "./scraper.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Load historical AUM snapshots from daily history files */
function loadHistoricalAUM(historyDir: string): Map<string, ETFAUMSnapshot[]> {
  // Map: ticker → array of snapshots sorted by date
  const result = new Map<string, ETFAUMSnapshot[]>();

  try {
    const manifestPath = path.join(historyDir, "index.json");
    const dates: string[] = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));

    for (const date of dates) {
      try {
        const snap = JSON.parse(fs.readFileSync(path.join(historyDir, `${date}.json`), "utf-8"));
        if (snap.aumSnapshots) {
          for (const aum of snap.aumSnapshots) {
            if (!result.has(aum.ticker)) result.set(aum.ticker, []);
            result.get(aum.ticker)!.push(aum);
          }
        }
      } catch {}
    }
  } catch {}

  // Sort each ticker's snapshots by date
  for (const [, snaps] of result) {
    snaps.sort((a, b) => a.date.localeCompare(b.date));
  }

  return result;
}

/** Load historical dark pool data from daily snapshots → Map<ticker, DarkPoolData[]> sorted by date */
function loadHistoricalDarkPool(historyDir: string): Map<string, DarkPoolData[]> {
  const result = new Map<string, DarkPoolData[]>();

  try {
    const manifestPath = path.join(historyDir, "index.json");
    const dates: string[] = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));

    // Only load last 25 days (enough for 20 trading days)
    const recentDates = dates.slice(-25);
    for (const date of recentDates) {
      try {
        const snap = JSON.parse(fs.readFileSync(path.join(historyDir, `${date}.json`), "utf-8"));
        if (snap.darkPoolData) {
          for (const dp of snap.darkPoolData as DarkPoolData[]) {
            if (!result.has(dp.ticker)) result.set(dp.ticker, []);
            result.get(dp.ticker)!.push(dp);
          }
        }
      } catch {}
    }
  } catch {}

  // Sort by date and deduplicate
  for (const [ticker, entries] of result) {
    const seen = new Set<string>();
    const deduped = entries.filter(e => {
      if (seen.has(e.date)) return false;
      seen.add(e.date);
      return true;
    });
    deduped.sort((a, b) => a.date.localeCompare(b.date));
    result.set(ticker, deduped);
  }

  return result;
}

/** Compute dark pool trends from today's data + historical snapshots */
function computeDarkPoolTrends(
  todayAggregates: DarkPoolAggregate[],
  historical: Map<string, DarkPoolData[]>
): DarkPoolTrend[] {
  const trends: DarkPoolTrend[] = [];

  for (const agg of todayAggregates) {
    const history = historical.get(agg.ticker) || [];
    // Append today if not already present
    const allDays = [...history];
    const todayEntry: DarkPoolData = {
      ticker: agg.ticker,
      sector: agg.sector,
      source: "FINRA",
      shortVolume: agg.combinedShortVolume,
      totalVolume: agg.combinedTotalVolume,
      shortRatio: agg.combinedShortRatio,
      date: agg.date,
    };
    if (!allDays.find(d => d.date === agg.date)) {
      allDays.push(todayEntry);
    }
    allDays.sort((a, b) => a.date.localeCompare(b.date));

    const n = allDays.length;
    const shortRatio1d = agg.combinedShortRatio;

    // 5-day average (last 5 data points)
    const last5 = allDays.slice(-5);
    const shortRatio5d = last5.length > 0
      ? last5.reduce((s, d) => s + d.shortRatio, 0) / last5.length
      : shortRatio1d;

    // 20-day average (last 20 data points)
    const last20 = allDays.slice(-20);
    const shortRatio20d = last20.length > 0
      ? last20.reduce((s, d) => s + d.shortRatio, 0) / last20.length
      : shortRatio1d;

    // Trend: is recent (5d) higher or lower than baseline (20d)?
    const diff = shortRatio5d - shortRatio20d;
    let trend: DarkPoolTrend["trend"];
    if (diff > 0.03) trend = "INCREASING";
    else if (diff < -0.03) trend = "DECREASING";
    else trend = "STABLE";

    trends.push({
      ticker: agg.ticker,
      sector: agg.sector,
      shortRatio1d,
      shortRatio5d,
      shortRatio20d,
      trend,
      trendStrength: diff,
      daysOfData: n,
      sourcesAgree: agg.sourcesAgree,
      maxDivergence: agg.maxDivergence,
    });
  }

  return trends;
}

/**
 * Compute fund flows from AUM snapshots and N-PORT data.
 * Flow = AUM_end - AUM_start × (1 + price_return)
 *
 * Short-term (5d, 1m): from daily AUM snapshots (Yahoo totalAssets)
 *   Fallback: interpolate shares from N-PORT anchor + Yahoo chart prices
 * Long-term (3m, 6m, 1y): from SEC N-PORT quarterly netAssets + ETF returns
 */
function computeFundFlows(
  todayAUM: ETFAUMSnapshot[],
  historicalAUM: Map<string, ETFAUMSnapshot[]>,
  nportData: NPortQuarterlyData[],
  etfs: { ticker: string; perf1W: number; perf1M: number; perf3M: number }[],
  chartHistory: ChartPriceHistory[]
): ETFFundFlow[] {
  const flows: ETFFundFlow[] = [];
  const chartMap = new Map(chartHistory.map(c => [c.ticker, c.prices]));

  for (const aum of todayAUM) {
    const { ticker, sector, totalAssets, price } = aum;
    const history = historicalAUM.get(ticker) || [];
    const etf = etfs.find(e => e.ticker === ticker);
    const chart = chartMap.get(ticker);

    // Short-term flows from daily AUM snapshots (preferred)
    let flow5Day = computeFlowFromSnapshots(totalAssets, price, history, 5);
    let flow1Month = computeFlowFromSnapshots(totalAssets, price, history, 22);

    // Fallback: approximate from N-PORT anchor + chart prices when snapshots unavailable
    if (flow5Day === 0 && chart) {
      const tickerNport = nportData
        .filter(n => n.ticker === ticker)
        .sort((a, b) => b.periodEnd.localeCompare(a.periodEnd));
      flow5Day = approximateFlowFromChart(totalAssets, price, tickerNport, chart, 5);
    }
    if (flow1Month === 0 && chart) {
      const tickerNport = nportData
        .filter(n => n.ticker === ticker)
        .sort((a, b) => b.periodEnd.localeCompare(a.periodEnd));
      flow1Month = approximateFlowFromChart(totalAssets, price, tickerNport, chart, 22);
    }

    // Long-term flows from N-PORT quarterly data, adjusted for ETF price return
    const tickerNport = nportData
      .filter(n => n.ticker === ticker)
      .sort((a, b) => b.periodEnd.localeCompare(a.periodEnd)); // newest first

    // Use ETF performance data to strip out price effect from N-PORT comparison
    const perf3M = etf ? etf.perf3M / 100 : 0; // convert % to decimal
    const flow3Month = computeFlowFromNPort(totalAssets, tickerNport, 0, perf3M);

    // For 6m/1y, derive price return from chart data at the N-PORT quarter-end date
    const perf6M = chart ? computeReturnFromChart(price, chart, tickerNport, 1) : 0;
    const perf1Y = chart ? computeReturnFromChart(price, chart, tickerNport, 3) : 0;
    const flow6Month = computeFlowFromNPort(totalAssets, tickerNport, 1, perf6M);
    const flow1Year = computeFlowFromNPort(totalAssets, tickerNport, 3, perf1Y);

    // Shares outstanding: derive from AUM / price
    const sharesOutstanding = price > 0 ? totalAssets / price : 0;

    // Shares % change per timeframe — use same interpolation logic
    // For short-term: interpolated shares from N-PORT anchor
    let sharesPct5Day = 0;
    let sharesPct1Month = 0;
    if (sharesOutstanding > 0 && chart && tickerNport.length > 0) {
      const nport = tickerNport[0];
      const nportPrice = findNearestPrice(chart, nport.periodEnd);
      if (nportPrice && nportPrice > 0) {
        const sharesAtNport = nport.netAssets / nportPrice;
        const sortedDates = [...chart.keys()].sort();
        const todayMs = Date.now();
        const nportDateMs = new Date(nport.periodEnd).getTime();
        const earliestChartMs = new Date(sortedDates[0]).getTime();
        const calendarDaysChartSpan = (todayMs - earliestChartMs) / 86400000;
        const tradingDayRatio = calendarDaysChartSpan > 0 ? sortedDates.length / calendarDaysChartSpan : 0.7;
        const totalTradingDays = Math.max(1, Math.round(((todayMs - nportDateMs) / 86400000) * tradingDayRatio));
        const dailyShareChange = (sharesOutstanding - sharesAtNport) / totalTradingDays;

        const shares5dAgo = sharesOutstanding - dailyShareChange * 5;
        const shares1mAgo = sharesOutstanding - dailyShareChange * 22;
        if (shares5dAgo > 0) sharesPct5Day = (sharesOutstanding - shares5dAgo) / shares5dAgo;
        if (shares1mAgo > 0) sharesPct1Month = (sharesOutstanding - shares1mAgo) / shares1mAgo;
      }
    }
    // For long-term: direct from N-PORT
    const sharesPct3Month = computeSharesPctFromNPort(totalAssets, price, tickerNport, 0, chart);
    const sharesPct1Year = computeSharesPctFromNPort(totalAssets, price, tickerNport, 3, chart);

    flows.push({
      ticker, sector, totalAssets, sharesOutstanding,
      sharesPct5Day, sharesPct1Month, sharesPct3Month, sharesPct1Year,
      flow5Day, flow1Month, flow3Month, flow6Month, flow1Year,
    });
  }

  const nonZero = flows.filter(f => f.flow5Day !== 0 || f.flow1Month !== 0 || f.flow3Month !== 0);
  console.log(`  Computed fund flows for ${flows.length} ETFs (${nonZero.length} have non-zero short-term data)`);

  return flows;
}

/** Compute flow from daily AUM snapshots: Flow = AUM_now - AUM_past × (1 + return) */
function computeFlowFromSnapshots(
  currentAUM: number,
  currentPrice: number,
  history: ETFAUMSnapshot[],
  daysBack: number
): number {
  // Need at least daysBack snapshots to compute meaningful flow
  if (history.length < daysBack) return 0;

  const past = history[history.length - daysBack];
  if (!past || past.price === 0) return 0;

  const priceReturn = (currentPrice - past.price) / past.price;
  // Flow = current AUM - (past AUM adjusted for price movement)
  return currentAUM - past.totalAssets * (1 + priceReturn);
}

/** Compute flow from N-PORT quarterly data, adjusting for price return if available */
function computeFlowFromNPort(
  currentAUM: number,
  nportSorted: NPortQuarterlyData[], // newest first
  quartersBack: number,
  priceReturn: number // ETF price return over the period (decimal, e.g. 0.05 = 5%)
): number {
  if (nportSorted.length <= quartersBack) return 0;

  const past = nportSorted[quartersBack];
  if (!past || past.netAssets === 0) return 0;

  // Flow = current AUM - past netAssets × (1 + price_return)
  // This strips out the price appreciation effect
  if (priceReturn !== 0) {
    return currentAUM - past.netAssets * (1 + priceReturn);
  }
  // Without price return data, raw difference (includes price effect — less accurate)
  return currentAUM - past.netAssets;
}

/**
 * Approximate short-term flow when daily AUM snapshots aren't available yet.
 * Uses the total flow since N-PORT (already computed as 3m flow from the main loop)
 * distributed uniformly across trading days, scaled by chart price movement.
 *
 * Approach:
 * - shares_at_nport = nport_netAssets / earliest_chart_price_near_nport_date
 *   (or extrapolated from current shares if chart doesn't reach nport date)
 * - shares_today = totalAssets_today / price_today
 * - total_share_change = shares_today - shares_at_nport
 * - Assume linear share creation/redemption per trading day
 * - For any past chart date: shares(date) = shares_today - daily_rate × trading_days_since
 * - AUM(date) = shares(date) × price(date)
 * - Flow_Nd = AUM_today - AUM(N_days_ago) × (1 + return)
 */
function approximateFlowFromChart(
  currentAUM: number,
  currentPrice: number,
  nportSorted: NPortQuarterlyData[], // newest first
  chart: Map<string, number>, // date → close price
  daysBack: number
): number {
  if (nportSorted.length === 0 || currentPrice === 0) return 0;

  const nport = nportSorted[0]; // most recent quarter
  const sortedDates = [...chart.keys()].sort();
  if (sortedDates.length < daysBack + 1) return 0;

  // Current shares outstanding
  const sharesToday = currentAUM / currentPrice;

  // Shares at N-PORT date (derived from reported net assets)
  // Use earliest chart price to anchor, or extrapolate from N-PORT netAssets
  const earliestChartDate = sortedDates[0];
  const earliestChartPrice = chart.get(earliestChartDate)!;

  // N-PORT net assets / price at nport date gives shares then
  // If chart doesn't cover nport date, use earliest chart price as best proxy
  const nportPrice = findNearestPrice(chart, nport.periodEnd) || earliestChartPrice;
  const sharesAtNport = nport.netAssets / nportPrice;

  // Trading days from N-PORT to today (approximate using chart length)
  const nportDateMs = new Date(nport.periodEnd).getTime();
  const todayMs = Date.now();
  const earliestChartMs = new Date(earliestChartDate).getTime();

  // Total trading days from nport to today (prorated from chart data density)
  const calendarDaysNportToToday = (todayMs - nportDateMs) / 86400000;
  const calendarDaysChartSpan = (todayMs - earliestChartMs) / 86400000;
  const tradingDaysInChart = sortedDates.length;
  const tradingDayRatio = calendarDaysChartSpan > 0 ? tradingDaysInChart / calendarDaysChartSpan : 0.7;
  const totalTradingDays = Math.max(1, Math.round(calendarDaysNportToToday * tradingDayRatio));

  // Daily share change rate (linear interpolation)
  const dailyShareChange = (sharesToday - sharesAtNport) / totalTradingDays;

  // Get price N trading days ago from chart
  const pastIdx = sortedDates.length - 1 - daysBack;
  if (pastIdx < 0) return 0;
  const pastDate = sortedDates[pastIdx];
  const pastPrice = chart.get(pastDate)!;
  if (pastPrice === 0) return 0;

  // Interpolated shares at that past date
  const sharesAtPast = sharesToday - dailyShareChange * daysBack;

  // Approximate past AUM
  const aumPast = sharesAtPast * pastPrice;
  if (aumPast <= 0) return 0;

  // Flow = AUM_today - AUM_past × (1 + return)
  const priceReturn = (currentPrice - pastPrice) / pastPrice;
  return currentAUM - aumPast * (1 + priceReturn);
}

/** Find price on or closest to a target date from chart data */
function findNearestPrice(chart: Map<string, number>, targetDate: string): number | null {
  if (chart.has(targetDate)) return chart.get(targetDate)!;

  // Find nearest date within 5 days
  const dates = [...chart.keys()].sort();
  const target = new Date(targetDate).getTime();
  let closest: string | null = null;
  let minDiff = Infinity;

  for (const d of dates) {
    const diff = Math.abs(new Date(d).getTime() - target);
    if (diff < minDiff) {
      minDiff = diff;
      closest = d;
    }
  }

  // Only use if within 7 days (covers weekends + holidays near quarter-end)
  if (closest && minDiff < 7 * 86400000) {
    return chart.get(closest)!;
  }
  return null;
}

/**
 * Compute price return from current price to the N-PORT quarter-end date.
 * Returns (price_today - price_at_nport) / price_at_nport as decimal.
 * Returns 0 if the chart doesn't cover the target N-PORT date.
 */
function computeReturnFromChart(
  currentPrice: number,
  chart: Map<string, number>,
  nportSorted: NPortQuarterlyData[],
  quartersBack: number
): number {
  if (nportSorted.length <= quartersBack || currentPrice === 0) return 0;

  const past = nportSorted[quartersBack];
  if (!past) return 0;

  const pastPrice = findNearestPrice(chart, past.periodEnd);
  if (!pastPrice || pastPrice === 0) return 0;

  return (currentPrice - pastPrice) / pastPrice;
}

/**
 * Compute % change in shares from N-PORT quarterly data.
 * shares_today = AUM / price, shares_at_nport = netAssets / price_at_nport
 */
function computeSharesPctFromNPort(
  currentAUM: number,
  currentPrice: number,
  nportSorted: NPortQuarterlyData[],
  quartersBack: number,
  chart: Map<string, number> | undefined
): number {
  if (nportSorted.length <= quartersBack || currentPrice === 0) return 0;

  const past = nportSorted[quartersBack];
  if (!past || past.netAssets === 0) return 0;

  const pastPrice = chart ? findNearestPrice(chart, past.periodEnd) : null;
  if (!pastPrice || pastPrice === 0) return 0;

  const sharesToday = currentAUM / currentPrice;
  const sharesPast = past.netAssets / pastPrice;

  if (sharesPast === 0) return 0;
  return (sharesToday - sharesPast) / sharesPast; // decimal, e.g. 0.05 = +5%
}

async function build() {
  console.log("Building static data...");

  const { stocks, etfs, assetClassETFs, technicals, aumSnapshots, nportData, chartHistory, darkPoolData, darkPoolAggregates, optionsData } = await fetchAllData();

  if (stocks.length === 0) {
    console.error("No stock data fetched.");
    process.exit(1);
  }

  // Load historical AUM snapshots for flow computation
  const docsDir = path.join(__dirname, "..", "docs");
  const historyDir = path.join(docsDir, "history");
  const historicalAUM = loadHistoricalAUM(historyDir);

  // Load historical dark pool data and compute trends (5d/20d averages)
  const historicalDP = loadHistoricalDarkPool(historyDir);
  const darkPoolTrends = computeDarkPoolTrends(darkPoolAggregates, historicalDP);
  console.log(`  Computed dark pool trends for ${darkPoolTrends.length} ETFs (${darkPoolTrends[0]?.daysOfData ?? 0} days of history)`);

  // Compute fund flows from AUM snapshots (short-term) + N-PORT (long-term)
  // Falls back to N-PORT + chart price interpolation when daily snapshots unavailable
  const fundFlows = computeFundFlows(aumSnapshots, historicalAUM, nportData, etfs, chartHistory);

  const sectorPerfs = aggregateBySector(stocks);
  const signals = calculateRotationSignals(sectorPerfs);
  const diagnostics = computeSectorDiagnostics(sectorPerfs, signals, fundFlows, darkPoolTrends, optionsData);
  const etfValidations = validateWithETFs(sectorPerfs, etfs);
  const assetClassFlows = calculateAssetClassFlows(assetClassETFs, technicals);
  const { sectorTrends, assetClassTrends } = buildETFTrendDetails(
    etfs, assetClassETFs, technicals
  );

  const flowMap = new Map(assetClassFlows.map((f) => [f.assetClass, f]));

  // Generate signals for all 6 mode combinations
  const capitalModes: CapitalMode[] = ["deploy", "rotate"];
  const strategies: Strategy[] = ["momentum", "contrarian", "rotation"];
  const actionSignals: Record<string, { sector: ReturnType<typeof generateActionSignals>; assetClass: ReturnType<typeof generateActionSignals> }> = {};

  for (const capital of capitalModes) {
    for (const strategy of strategies) {
      const mode = { capital, strategy };
      const key = `${capital}_${strategy}`;
      actionSignals[key] = {
        sector: generateActionSignals(sectorTrends, flowMap, signals, mode),
        assetClass: generateActionSignals(assetClassTrends, flowMap, undefined, mode),
      };
    }
  }

  const result = {
    timestamp: new Date().toISOString(),
    stockCount: stocks.length,
    sectorPerformance: sectorPerfs,
    rotationSignals: signals,
    diagnostics,
    etfValidation: etfValidations,
    assetClassFlows,
    fundFlows,
    aumSnapshots,
    nportData,
    darkPoolData,
    darkPoolAggregates,
    darkPoolTrends,
    optionsData,
    sectorTrends,
    assetClassTrends,
    actionSignals,
  };

  // Write to docs/ for GitHub Pages (HTML files live directly in docs/)
  fs.mkdirSync(docsDir, { recursive: true });

  // Write JSON data only — HTML files are edited directly in docs/
  const jsonDst = path.join(docsDir, "data.json");
  fs.writeFileSync(jsonDst, JSON.stringify(result, null, 2));

  // Write data.js for file:// protocol support (no fetch needed)
  const jsDst = path.join(docsDir, "data.js");
  fs.writeFileSync(jsDst, `window.__FINVIZ_DATA = ${JSON.stringify(result)};`);

  // Save daily snapshot for historical navigation
  fs.mkdirSync(historyDir, { recursive: true });

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const snapshotPath = path.join(historyDir, `${today}.json`);
  fs.writeFileSync(snapshotPath, JSON.stringify(result));

  // Update manifest of available dates
  const manifestPath = path.join(historyDir, "index.json");
  let dates: string[] = [];
  try {
    dates = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  } catch {}
  if (!dates.includes(today)) {
    dates.push(today);
    dates.sort();
  }
  fs.writeFileSync(manifestPath, JSON.stringify(dates));

  // Embed available dates in result so file:// protocol works without fetch
  (result as any).availableDates = dates;

  console.log(`\nBuild complete:`);
  console.log(`  docs/index.html`);
  console.log(`  docs/data.json (${stocks.length} stocks, ${new Date().toISOString()})`);
  console.log(`  docs/data.js (file:// fallback)`);
  console.log(`  docs/history/${today}.json (snapshot #${dates.length})`);
}

build().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});

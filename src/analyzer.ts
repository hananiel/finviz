import type {
  StockData,
  SectorPerformance,
  RotationSignal,
  SectorETF,
  ETFValidation,
  AssetClassETF,
  AssetClassFlow,
  TechnicalData,
  TrendPhase,
  ETFTrendDetail,
  ActionRecommendation,
  ActionSignal,
} from "./types.js";

// ---------------------------------------------------------------------------
// 1. Aggregate by sector
// ---------------------------------------------------------------------------

export function aggregateBySector(stocks: StockData[]): SectorPerformance[] {
  // Group stocks by sector
  const grouped = new Map<string, StockData[]>();
  for (const s of stocks) {
    const list = grouped.get(s.sector) ?? [];
    list.push(s);
    grouped.set(s.sector, list);
  }

  const sectors: SectorPerformance[] = [];

  for (const [sector, sectorStocks] of grouped) {
    const n = sectorStocks.length;
    const totalMcap = sectorStocks.reduce((sum, s) => sum + s.marketCap, 0);

    // Equal-weight averages
    const ew1W = sectorStocks.reduce((s, st) => s + st.perf1W, 0) / n;
    const ew1M = sectorStocks.reduce((s, st) => s + st.perf1M, 0) / n;
    const ew3M = sectorStocks.reduce((s, st) => s + st.perf3M, 0) / n;

    // Market-cap-weighted averages
    const mcw1W =
      totalMcap > 0
        ? sectorStocks.reduce((s, st) => s + st.perf1W * st.marketCap, 0) / totalMcap
        : ew1W;
    const mcw1M =
      totalMcap > 0
        ? sectorStocks.reduce((s, st) => s + st.perf1M * st.marketCap, 0) / totalMcap
        : ew1M;
    const mcw3M =
      totalMcap > 0
        ? sectorStocks.reduce((s, st) => s + st.perf3M * st.marketCap, 0) / totalMcap
        : ew3M;

    // Breadth: % of stocks positive
    const breadth1W = (sectorStocks.filter((s) => s.perf1W > 0).length / n) * 100;
    const breadth1M = (sectorStocks.filter((s) => s.perf1M > 0).length / n) * 100;
    const breadth3M = (sectorStocks.filter((s) => s.perf3M > 0).length / n) * 100;

    // Top 3 movers by 1W performance
    const sorted1W = [...sectorStocks].sort((a, b) => b.perf1W - a.perf1W);
    const topMovers = sorted1W.slice(0, 3).map((s) => ({
      ticker: s.ticker,
      perf1W: s.perf1W,
    }));

    sectors.push({
      sector,
      stockCount: n,
      mcw1W,
      mcw1M,
      mcw3M,
      ew1W,
      ew1M,
      ew3M,
      breadth1W,
      breadth1M,
      breadth3M,
      topMovers,
    });
  }

  return sectors;
}

// ---------------------------------------------------------------------------
// 2. Calculate rotation signals
// ---------------------------------------------------------------------------

export function calculateRotationSignals(
  sectorPerfs: SectorPerformance[]
): RotationSignal[] {
  const n = sectorPerfs.length;

  // Rank sectors by MCW performance per timeframe (1 = best, n = worst)
  const rank = (arr: SectorPerformance[], key: keyof SectorPerformance) => {
    const sorted = [...arr].sort(
      (a, b) => (b[key] as number) - (a[key] as number)
    );
    const ranks = new Map<string, number>();
    sorted.forEach((s, i) => ranks.set(s.sector, i + 1));
    return ranks;
  };

  const ranks1W = rank(sectorPerfs, "mcw1W");
  const ranks1M = rank(sectorPerfs, "mcw1M");
  const ranks3M = rank(sectorPerfs, "mcw3M");

  const signals: RotationSignal[] = sectorPerfs.map((sp) => {
    const r1W = ranks1W.get(sp.sector)!;
    const r1M = ranks1M.get(sp.sector)!;
    const r3M = ranks3M.get(sp.sector)!;

    // Rank shift: positive = sector is improving in short term vs long term
    const rankShift = r3M - r1W;

    // Momentum acceleration: compare weekly rate to monthly rate
    // Old formula annualized (×52 and ×4) which amplified 1-day noise enormously.
    // New: compare rates on same timescale (per-week basis)
    const weeklyRate = sp.mcw1W;              // already % per week
    const monthlyRate = sp.mcw1M / 4.33;     // normalize 1M to per-week
    const momentumAccel = weeklyRate - monthlyRate;

    // Institutional spread: MCW - EW for 1W
    // Positive = large-cap stocks outperforming (institutional buying)
    const institutionalSpread = sp.mcw1W - sp.ew1W;

    // Breadth divergence: short-term breadth vs long-term breadth
    const breadthDivergence = sp.breadth1W - sp.breadth3M;

    // Composite rotation score (weighted combination)
    // Weights: rank shift (35%), momentum accel (25%), institutional spread (20%), breadth (20%)
    // Normalize each component to roughly similar scales
    const normRankShift = rankShift / n; // range [-1, 1]
    const normMomentum = Math.tanh(momentumAccel / 2); // squash; scale is now per-week diffs (~±3)
    const normInstitutional = Math.tanh(institutionalSpread / 5);
    const normBreadth = breadthDivergence / 100; // already in pct

    const rotationScore =
      normRankShift * 35 +
      normMomentum * 25 +
      normInstitutional * 20 +
      normBreadth * 20;

    // Classify signal
    let signal: "INFLOW" | "OUTFLOW" | "NEUTRAL";
    if (rotationScore > 8) signal = "INFLOW";
    else if (rotationScore < -8) signal = "OUTFLOW";
    else signal = "NEUTRAL";

    return {
      sector: sp.sector,
      signal,
      rotationScore: Math.round(rotationScore * 100) / 100,
      rankShift,
      momentumAccel: Math.round(momentumAccel * 100) / 100,
      institutionalSpread: Math.round(institutionalSpread * 100) / 100,
      breadthDivergence: Math.round(breadthDivergence * 100) / 100,
      rank1W: r1W,
      rank3M: r3M,
    };
  });

  // Sort by rotation score descending
  signals.sort((a, b) => b.rotationScore - a.rotationScore);
  return signals;
}

// ---------------------------------------------------------------------------
// 3. ETF validation
// ---------------------------------------------------------------------------

export function validateWithETFs(
  sectorPerfs: SectorPerformance[],
  etfs: SectorETF[]
): ETFValidation[] {
  const sectorMap = new Map(sectorPerfs.map((sp) => [sp.sector, sp]));

  return etfs
    .map((etf) => {
      const sp = sectorMap.get(etf.sector);
      if (!sp) return null;

      const divergence =
        Math.round((etf.perf1W - sp.mcw1W) * 100) / 100;

      let volumeSignal: "HIGH" | "NORMAL" | "LOW";
      if (etf.relVolume >= 1.5) volumeSignal = "HIGH";
      else if (etf.relVolume <= 0.7) volumeSignal = "LOW";
      else volumeSignal = "NORMAL";

      return {
        etfTicker: etf.ticker,
        sector: etf.sector,
        etfPerf1W: etf.perf1W,
        stockAvg1W: Math.round(sp.mcw1W * 100) / 100,
        divergence,
        relVolume: etf.relVolume,
        volumeSignal,
      };
    })
    .filter((v): v is ETFValidation => v !== null)
    .sort((a, b) => b.relVolume - a.relVolume);
}

// ---------------------------------------------------------------------------
// 4. Asset class rotation matrix
// ---------------------------------------------------------------------------

export function calculateAssetClassFlows(
  assetClassETFs: AssetClassETF[],
  technicals?: Map<string, TechnicalData>
): AssetClassFlow[] {
  // Group ETFs by asset class
  const grouped = new Map<string, AssetClassETF[]>();
  for (const etf of assetClassETFs) {
    const list = grouped.get(etf.assetClass) ?? [];
    list.push(etf);
    grouped.set(etf.assetClass, list);
  }

  const flows: AssetClassFlow[] = [];

  for (const [assetClass, etfs] of grouped) {
    const n = etfs.length;

    const avgPerf1W = etfs.reduce((s, e) => s + e.perf1W, 0) / n;
    const avgPerf1M = etfs.reduce((s, e) => s + e.perf1M, 0) / n;
    const avgPerf3M = etfs.reduce((s, e) => s + e.perf3M, 0) / n;
    const avgRelVolume = etfs.reduce((s, e) => s + e.relVolume, 0) / n;

    // Flow score: blended multi-timeframe with capped volume confidence
    // Problem with old formula: relVolume was unbounded multiplier (crypto ~93x!)
    // and 1W was annualized (×52) making daily noise dominate.
    //
    // New approach:
    //   - Blend timeframes: 1W (20%), 1M (50%), 3M (30%) for directional signal
    //   - Cap volume multiplier at 2x to prevent new/volatile ETFs from dominating
    //   - Volume below 0.7 dampens the signal (low conviction)
    const blendedPerf = avgPerf1W * 0.2 + avgPerf1M * 0.5 + avgPerf3M * 0.3;

    // Volume confidence: cap at 2x, floor at 0.5x, linear scale between
    const volCapped = Math.min(Math.max(avgRelVolume, 0.5), 2.0);
    const volConfidence = volCapped / 1.0; // 1.0 = neutral, range [0.5, 2.0]

    // Momentum acceleration: is the short-term trend diverging from long-term?
    // Use weekly rate vs monthly rate (not annualized) to avoid amplification
    const weeklyRate = avgPerf1W;            // % per week
    const monthlyRate = avgPerf1M / 4.33;    // % per week (from monthly)
    const accel = weeklyRate - monthlyRate;   // positive = accelerating inflow

    // Composite: blended direction (scaled) + acceleration bonus
    const flowScore =
      blendedPerf * 3 * volConfidence +       // main directional signal
      Math.tanh(accel / 2) * 2;               // bounded acceleration [-2, +2]

    let signal: "INFLOW" | "OUTFLOW" | "NEUTRAL";
    if (flowScore > 3) signal = "INFLOW";
    else if (flowScore < -3) signal = "OUTFLOW";
    else signal = "NEUTRAL";

    flows.push({
      assetClass,
      label: etfs.map((e) => e.label).join(", "),
      tickers: etfs.map((e) => e.ticker),
      avgPerf1W: Math.round(avgPerf1W * 100) / 100,
      avgPerf1M: Math.round(avgPerf1M * 100) / 100,
      avgPerf3M: Math.round(avgPerf3M * 100) / 100,
      avgRelVolume: Math.round(avgRelVolume * 100) / 100,
      flowScore: Math.round(flowScore * 100) / 100,
      signal,
      trendPhase: technicals
        ? classifyTrendPhase(etfs.map((e) => e.ticker), technicals)
        : undefined,
    });
  }

  // Sort by flow score descending
  flows.sort((a, b) => b.flowScore - a.flowScore);
  return flows;
}

// ---------------------------------------------------------------------------
// 5. Trend Phase Classification
// ---------------------------------------------------------------------------

/**
 * Classify the trend maturity for an asset class based on SMA distances.
 * Uses averaged SMA20/50/200 distances across the asset class's ETFs.
 *
 * Logic:
 *   - Price vs SMA50 determines primary trend direction
 *   - SMA200 confirms whether trend is established
 *   - SMA20 identifies short-term divergences (pullbacks/bounces)
 *   - Magnitude of SMA distances identifies extension
 */
export function classifyTrendPhase(
  tickers: string[],
  technicals: Map<string, TechnicalData>
): TrendPhase {
  const data = tickers
    .map((t) => technicals.get(t))
    .filter((d): d is TechnicalData => d !== undefined);

  if (data.length === 0) return "NEUTRAL";

  const n = data.length;
  const avgSMA20 = data.reduce((s, d) => s + d.sma20, 0) / n;
  const avgSMA50 = data.reduce((s, d) => s + d.sma50, 0) / n;
  const avgSMA200 = data.reduce((s, d) => s + d.sma200, 0) / n;
  const avgRSI = data.reduce((s, d) => s + d.rsi, 0) / n;

  // Thresholds (% distance)
  const EXTENDED_THRESHOLD = 10;  // >10% above SMA50 = overextended
  const NEAR_ZERO = 2;            // within ±2% = "near" the MA

  // --- Uptrend scenarios ---
  if (avgSMA50 > NEAR_ZERO) {
    // Price is above SMA50
    if (avgSMA50 > EXTENDED_THRESHOLD && avgSMA200 > EXTENDED_THRESHOLD) {
      // Far above both — late/extended, RSI likely overbought
      return "EXTENDED";
    }
    if (avgSMA200 > NEAR_ZERO) {
      // Above both SMA50 and SMA200 — confirmed uptrend
      return "ESTABLISHED_UPTREND";
    }
    // Above SMA50 but SMA200 still near zero or below — early stages
    return "EARLY_UPTREND";
  }

  // --- Downtrend scenarios ---
  if (avgSMA50 < -NEAR_ZERO) {
    // Price is below SMA50
    if (avgSMA200 < -NEAR_ZERO) {
      // Below both — confirmed downtrend
      return "ESTABLISHED_DOWNTREND";
    }
    // Below SMA50 but SMA200 still near/above — early decline
    return "EARLY_DOWNTREND";
  }

  // --- Near SMA50 (within ±2%) — check for pullbacks/bounces ---
  if (avgSMA20 > NEAR_ZERO && avgSMA200 < -NEAR_ZERO) {
    // Short-term bounce (above SMA20) in a longer-term downtrend (below SMA200)
    return "COUNTER_TREND_BOUNCE";
  }
  if (avgSMA20 < -NEAR_ZERO && avgSMA200 > NEAR_ZERO) {
    // Short-term dip (below SMA20) in a longer-term uptrend (above SMA200)
    return "PULLBACK_IN_UPTREND";
  }

  return "NEUTRAL";
}

/**
 * Classify trend phase for a single ETF's technical data.
 */
export function classifySingleTrend(d: TechnicalData): TrendPhase {
  const EXTENDED_THRESHOLD = 10;
  const NEAR_ZERO = 2;

  if (d.sma50 > NEAR_ZERO) {
    if (d.sma50 > EXTENDED_THRESHOLD && d.sma200 > EXTENDED_THRESHOLD) {
      return "EXTENDED";
    }
    if (d.sma200 > NEAR_ZERO) return "ESTABLISHED_UPTREND";
    return "EARLY_UPTREND";
  }

  if (d.sma50 < -NEAR_ZERO) {
    if (d.sma200 < -NEAR_ZERO) return "ESTABLISHED_DOWNTREND";
    return "EARLY_DOWNTREND";
  }

  if (d.sma20 > NEAR_ZERO && d.sma200 < -NEAR_ZERO) return "COUNTER_TREND_BOUNCE";
  if (d.sma20 < -NEAR_ZERO && d.sma200 > NEAR_ZERO) return "PULLBACK_IN_UPTREND";

  return "NEUTRAL";
}

// ---------------------------------------------------------------------------
// 6. Per-ETF Trend Breakdown (sectors + individual asset class ETFs)
// ---------------------------------------------------------------------------

/**
 * Build per-ETF trend details for sector ETFs and asset class ETFs.
 */
export function buildETFTrendDetails(
  sectorETFs: SectorETF[],
  assetClassETFs: AssetClassETF[],
  technicals: Map<string, TechnicalData>
): { sectorTrends: ETFTrendDetail[]; assetClassTrends: ETFTrendDetail[] } {
  const sectorTrends: ETFTrendDetail[] = [];
  for (const etf of sectorETFs) {
    const tech = technicals.get(etf.ticker);
    if (!tech) continue;
    sectorTrends.push({
      ticker: etf.ticker,
      label: etf.sector,
      sma20: tech.sma20,
      sma50: tech.sma50,
      sma200: tech.sma200,
      rsi: tech.rsi,
      trendPhase: classifySingleTrend(tech),
    });
  }

  const assetClassTrends: ETFTrendDetail[] = [];
  for (const etf of assetClassETFs) {
    const tech = technicals.get(etf.ticker);
    if (!tech) continue;
    assetClassTrends.push({
      ticker: etf.ticker,
      label: etf.label,
      sma20: tech.sma20,
      sma50: tech.sma50,
      sma200: tech.sma200,
      rsi: tech.rsi,
      trendPhase: classifySingleTrend(tech),
    });
  }

  // Sort by SMA50 descending (strongest uptrend first)
  sectorTrends.sort((a, b) => b.sma50 - a.sma50);
  assetClassTrends.sort((a, b) => b.sma50 - a.sma50);

  return { sectorTrends, assetClassTrends };
}

// ---------------------------------------------------------------------------
// 7. Action Signals — BUY / SELL / HOLD / TRIM
// ---------------------------------------------------------------------------

/**
 * Generate actionable recommendations by synthesizing:
 *   - Trend phase (where in the cycle)
 *   - RSI (overbought/oversold)
 *   - SMA alignment (all MAs stacked = strong trend)
 *   - Flow direction (capital moving in/out)
 *
 * Signal logic matrix:
 *   EARLY_UPTREND + flow INFLOW + RSI<70      → BUY (new trend + confirmation)
 *   ESTABLISHED_UPTREND + flow INFLOW          → BUY (confirmed + add on dips)
 *   PULLBACK_IN_UPTREND + RSI<50              → BUY (pullback entry)
 *   EXTENDED + RSI>65                         → TRIM (take profits)
 *   EARLY_DOWNTREND + flow OUTFLOW            → SELL (trend breaking)
 *   ESTABLISHED_DOWNTREND                     → SELL (confirmed bear)
 *   COUNTER_TREND_BOUNCE + flow OUTFLOW       → SELL (fade the bounce)
 *   Everything else                           → HOLD
 */
export function generateActionSignals(
  trendDetails: ETFTrendDetail[],
  flowMap: Map<string, AssetClassFlow>,
  rotationSignals?: RotationSignal[]
): ActionRecommendation[] {
  const recommendations: ActionRecommendation[] = [];

  for (const etf of trendDetails) {
    const factors: string[] = [];
    let action: ActionSignal = "HOLD";
    let confidence = 50;
    let rationale = "";

    const { trendPhase, rsi, sma20, sma50, sma200 } = etf;

    // Find corresponding flow (match by ticker in flow tickers, or by label as sector)
    let flow: AssetClassFlow | undefined;
    for (const [, f] of flowMap) {
      if (f.tickers.includes(etf.ticker) || f.assetClass === etf.label) {
        flow = f;
        break;
      }
    }

    // Find rotation signal for sector ETFs
    const rotation = rotationSignals?.find((r) => r.sector === etf.label);

    // --- Factor: Trend Phase ---
    factors.push(`Trend: ${trendPhase.replace(/_/g, " ").toLowerCase()}`);

    // --- Factor: RSI ---
    if (rsi >= 70) factors.push(`RSI ${rsi.toFixed(0)} (overbought)`);
    else if (rsi >= 60) factors.push(`RSI ${rsi.toFixed(0)} (elevated)`);
    else if (rsi <= 30) factors.push(`RSI ${rsi.toFixed(0)} (oversold)`);
    else if (rsi <= 40) factors.push(`RSI ${rsi.toFixed(0)} (depressed)`);
    else factors.push(`RSI ${rsi.toFixed(0)} (neutral)`);

    // --- Factor: Flow direction ---
    if (flow) {
      factors.push(`Flow: ${flow.signal} (score ${flow.flowScore.toFixed(1)})`);
    }

    // --- Factor: Rotation signal (for sectors) ---
    if (rotation) {
      factors.push(`Rotation: ${rotation.signal} (rank Δ: ${rotation.rankShift > 0 ? "+" : ""}${rotation.rankShift})`);
    }

    // --- Factor: SMA alignment ---
    const allAligned = sma20 > 0 && sma50 > 0 && sma200 > 0;
    const allNeg = sma20 < 0 && sma50 < 0 && sma200 < 0;
    if (allAligned) factors.push("MAs stacked bullish (20>50>200)");
    if (allNeg) factors.push("MAs stacked bearish (price < all MAs)");

    // ===================================================================
    // Decision matrix
    // ===================================================================

    if (trendPhase === "EARLY_UPTREND") {
      if (rsi < 70 && (flow?.signal === "INFLOW" || rotation?.signal === "INFLOW")) {
        action = "BUY";
        confidence = 75;
        rationale = "New uptrend forming with capital inflow confirmation";
      } else if (rsi < 70) {
        action = "BUY";
        confidence = 60;
        rationale = "Early uptrend — above SMA50, waiting for flow confirmation";
      } else {
        action = "HOLD";
        confidence = 45;
        rationale = "Early uptrend but RSI elevated — wait for pullback entry";
      }
    } else if (trendPhase === "PULLBACK_IN_UPTREND") {
      if (rsi <= 50) {
        action = "BUY";
        confidence = 70;
        rationale = "Pullback in uptrend with depressed RSI — mean reversion entry";
      } else {
        action = "BUY";
        confidence = 55;
        rationale = "Dipping in uptrend — add if support holds";
      }
    } else if (trendPhase === "ESTABLISHED_UPTREND") {
      if (flow?.signal === "INFLOW" || rotation?.signal === "INFLOW") {
        action = "BUY";
        confidence = 65;
        rationale = "Confirmed uptrend with sustained inflow — buy on dips";
      } else if (rsi >= 68) {
        action = "TRIM";
        confidence = 55;
        rationale = "Uptrend intact but RSI getting hot — lighten position";
      } else {
        action = "HOLD";
        confidence = 60;
        rationale = "Confirmed uptrend — maintain position, no urgency to add";
      }
    } else if (trendPhase === "EXTENDED") {
      if (rsi >= 65) {
        action = "TRIM";
        confidence = 70;
        rationale = "Overextended above both MAs with elevated RSI — take profits";
      } else if (flow?.signal === "OUTFLOW" || rotation?.signal === "OUTFLOW") {
        action = "SELL";
        confidence = 65;
        rationale = "Extended and capital leaving — distribution phase likely";
      } else {
        action = "TRIM";
        confidence = 55;
        rationale = "Far from MAs — reduce exposure, mean reversion risk rising";
      }
    } else if (trendPhase === "EARLY_DOWNTREND") {
      if (flow?.signal === "OUTFLOW" || rotation?.signal === "OUTFLOW") {
        action = "SELL";
        confidence = 75;
        rationale = "Trend breaking below SMA50 with capital outflow";
      } else {
        action = "SELL";
        confidence = 60;
        rationale = "Below SMA50 — trend breaking, exit before further damage";
      }
    } else if (trendPhase === "ESTABLISHED_DOWNTREND") {
      action = "SELL";
      confidence = 80;
      rationale = "Below both SMA50 and SMA200 — confirmed bear trend, avoid";
      if (rsi <= 30) {
        // Oversold in a downtrend — might bounce but don't catch knives
        factors.push("Oversold but trend is down — bounce likely short-lived");
      }
    } else if (trendPhase === "COUNTER_TREND_BOUNCE") {
      if (flow?.signal === "OUTFLOW") {
        action = "SELL";
        confidence = 70;
        rationale = "Bounce in downtrend while capital leaving — fade this rally";
      } else {
        action = "HOLD";
        confidence = 40;
        rationale = "Bouncing but trend is down — don't chase, wait for confirmation";
      }
    } else {
      // NEUTRAL
      if (flow?.signal === "INFLOW" && rsi < 60) {
        action = "BUY";
        confidence = 45;
        rationale = "No clear trend but capital flowing in — small position justified";
      } else if (flow?.signal === "OUTFLOW") {
        action = "HOLD";
        confidence = 40;
        rationale = "Unclear direction with outflow — stay flat, wait for setup";
      } else {
        action = "HOLD";
        confidence = 35;
        rationale = "No clear signal — wait for trend to develop";
      }
    }

    recommendations.push({
      ticker: etf.ticker,
      label: etf.label,
      action,
      confidence,
      rationale,
      factors,
    });
  }

  // Sort: BUY first (highest confidence), then HOLD, TRIM, SELL
  const actionOrder: Record<ActionSignal, number> = {
    BUY: 0, HOLD: 1, TRIM: 2, SELL: 3,
  };
  recommendations.sort((a, b) => {
    const orderDiff = actionOrder[a.action] - actionOrder[b.action];
    if (orderDiff !== 0) return orderDiff;
    return b.confidence - a.confidence;
  });

  return recommendations;
}

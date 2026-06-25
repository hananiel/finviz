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
  InvestingMode,
  CapitalMode,
  Strategy,
  SectorDiagnostic,
  ETFFundFlow,
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

    // Momentum acceleration — SMOOTHED to prevent daily whipsaw.
    // Problem: raw mcw1W is a rolling 5-day figure that shifts materially
    // as one day drops off. Using it directly can flip signals on a single day.
    //
    // Fix: Blend short-term (1W) and medium-term (1M) into a smoothed rate,
    // then compare against long-term (3M) rate. This requires 2+ timeframes
    // to agree before momentum registers as accelerating.
    const weeklyRate = sp.mcw1W;              // % per week (noisy)
    const monthlyRate = sp.mcw1M / 4.33;     // 1M normalized to per-week
    const quarterlyRate = sp.mcw3M / 13;     // 3M normalized to per-week

    // Smoothed short-term: blend 1W (40%) with 1M-rate (60%) to dampen single-week noise
    const smoothedShortRate = weeklyRate * 0.4 + monthlyRate * 0.6;
    // Compare smoothed short vs long-term baseline
    const momentumAccel = smoothedShortRate - quarterlyRate;

    // Institutional spread: MCW - EW for 1W
    // Positive = large-cap stocks outperforming (institutional buying)
    // Also smooth with 1M data to reduce daily noise
    const instSpread1W = sp.mcw1W - sp.ew1W;
    const instSpread1M = sp.mcw1M - sp.ew1M;
    const institutionalSpread = instSpread1W * 0.4 + instSpread1M * 0.6;

    // Breadth divergence: short-term breadth vs long-term breadth
    // Blend 1W and 1M breadth for smoother signal
    const smoothedBreadthShort = sp.breadth1W * 0.4 + sp.breadth1M * 0.6;
    const breadthDivergence = smoothedBreadthShort - sp.breadth3M;

    // Composite rotation score (weighted combination)
    // Weights: rank shift (35%), momentum accel (25%), institutional spread (20%), breadth (20%)
    // Normalize each component to roughly similar scales
    const normRankShift = rankShift / n; // range [-1, 1]
    const normMomentum = Math.tanh(momentumAccel / 2); // squash; scale is now per-week diffs (~±3)
    const normInstitutional = Math.tanh(institutionalSpread / 3);
    const normBreadth = breadthDivergence / 100; // already in pct

    const rotationScore =
      normRankShift * 35 +
      normMomentum * 25 +
      normInstitutional * 20 +
      normBreadth * 20;

    // Classify signal — use hysteresis-aware thresholds.
    // Wider band (±10) prevents rapid NEUTRAL→INFLOW→NEUTRAL oscillation.
    let signal: "INFLOW" | "OUTFLOW" | "NEUTRAL";
    if (rotationScore > 10) signal = "INFLOW";
    else if (rotationScore < -10) signal = "OUTFLOW";
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

interface SignalContext {
  etf: ETFTrendDetail;
  flow?: AssetClassFlow;
  rotation?: RotationSignal;
  allAligned: boolean;  // all MAs bullish
  allNeg: boolean;      // all MAs bearish
}

/**
 * Generate actionable recommendations with dual-mode system:
 *
 * Capital modes:
 *   DEPLOY — fresh cash to invest. Cares about absolute entry quality.
 *           "Should I buy this at all?" Cash is a valid position.
 *   ROTATE — rebalancing existing portfolio. Cares about relative attractiveness.
 *           "Should I shift weight from X to Y?" Always fully invested.
 *
 * Strategies:
 *   MOMENTUM  — follow trends + flows. Buy strength, sell weakness.
 *   CONTRARIAN — fade extremes. Buy oversold/hated, sell overbought/loved.
 *   ROTATION  — follow rank changes. Buy improving, sell deteriorating.
 */
export function generateActionSignals(
  trendDetails: ETFTrendDetail[],
  flowMap: Map<string, AssetClassFlow>,
  rotationSignals?: RotationSignal[],
  mode: InvestingMode = { capital: "deploy", strategy: "momentum" }
): ActionRecommendation[] {
  const recommendations: ActionRecommendation[] = [];

  for (const etf of trendDetails) {
    const factors: string[] = [];
    const { trendPhase, rsi, sma20, sma50, sma200 } = etf;

    // Find corresponding flow
    let flow: AssetClassFlow | undefined;
    for (const [, f] of flowMap) {
      if (f.tickers.includes(etf.ticker) || f.assetClass === etf.label) {
        flow = f;
        break;
      }
    }

    // Find rotation signal for sector ETFs
    const rotation = rotationSignals?.find((r) => r.sector === etf.label);

    // --- Collect factors (shared across all modes) ---
    factors.push(`Trend: ${trendPhase.replace(/_/g, " ").toLowerCase()}`);

    if (rsi >= 70) factors.push(`RSI ${rsi.toFixed(0)} (overbought)`);
    else if (rsi >= 60) factors.push(`RSI ${rsi.toFixed(0)} (elevated)`);
    else if (rsi <= 30) factors.push(`RSI ${rsi.toFixed(0)} (oversold)`);
    else if (rsi <= 40) factors.push(`RSI ${rsi.toFixed(0)} (depressed)`);
    else factors.push(`RSI ${rsi.toFixed(0)} (neutral)`);

    if (flow) {
      factors.push(`Flow: ${flow.signal} (score ${flow.flowScore.toFixed(1)})`);
    }
    if (rotation) {
      factors.push(`Rotation: ${rotation.signal} (rank Δ: ${rotation.rankShift > 0 ? "+" : ""}${rotation.rankShift})`);
    }

    const allAligned = sma20 > 0 && sma50 > 0 && sma200 > 0;
    const allNeg = sma20 < 0 && sma50 < 0 && sma200 < 0;
    if (allAligned) factors.push("MAs stacked bullish (20>50>200)");
    if (allNeg) factors.push("MAs stacked bearish (price < all MAs)");

    const ctx: SignalContext = { etf, flow, rotation, allAligned, allNeg };

    // --- Pick strategy ---
    let result: { action: ActionSignal; confidence: number; rationale: string; extraFactors?: string[] };

    if (mode.strategy === "contrarian") {
      result = contrarianStrategy(ctx);
    } else if (mode.strategy === "rotation") {
      result = rotationStrategy(ctx);
    } else {
      result = momentumStrategy(ctx);
    }

    // --- Apply capital mode modifier ---
    if (mode.capital === "rotate") {
      result = applyRotateModifier(result, ctx);
    }

    if (result.extraFactors) {
      factors.push(...result.extraFactors);
    }

    recommendations.push({
      ticker: etf.ticker,
      label: etf.label,
      action: result.action,
      confidence: result.confidence,
      rationale: result.rationale,
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

// ---------------------------------------------------------------------------
// Strategy: Momentum — follow trends and flows
// ---------------------------------------------------------------------------

function momentumStrategy(ctx: SignalContext) {
  const { etf, flow, rotation } = ctx;
  const { trendPhase, rsi, sma20 } = etf;
  let action: ActionSignal = "HOLD";
  let confidence = 50;
  let rationale = "";
  const extraFactors: string[] = [];

  if (trendPhase === "EARLY_UPTREND") {
    if (rsi < 70 && (flow?.signal === "INFLOW" || rotation?.signal === "INFLOW")) {
      action = "BUY"; confidence = 75;
      rationale = "New uptrend forming with capital inflow confirmation";
    } else if (rsi < 70) {
      action = "BUY"; confidence = 60;
      rationale = "Early uptrend — above SMA50, waiting for flow confirmation";
    } else {
      action = "HOLD"; confidence = 45;
      rationale = "Early uptrend but RSI elevated — wait for pullback entry";
    }
  } else if (trendPhase === "PULLBACK_IN_UPTREND") {
    if (rsi <= 50) {
      action = "BUY"; confidence = 70;
      rationale = "Pullback in uptrend with depressed RSI — mean reversion entry";
    } else {
      action = "BUY"; confidence = 55;
      rationale = "Dipping in uptrend — add if support holds";
    }
  } else if (trendPhase === "ESTABLISHED_UPTREND") {
    if (flow?.signal === "INFLOW" || rotation?.signal === "INFLOW") {
      if (sma20 < -1) {
        action = "BUY"; confidence = 80;
        rationale = `Dip detected — price ${sma20.toFixed(1)}% below SMA20 in confirmed uptrend with inflow`;
        extraFactors.push("Price below 20-day MA = short-term dip in strong trend");
      } else if (sma20 < 1 && rsi < 55) {
        action = "BUY"; confidence = 70;
        rationale = "Near SMA20 with cooling RSI in confirmed uptrend — dip forming";
        extraFactors.push("Price approaching 20-day MA support");
      } else {
        action = "HOLD"; confidence = 60;
        rationale = `Confirmed uptrend with inflow but no dip yet (${sma20.toFixed(1)}% above SMA20) — wait for pullback to add`;
        extraFactors.push("No dip: price still above 20-day MA");
      }
    } else if (rsi >= 68) {
      action = "TRIM"; confidence = 55;
      rationale = "Uptrend intact but RSI getting hot — lighten position";
    } else {
      action = "HOLD"; confidence = 60;
      rationale = "Confirmed uptrend — maintain position, no urgency to add";
    }
  } else if (trendPhase === "EXTENDED") {
    if (rsi >= 65) {
      action = "TRIM"; confidence = 70;
      rationale = "Overextended above both MAs with elevated RSI — take profits";
    } else if (flow?.signal === "OUTFLOW" || rotation?.signal === "OUTFLOW") {
      action = "SELL"; confidence = 65;
      rationale = "Extended and capital leaving — distribution phase likely";
    } else {
      action = "TRIM"; confidence = 55;
      rationale = "Far from MAs — reduce exposure, mean reversion risk rising";
    }
  } else if (trendPhase === "EARLY_DOWNTREND") {
    if (flow?.signal === "OUTFLOW" || rotation?.signal === "OUTFLOW") {
      action = "SELL"; confidence = 75;
      rationale = "Trend breaking below SMA50 with capital outflow";
    } else {
      action = "SELL"; confidence = 60;
      rationale = "Below SMA50 — trend breaking, exit before further damage";
    }
  } else if (trendPhase === "ESTABLISHED_DOWNTREND") {
    action = "SELL"; confidence = 80;
    rationale = "Below both SMA50 and SMA200 — confirmed bear trend, avoid";
    if (rsi <= 30) {
      extraFactors.push("Oversold but trend is down — bounce likely short-lived");
    }
  } else if (trendPhase === "COUNTER_TREND_BOUNCE") {
    if (flow?.signal === "OUTFLOW") {
      action = "SELL"; confidence = 70;
      rationale = "Bounce in downtrend while capital leaving — fade this rally";
    } else {
      action = "HOLD"; confidence = 40;
      rationale = "Bouncing but trend is down — don't chase, wait for confirmation";
    }
  } else {
    if (flow?.signal === "INFLOW" && rsi < 60) {
      action = "BUY"; confidence = 45;
      rationale = "No clear trend but capital flowing in — small position justified";
    } else if (flow?.signal === "OUTFLOW") {
      action = "HOLD"; confidence = 40;
      rationale = "Unclear direction with outflow — stay flat, wait for setup";
    } else {
      action = "HOLD"; confidence = 35;
      rationale = "No clear signal — wait for trend to develop";
    }
  }

  return { action, confidence, rationale, extraFactors };
}

// ---------------------------------------------------------------------------
// Strategy: Contrarian — fade extremes, buy fear, sell greed
// ---------------------------------------------------------------------------

function contrarianStrategy(ctx: SignalContext) {
  const { etf, flow, rotation, allNeg, allAligned } = ctx;
  const { trendPhase, rsi, sma20, sma50, sma200 } = etf;
  let action: ActionSignal = "HOLD";
  let confidence = 50;
  let rationale = "";
  const extraFactors: string[] = [];

  // Contrarian inverts the logic: oversold + outflow = opportunity, overbought + inflow = danger

  if (trendPhase === "ESTABLISHED_DOWNTREND") {
    if (rsi <= 30) {
      action = "BUY"; confidence = 75;
      rationale = `Capitulation signal — RSI ${rsi.toFixed(0)} oversold, ${sma200.toFixed(1)}% below SMA200`;
      extraFactors.push("Deep discount to long-term average = mean reversion opportunity");
      if (flow?.signal === "OUTFLOW") {
        confidence = 80;
        extraFactors.push("Outflow = panic selling — contrarian buy zone");
      }
    } else if (rsi <= 40 && allNeg) {
      action = "BUY"; confidence = 65;
      rationale = "Below all MAs with depressed RSI — accumulation zone";
      extraFactors.push("Price washed out — smart money often accumulates here");
    } else {
      action = "HOLD"; confidence = 45;
      rationale = "Downtrend but not yet oversold enough — wait for capitulation";
    }
  } else if (trendPhase === "EARLY_DOWNTREND") {
    if (rsi <= 35) {
      action = "BUY"; confidence = 60;
      rationale = "Early decline with oversold RSI — contrarian entry if support holds";
    } else {
      action = "HOLD"; confidence = 40;
      rationale = "Breaking down but not oversold — too early for contrarian entry";
    }
  } else if (trendPhase === "COUNTER_TREND_BOUNCE") {
    if (rsi <= 45 && sma200 < -5) {
      action = "BUY"; confidence = 55;
      rationale = "Bounce starting from deep discount — early reversal candidate";
    } else {
      action = "HOLD"; confidence = 40;
      rationale = "Bouncing but not cheap enough for contrarian conviction";
    }
  } else if (trendPhase === "EXTENDED") {
    if (rsi >= 70) {
      action = "SELL"; confidence = 80;
      rationale = `Euphoria zone — RSI ${rsi.toFixed(0)} overbought, ${sma200.toFixed(1)}% above SMA200`;
      extraFactors.push("Extreme extension above MAs = high reversion risk");
      if (flow?.signal === "INFLOW") {
        extraFactors.push("Inflow = FOMO buying — contrarian sell zone");
      }
    } else if (rsi >= 60 && allAligned) {
      action = "TRIM"; confidence = 70;
      rationale = "Crowded trade — everyone bullish, reduce before mean reversion";
      extraFactors.push("All MAs aligned + elevated RSI = consensus too strong");
    } else {
      action = "TRIM"; confidence = 55;
      rationale = "Overextended — contrarian says take profits here";
    }
  } else if (trendPhase === "ESTABLISHED_UPTREND") {
    if (rsi >= 70 && flow?.signal === "INFLOW") {
      action = "TRIM"; confidence = 65;
      rationale = "Strong consensus + overbought — contrarian trims into strength";
      extraFactors.push("Inflow with high RSI = late buyers arriving");
    } else if (sma20 < -1 && rsi < 45) {
      action = "BUY"; confidence = 60;
      rationale = "Dip in uptrend with cooling RSI — contrarian adds on fear";
    } else {
      action = "HOLD"; confidence = 50;
      rationale = "Uptrend intact — no contrarian edge, wait for extreme";
    }
  } else if (trendPhase === "PULLBACK_IN_UPTREND") {
    if (rsi <= 40) {
      action = "BUY"; confidence = 75;
      rationale = "Fear in an uptrend — contrarian sweet spot for entry";
      extraFactors.push("Short-term panic in long-term uptrend = high probability reversal");
    } else {
      action = "BUY"; confidence = 55;
      rationale = "Pullback but RSI not washed out yet — partial contrarian entry";
    }
  } else if (trendPhase === "EARLY_UPTREND") {
    if (rsi >= 70) {
      action = "HOLD"; confidence = 40;
      rationale = "New uptrend but already overbought — too late for contrarian";
    } else {
      action = "HOLD"; confidence = 45;
      rationale = "Trend forming — contrarian prefers buying deeper discounts";
    }
  } else {
    // NEUTRAL
    if (rsi <= 35) {
      action = "BUY"; confidence = 50;
      rationale = "No trend but oversold — contrarian nibble";
    } else if (rsi >= 65) {
      action = "TRIM"; confidence = 50;
      rationale = "No trend but overbought — contrarian lightens";
    } else {
      action = "HOLD"; confidence = 35;
      rationale = "No extreme — contrarian has no edge here";
    }
  }

  return { action, confidence, rationale, extraFactors };
}

// ---------------------------------------------------------------------------
// Strategy: Rotation — follow rank changes and turning points
// ---------------------------------------------------------------------------

function rotationStrategy(ctx: SignalContext) {
  const { etf, flow, rotation } = ctx;
  const { trendPhase, rsi } = etf;
  let action: ActionSignal = "HOLD";
  let confidence = 50;
  let rationale = "";
  const extraFactors: string[] = [];

  // Rotation strategy is driven by rank shift — is this sector gaining or losing relative position?
  const rankShift = rotation?.rankShift ?? 0;
  const rotScore = rotation?.rotationScore ?? 0;
  const rotSignal = rotation?.signal;

  // For asset class ETFs without rotation data, fall back to flow-based relative signal
  const hasRotation = rotation !== undefined;
  const improving = hasRotation ? rankShift > 2 : flow?.signal === "INFLOW";
  const deteriorating = hasRotation ? rankShift < -2 : flow?.signal === "OUTFLOW";
  const stronglyImproving = hasRotation ? rankShift > 4 : (flow?.flowScore ?? 0) > 6;
  const stronglyDeteriorating = hasRotation ? rankShift < -4 : (flow?.flowScore ?? 0) < -6;

  if (stronglyImproving) {
    if (trendPhase === "EARLY_UPTREND" || trendPhase === "PULLBACK_IN_UPTREND") {
      action = "BUY"; confidence = 80;
      rationale = `Strong rotation in (rank Δ: +${rankShift}) with trend inflection — high-conviction entry`;
    } else if (rsi < 65) {
      action = "BUY"; confidence = 70;
      rationale = `Rapidly improving relative rank (+${rankShift}) — rotating into leadership`;
    } else {
      action = "BUY"; confidence = 55;
      rationale = `Rank improving (+${rankShift}) but RSI elevated — enter on any dip`;
    }
    extraFactors.push(`Rank shift: +${rankShift} (moving toward top)`);
  } else if (improving) {
    if (rsi < 60) {
      action = "BUY"; confidence = 60;
      rationale = `Relative position improving (rank Δ: +${rankShift}) with room to run`;
    } else {
      action = "HOLD"; confidence = 50;
      rationale = `Rank improving (+${rankShift}) but wait for better entry`;
    }
  } else if (stronglyDeteriorating) {
    if (trendPhase === "EARLY_DOWNTREND" || trendPhase === "ESTABLISHED_DOWNTREND") {
      action = "SELL"; confidence = 80;
      rationale = `Rapid rotation out (rank Δ: ${rankShift}) with trend breakdown — exit`;
    } else {
      action = "SELL"; confidence = 65;
      rationale = `Falling from leadership (rank Δ: ${rankShift}) — capital rotating elsewhere`;
    }
    extraFactors.push(`Rank shift: ${rankShift} (falling from leadership)`);
  } else if (deteriorating) {
    if (trendPhase === "EXTENDED" || rsi >= 65) {
      action = "TRIM"; confidence = 60;
      rationale = `Losing relative rank (Δ: ${rankShift}) and overextended — rotate out`;
    } else {
      action = "HOLD"; confidence = 45;
      rationale = `Slight rank deterioration (Δ: ${rankShift}) — monitor for acceleration`;
    }
  } else {
    // Stable rank — no rotation signal
    if (trendPhase === "ESTABLISHED_UPTREND" && rsi < 60) {
      action = "HOLD"; confidence = 55;
      rationale = "Stable relative position in uptrend — maintain weight";
    } else if (trendPhase === "ESTABLISHED_DOWNTREND") {
      action = "SELL"; confidence = 55;
      rationale = "Stable but at bottom of rankings — no catalyst to rotate in";
    } else {
      action = "HOLD"; confidence = 40;
      rationale = "No significant rank change — no rotation signal";
    }
  }

  return { action, confidence, rationale, extraFactors };
}

// ---------------------------------------------------------------------------
// Capital mode modifier: Rotate (rebalance existing portfolio)
// ---------------------------------------------------------------------------

/**
 * Adjusts recommendations for the "rotate" capital mode.
 * Key differences from "deploy":
 *   - HOLD means "keep current weight" not "keep cash"
 *   - BUY means "overweight" (shift funds from underperformers)
 *   - SELL means "underweight" (shift funds to outperformers)
 *   - Confidence is tempered — rotation has transaction costs
 *   - No "keep cash" option — always fully invested
 */
function applyRotateModifier(
  result: { action: ActionSignal; confidence: number; rationale: string; extraFactors?: string[] },
  ctx: SignalContext
): { action: ActionSignal; confidence: number; rationale: string; extraFactors?: string[] } {
  const extraFactors = [...(result.extraFactors ?? [])];
  let { action, confidence, rationale } = result;

  // In rotate mode, lower confidence to account for switching costs
  // (selling one position to buy another has friction)
  if (action === "BUY" || action === "SELL") {
    confidence = Math.max(confidence - 5, 30);
  }

  // Reframe the language
  if (action === "BUY") {
    rationale = `Overweight — ${rationale}`;
    extraFactors.push("Rotate mode: shift weight from underperformers into this");
  } else if (action === "SELL") {
    rationale = `Underweight — ${rationale}`;
    extraFactors.push("Rotate mode: shift weight from this to outperformers");
  } else if (action === "TRIM") {
    rationale = `Reduce weight — ${rationale}`;
    extraFactors.push("Rotate mode: trim to fund overweight positions");
  } else {
    // HOLD
    rationale = `Maintain weight — ${rationale}`;
  }

  return { action, confidence, rationale, extraFactors };
}

// ---------------------------------------------------------------------------
// Sector Diagnostics — transparent phase detection with evidence
// ---------------------------------------------------------------------------

const ETF_SECTOR_MAP_DIAG: Record<string, string> = {
  XLK: "Technology",
  XLF: "Financial",
  XLE: "Energy",
  XLV: "Healthcare",
  XLY: "Consumer Cyclical",
  XLP: "Consumer Defensive",
  XLI: "Industrials",
  XLB: "Basic Materials",
  XLC: "Communication Services",
  XLRE: "Real Estate",
  XLU: "Utilities",
};

const SECTOR_TO_TICKER_DIAG: Record<string, string> = Object.fromEntries(
  Object.entries(ETF_SECTOR_MAP_DIAG).map(([t, s]) => [s, t])
);

export function computeSectorDiagnostics(
  sectorPerfs: SectorPerformance[],
  signals: RotationSignal[],
  fundFlows: ETFFundFlow[]
): SectorDiagnostic[] {
  const n = sectorPerfs.length;
  const flowMap = new Map(fundFlows.map(f => [f.sector, f]));

  return sectorPerfs.map(sp => {
    const sig = signals.find(s => s.sector === sp.sector);
    const flow = flowMap.get(sp.sector);
    const ticker = SECTOR_TO_TICKER_DIAG[sp.sector] || '';

    // --- Momentum regime ---
    const perf1W = sp.mcw1W;
    const perf1WAnnualized = perf1W * 52;
    const perf3MAnnualized = sp.mcw3M * 4;
    let momentumRegime: SectorDiagnostic["momentumRegime"];
    const accelThreshold = 10; // annualized % diff to call it accelerating
    if (perf1WAnnualized - perf3MAnnualized > accelThreshold) momentumRegime = "ACCELERATING";
    else if (perf3MAnnualized - perf1WAnnualized > accelThreshold) momentumRegime = "DECELERATING";
    else momentumRegime = "STEADY";

    // --- Breadth direction ---
    const breadth1W = sp.breadth1W;
    const breadth3M = sp.breadth3M;
    const breadthDiff = breadth1W - breadth3M;
    let breadthDirection: SectorDiagnostic["breadthDirection"];
    if (breadthDiff > 5) breadthDirection = "BROADENING";
    else if (breadthDiff < -5) breadthDirection = "NARROWING";
    else breadthDirection = "STABLE";

    // --- Size leadership ---
    const mcw1W = sp.mcw1W;
    const ew1W = sp.ew1W;
    const sizeSpread = mcw1W - ew1W;
    let sizeLeadership: SectorDiagnostic["sizeLeadership"];
    if (sizeSpread > 0.5) sizeLeadership = "LARGE_CAP_LED";
    else if (sizeSpread < -0.5) sizeLeadership = "SMALL_CAP_LED";
    else sizeLeadership = "BROAD_BASED";

    // --- Flow-price alignment ---
    const sharesPctChange = flow?.sharesPct5Day ?? 0;
    const priceChange = perf1W;
    let flowPriceSignal: SectorDiagnostic["flowPriceSignal"];
    if (sharesPctChange > 0.1 && priceChange < -0.5) flowPriceSignal = "ACCUMULATION";
    else if (sharesPctChange < -0.1 && priceChange > 0.5) flowPriceSignal = "DISTRIBUTION";
    else if (sharesPctChange > 0.1 && priceChange > 0.5) flowPriceSignal = "CONFIRMED_BULL";
    else if (sharesPctChange < -0.1 && priceChange < -0.5) flowPriceSignal = "CONFIRMED_BEAR";
    else flowPriceSignal = "NEUTRAL";

    // --- Rank velocity ---
    const rank1W = sig?.rank1W ?? n;
    const rank3M = sig?.rank3M ?? n;
    const rankVelocity = rank3M - rank1W; // positive = improving
    let rankSignal: SectorDiagnostic["rankSignal"];
    if (rankVelocity >= 4) rankSignal = "RAPID_ASCENT";
    else if (rankVelocity >= 2) rankSignal = "RISING";
    else if (rankVelocity <= -4) rankSignal = "RAPID_DESCENT";
    else if (rankVelocity <= -2) rankSignal = "FALLING";
    else rankSignal = "STABLE";

    // --- Build evidence strings with raw numbers ---
    const evidence: string[] = [];

    if (momentumRegime === "ACCELERATING") {
      evidence.push(`Momentum accelerating: 1W ann. ${perf1WAnnualized > 0 ? '+' : ''}${perf1WAnnualized.toFixed(0)}% vs 3M ann. ${perf3MAnnualized > 0 ? '+' : ''}${perf3MAnnualized.toFixed(0)}%`);
    } else if (momentumRegime === "DECELERATING") {
      evidence.push(`Momentum decelerating: 1W ann. ${perf1WAnnualized > 0 ? '+' : ''}${perf1WAnnualized.toFixed(0)}% vs 3M ann. ${perf3MAnnualized > 0 ? '+' : ''}${perf3MAnnualized.toFixed(0)}%`);
    }

    if (breadthDirection === "BROADENING") {
      evidence.push(`Breadth broadening: ${breadth1W.toFixed(0)}% positive this week vs ${breadth3M.toFixed(0)}% over 3M`);
    } else if (breadthDirection === "NARROWING") {
      evidence.push(`Breadth narrowing: ${breadth1W.toFixed(0)}% positive this week vs ${breadth3M.toFixed(0)}% over 3M`);
    }

    if (sizeLeadership === "LARGE_CAP_LED") {
      evidence.push(`Large-cap led: MCW ${mcw1W > 0 ? '+' : ''}${mcw1W.toFixed(2)}% vs EW ${ew1W > 0 ? '+' : ''}${ew1W.toFixed(2)}%`);
    } else if (sizeLeadership === "SMALL_CAP_LED") {
      evidence.push(`Small-cap led: EW ${ew1W > 0 ? '+' : ''}${ew1W.toFixed(2)}% vs MCW ${mcw1W > 0 ? '+' : ''}${mcw1W.toFixed(2)}%`);
    }

    if (flowPriceSignal === "ACCUMULATION") {
      evidence.push(`Accumulation: shares +${(sharesPctChange * 100).toFixed(2)}% but price ${priceChange > 0 ? '+' : ''}${priceChange.toFixed(2)}%`);
    } else if (flowPriceSignal === "DISTRIBUTION") {
      evidence.push(`Distribution: shares ${(sharesPctChange * 100).toFixed(2)}% but price +${priceChange.toFixed(2)}%`);
    } else if (flowPriceSignal === "CONFIRMED_BULL") {
      evidence.push(`Confirmed bull: shares +${(sharesPctChange * 100).toFixed(2)}% and price +${priceChange.toFixed(2)}%`);
    } else if (flowPriceSignal === "CONFIRMED_BEAR") {
      evidence.push(`Confirmed bear: shares ${(sharesPctChange * 100).toFixed(2)}% and price ${priceChange.toFixed(2)}%`);
    }

    if (rankSignal === "RAPID_ASCENT") {
      evidence.push(`Rapid ascent: ranked #${rank1W} now, was #${rank3M} over 3M`);
    } else if (rankSignal === "RAPID_DESCENT") {
      evidence.push(`Rapid descent: ranked #${rank1W} now, was #${rank3M} over 3M`);
    } else if (rankSignal === "RISING") {
      evidence.push(`Rising: ranked #${rank1W} now vs #${rank3M} over 3M`);
    } else if (rankSignal === "FALLING") {
      evidence.push(`Falling: ranked #${rank1W} now vs #${rank3M} over 3M`);
    }

    // --- Phase from evidence pattern ---
    let phase: SectorDiagnostic["phase"] = "NEUTRAL";

    if (breadthDirection === "BROADENING" && sharesPctChange > 0 && priceChange < 1) {
      phase = "EARLY_ACCUMULATION";
    } else if (momentumRegime === "ACCELERATING" && flowPriceSignal === "CONFIRMED_BULL") {
      phase = "CONFIRMED_UPTREND";
    } else if (momentumRegime === "ACCELERATING" && breadthDirection === "BROADENING") {
      phase = "CONFIRMED_UPTREND";
    } else if (perf1W > 0 && breadthDirection === "NARROWING" && sharesPctChange > 0) {
      phase = "LATE_STAGE";
    } else if (flowPriceSignal === "DISTRIBUTION") {
      phase = "DISTRIBUTION";
    } else if (momentumRegime === "DECELERATING" && breadthDirection === "NARROWING") {
      phase = "EARLY_DECLINE";
    } else if (momentumRegime === "DECELERATING" && flowPriceSignal === "CONFIRMED_BEAR") {
      phase = "CONFIRMED_DOWNTREND";
    } else if (momentumRegime === "DECELERATING" && sharesPctChange < -0.1) {
      phase = "CONFIRMED_DOWNTREND";
    }

    if (phase === "NEUTRAL") {
      if (momentumRegime === "ACCELERATING") phase = "CONFIRMED_UPTREND";
      else if (momentumRegime === "DECELERATING") phase = "EARLY_DECLINE";
    }

    return {
      sector: sp.sector,
      ticker,
      perf1W,
      perf1WAnnualized,
      perf3MAnnualized,
      momentumRegime,
      breadth1W,
      breadth3M,
      breadthDirection,
      mcw1W,
      ew1W,
      sizeSpread,
      sizeLeadership,
      sharesPctChange,
      priceChange,
      flowPriceSignal,
      rank1W,
      rank3M,
      rankVelocity,
      rankSignal,
      phase,
      evidence,
    };
  }).sort((a, b) => {
    const phaseOrder: Record<string, number> = {
      EARLY_ACCUMULATION: 0,
      CONFIRMED_UPTREND: 1,
      LATE_STAGE: 2,
      NEUTRAL: 3,
      DISTRIBUTION: 4,
      EARLY_DECLINE: 5,
      CONFIRMED_DOWNTREND: 6,
    };
    return (phaseOrder[a.phase] ?? 3) - (phaseOrder[b.phase] ?? 3);
  });
}

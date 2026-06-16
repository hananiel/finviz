import chalk from "chalk";
import Table from "cli-table3";
import type {
  SectorPerformance,
  RotationSignal,
  ETFValidation,
  AssetClassFlow,
  TrendPhase,
  ETFTrendDetail,
  ActionRecommendation,
} from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function colorPct(val: number, suffix = "%"): string {
  const str = `${val >= 0 ? "+" : ""}${val.toFixed(2)}${suffix}`;
  if (val > 0) return chalk.green(str);
  if (val < 0) return chalk.red(str);
  return chalk.gray(str);
}

function colorSignal(signal: string): string {
  if (signal === "INFLOW") return chalk.bold.green("▲ INFLOW");
  if (signal === "OUTFLOW") return chalk.bold.red("▼ OUTFLOW");
  return chalk.yellow("● NEUTRAL");
}

function colorScore(score: number): string {
  const str = score.toFixed(2);
  if (score > 8) return chalk.bold.green(str);
  if (score < -8) return chalk.bold.red(str);
  return chalk.yellow(str);
}

function colorRankShift(shift: number): string {
  const arrow = shift > 0 ? "↑" : shift < 0 ? "↓" : "→";
  const str = `${arrow}${Math.abs(shift)}`;
  if (shift > 0) return chalk.green(str);
  if (shift < 0) return chalk.red(str);
  return chalk.gray(str);
}

function colorVolume(signal: string): string {
  if (signal === "HIGH") return chalk.bold.green("HIGH");
  if (signal === "LOW") return chalk.dim.red("LOW");
  return chalk.gray("NORMAL");
}

function colorTrendPhase(phase?: TrendPhase): string {
  if (!phase) return chalk.dim("—");
  switch (phase) {
    case "EARLY_UPTREND":
      return chalk.bold.green("⬆ Early Uptrend");
    case "ESTABLISHED_UPTREND":
      return chalk.green("⬆ Established");
    case "EXTENDED":
      return chalk.bgYellow.black(" ⚡ Extended ");
    case "EARLY_DOWNTREND":
      return chalk.bold.red("⬇ Early Decline");
    case "ESTABLISHED_DOWNTREND":
      return chalk.red("⬇ Established");
    case "COUNTER_TREND_BOUNCE":
      return chalk.yellow("↩ Bounce");
    case "PULLBACK_IN_UPTREND":
      return chalk.cyan("↪ Pullback");
    case "NEUTRAL":
      return chalk.dim("● Neutral");
  }
}

function trendPhaseActionability(phase?: TrendPhase): string {
  if (!phase) return "";
  switch (phase) {
    case "EARLY_UPTREND":
      return "New trend forming — high reward if confirmed";
    case "ESTABLISHED_UPTREND":
      return "Confirmed trend — momentum aligned";
    case "EXTENDED":
      return "Late/overextended — mean reversion risk";
    case "EARLY_DOWNTREND":
      return "Trend breaking down — caution on longs";
    case "ESTABLISHED_DOWNTREND":
      return "Sustained decline — avoid catching knives";
    case "COUNTER_TREND_BOUNCE":
      return "Bounce in downtrend — likely short-lived";
    case "PULLBACK_IN_UPTREND":
      return "Dip in uptrend — potential entry if MA holds";
    case "NEUTRAL":
      return "No clear direction";
  }
}

function formatTrendShort(phase: TrendPhase): string {
  switch (phase) {
    case "EARLY_UPTREND": return "EARLY ⬆";
    case "ESTABLISHED_UPTREND": return "ESTAB ⬆";
    case "EXTENDED": return "LATE ⚡";
    case "EARLY_DOWNTREND": return "EARLY ⬇";
    case "ESTABLISHED_DOWNTREND": return "ESTAB ⬇";
    case "COUNTER_TREND_BOUNCE": return "BOUNCE";
    case "PULLBACK_IN_UPTREND": return "DIP";
    case "NEUTRAL": return "—";
  }
}

// ---------------------------------------------------------------------------
// Table 1: Sector Performance
// ---------------------------------------------------------------------------

export function renderPerformanceTable(
  sectorPerfs: SectorPerformance[],
  signals: RotationSignal[]
): void {
  // Sort by rotation score (match signal order)
  const signalOrder = new Map(signals.map((s, i) => [s.sector, i]));
  const sorted = [...sectorPerfs].sort(
    (a, b) => (signalOrder.get(a.sector) ?? 99) - (signalOrder.get(b.sector) ?? 99)
  );

  const table = new Table({
    head: [
      chalk.white.bold("Sector"),
      chalk.white.bold("Stocks"),
      chalk.white.bold("1W MCW"),
      chalk.white.bold("1M MCW"),
      chalk.white.bold("3M MCW"),
      chalk.white.bold("1W EW"),
      chalk.white.bold("Rank 1W"),
      chalk.white.bold("Rank 3M"),
      chalk.white.bold("Rank Δ"),
      chalk.white.bold("Breadth 1W"),
      chalk.white.bold("Breadth 3M"),
    ],
    style: { head: [], border: ["gray"] },
    colWidths: [25, 8, 10, 10, 10, 10, 9, 9, 9, 12, 12],
  });

  for (const sp of sorted) {
    const sig = signals.find((s) => s.sector === sp.sector);
    table.push([
      chalk.bold(sp.sector),
      String(sp.stockCount),
      colorPct(sp.mcw1W),
      colorPct(sp.mcw1M),
      colorPct(sp.mcw3M),
      colorPct(sp.ew1W),
      String(sig?.rank1W ?? "-"),
      String(sig?.rank3M ?? "-"),
      colorRankShift(sig?.rankShift ?? 0),
      colorPct(sp.breadth1W, "%"),
      colorPct(sp.breadth3M, "%"),
    ]);
  }

  console.log(chalk.bold.underline("\n📊 S&P 500 Sector Performance\n"));
  console.log(table.toString());
}

// ---------------------------------------------------------------------------
// Table 2: Rotation Signals
// ---------------------------------------------------------------------------

export function renderRotationTable(
  signals: RotationSignal[],
  sectorPerfs: SectorPerformance[]
): void {
  const perfMap = new Map(sectorPerfs.map((sp) => [sp.sector, sp]));

  const table = new Table({
    head: [
      chalk.white.bold("Sector"),
      chalk.white.bold("Signal"),
      chalk.white.bold("Score"),
      chalk.white.bold("Rank Δ"),
      chalk.white.bold("Momentum"),
      chalk.white.bold("Inst. Spread"),
      chalk.white.bold("Breadth Δ"),
      chalk.white.bold("Top 1W Movers"),
    ],
    style: { head: [], border: ["gray"] },
    colWidths: [25, 14, 9, 9, 11, 13, 11, 30],
  });

  for (const sig of signals) {
    const sp = perfMap.get(sig.sector);
    const movers =
      sp?.topMovers
        .map(
          (m) =>
            `${m.ticker} ${m.perf1W >= 0 ? "+" : ""}${m.perf1W.toFixed(1)}%`
        )
        .join(", ") ?? "";

    table.push([
      chalk.bold(sig.sector),
      colorSignal(sig.signal),
      colorScore(sig.rotationScore),
      colorRankShift(sig.rankShift),
      colorPct(sig.momentumAccel, ""),
      colorPct(sig.institutionalSpread),
      colorPct(sig.breadthDivergence, "pp"),
      chalk.dim(movers),
    ]);
  }

  console.log(chalk.bold.underline("\n🔄 Sector Rotation Signals\n"));
  console.log(table.toString());
  console.log(
    chalk.dim(
      "  Score > 8 = INFLOW, < -8 = OUTFLOW. Rank Δ = 3M rank − 1W rank (positive = improving)."
    )
  );
  console.log(
    chalk.dim(
      "  Inst. Spread = MCW − EW for 1W (positive = large-cap/institutional led)."
    )
  );
}

// ---------------------------------------------------------------------------
// Table 3: ETF Validation
// ---------------------------------------------------------------------------

export function renderETFTable(validations: ETFValidation[]): void {
  const table = new Table({
    head: [
      chalk.white.bold("ETF"),
      chalk.white.bold("Sector"),
      chalk.white.bold("ETF 1W"),
      chalk.white.bold("Stock MCW 1W"),
      chalk.white.bold("Divergence"),
      chalk.white.bold("Rel Volume"),
      chalk.white.bold("Vol Signal"),
    ],
    style: { head: [], border: ["gray"] },
    colWidths: [8, 25, 10, 13, 12, 12, 12],
  });

  for (const v of validations) {
    table.push([
      chalk.bold(v.etfTicker),
      v.sector,
      colorPct(v.etfPerf1W),
      colorPct(v.stockAvg1W),
      colorPct(v.divergence, "pp"),
      v.relVolume.toFixed(2),
      colorVolume(v.volumeSignal),
    ]);
  }

  console.log(chalk.bold.underline("\n🏦 Sector ETF Validation\n"));
  console.log(table.toString());
  console.log(
    chalk.dim(
      "  Divergence = ETF perf − stock MCW avg. Rel Volume > 1.5 = unusual institutional activity."
    )
  );
  console.log(
    chalk.dim(
      "  Positive divergence + HIGH volume = strong institutional inflow signal."
    )
  );
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export function renderSummary(
  signals: RotationSignal[],
  validations: ETFValidation[]
): void {
  const inflows = signals.filter((s) => s.signal === "INFLOW");
  const outflows = signals.filter((s) => s.signal === "OUTFLOW");

  const etfMap = new Map(validations.map((v) => [v.sector, v]));

  console.log(chalk.bold.underline("\n📋 Rotation Summary\n"));

  if (inflows.length > 0) {
    console.log(chalk.green.bold("  Money rotating INTO:"));
    for (const s of inflows) {
      const etf = etfMap.get(s.sector);
      const vol = etf ? ` | ETF rel vol: ${etf.relVolume.toFixed(2)}` : "";
      console.log(
        chalk.green(
          `    ▲ ${s.sector} (score: ${s.rotationScore.toFixed(1)}, rank Δ: +${s.rankShift}${vol})`
        )
      );
    }
  }

  if (outflows.length > 0) {
    console.log(chalk.red.bold("\n  Money rotating OUT OF:"));
    for (const s of outflows) {
      const etf = etfMap.get(s.sector);
      const vol = etf ? ` | ETF rel vol: ${etf.relVolume.toFixed(2)}` : "";
      console.log(
        chalk.red(
          `    ▼ ${s.sector} (score: ${s.rotationScore.toFixed(1)}, rank Δ: ${s.rankShift}${vol})`
        )
      );
    }
  }

  if (inflows.length === 0 && outflows.length === 0) {
    console.log(chalk.yellow("  No strong rotation signals detected."));
  }

  console.log();
}

// ---------------------------------------------------------------------------
// Asset Class Rotation Matrix
// ---------------------------------------------------------------------------

export function renderAssetClassTable(flows: AssetClassFlow[]): void {
  const table = new Table({
    head: [
      chalk.white.bold("Asset Class"),
      chalk.white.bold("ETFs"),
      chalk.white.bold("1W Perf"),
      chalk.white.bold("1M Perf"),
      chalk.white.bold("3M Perf"),
      chalk.white.bold("Rel Vol"),
      chalk.white.bold("Flow Score"),
      chalk.white.bold("Signal"),
      chalk.white.bold("Trend Phase"),
    ],
    style: { head: [], border: ["gray"] },
    colWidths: [18, 14, 10, 10, 10, 10, 12, 14, 20],
  });

  for (const f of flows) {
    table.push([
      chalk.bold(f.assetClass),
      chalk.dim(f.tickers.join(", ")),
      colorPct(f.avgPerf1W),
      colorPct(f.avgPerf1M),
      colorPct(f.avgPerf3M),
      f.avgRelVolume.toFixed(2),
      colorScore(f.flowScore),
      colorSignal(f.signal),
      colorTrendPhase(f.trendPhase),
    ]);
  }

  console.log(chalk.bold.underline("\n🌍 Asset Class Rotation Matrix\n"));
  console.log(table.toString());
  console.log(
    chalk.dim(
      "  Flow score = blended perf (20% 1W + 50% 1M + 30% 3M) × vol confidence (capped 2x). Signal > 3 = INFLOW."
    )
  );

  // Print trend phase interpretation
  const actionable = flows.filter((f) => f.trendPhase && f.trendPhase !== "NEUTRAL");
  if (actionable.length > 0) {
    console.log(chalk.bold("\n  Trend Maturity Assessment:"));
    for (const f of actionable) {
      const note = trendPhaseActionability(f.trendPhase);
      console.log(chalk.dim(`    ${f.assetClass}: ${note}`));
    }
  }
}

// ---------------------------------------------------------------------------
// ASCII Funnel Pipe — outflow (left) ← → inflow (right)
// ---------------------------------------------------------------------------

export function renderFlowFunnel(flows: AssetClassFlow[]): void {
  console.log(chalk.bold.underline("\n🔀 Capital Flow Funnel\n"));
  console.log(
    chalk.dim("  ◀ OUTFLOW ════════════════════╬════════════════════ INFLOW ▶")
  );
  console.log(
    chalk.dim("  (selling / capital leaving)    ║    (buying / capital entering)")
  );
  console.log();

  // Determine max absolute flow score for scaling
  const maxAbs = Math.max(...flows.map((f) => Math.abs(f.flowScore)), 1);
  const MAX_BAR = 25; // max half-width in chars

  for (const f of flows) {
    const barLen = Math.round((Math.abs(f.flowScore) / maxAbs) * MAX_BAR);
    const width = Math.max(barLen, 1);

    // Build the label (fixed width right-aligned on left side)
    const label = f.assetClass.padStart(16);

    // Volume indicator: thicker pipe chars for higher volume
    let pipeChar: string;
    let capChar: string;
    if (f.avgRelVolume >= 1.5) {
      pipeChar = "█"; capChar = "█";
    } else if (f.avgRelVolume >= 1.0) {
      pipeChar = "▓"; capChar = "▓";
    } else if (f.avgRelVolume >= 0.7) {
      pipeChar = "▒"; capChar = "▒";
    } else {
      pipeChar = "░"; capChar = "░";
    }

    // Score + volume + trend annotation
    const score = `${f.flowScore > 0 ? "+" : ""}${f.flowScore.toFixed(1)}`;
    const vol = `vol:${f.avgRelVolume.toFixed(2)}`;
    const trend = f.trendPhase && f.trendPhase !== "NEUTRAL"
      ? ` [${formatTrendShort(f.trendPhase)}]`
      : "";
    const annotation = `${score} (${vol})${trend}`;

    if (f.flowScore < 0) {
      // OUTFLOW — bar extends left from center
      const pipe = pipeChar.repeat(width);
      const padding = " ".repeat(MAX_BAR - width);
      const line = `  ${label} ${padding}${chalk.red(pipe)}║`;
      console.log(`${line} ${chalk.red(annotation)}`);
    } else if (f.flowScore > 0) {
      // INFLOW — bar extends right from center
      const pipe = pipeChar.repeat(width);
      const padding = " ".repeat(MAX_BAR);
      const line = `  ${label} ${padding}║${chalk.green(pipe)}`;
      console.log(`${line} ${chalk.green(annotation)}`);
    } else {
      // NEUTRAL — tiny marker at center
      const padding = " ".repeat(MAX_BAR);
      const line = `  ${label} ${padding}║${chalk.yellow(capChar)}`;
      console.log(`${line} ${chalk.yellow(annotation)}`);
    }
  }

  console.log();
  console.log(chalk.dim("  Pipe thickness: █ high vol (≥1.5x)  ▓ normal (≥1.0x)  ▒ low (≥0.7x)  ░ very low (<0.7x)"));

  // Overall market assessment
  const equities = flows.find((f) => f.assetClass === "US Equities");
  const safeHavens = flows.filter((f) =>
    ["Bonds", "Cash", "Gold"].includes(f.assetClass)
  );
  const safeHavenAvg =
    safeHavens.length > 0
      ? safeHavens.reduce((s, f) => s + f.flowScore, 0) / safeHavens.length
      : 0;

  console.log();
  if (equities && equities.flowScore < -3 && safeHavenAvg > 1) {
    console.log(
      chalk.bgRed.white.bold(
        "  ⚠  RISK-OFF: Capital leaving equities → rotating into safe havens  "
      )
    );
  } else if (equities && equities.flowScore > 3 && safeHavenAvg < -1) {
    console.log(
      chalk.bgGreen.white.bold(
        "  ✦  RISK-ON: Capital flowing into equities ← rotating out of safe havens  "
      )
    );
  } else if (equities && equities.flowScore < -3) {
    console.log(
      chalk.bgYellow.black.bold(
        "  ⚠  EQUITY OUTFLOW: Capital leaving equities — destination unclear  "
      )
    );
  } else {
    console.log(chalk.dim("  No strong cross-asset rotation detected."));
  }

  console.log();
}

// ---------------------------------------------------------------------------
// Per-ETF Trend Breakdown
// ---------------------------------------------------------------------------

function smaBar(val: number): string {
  // Compact visual: show distance from MA with direction
  const abs = Math.abs(val);
  const str = `${val >= 0 ? "+" : ""}${val.toFixed(1)}%`;
  if (val > 5) return chalk.bold.green(str);
  if (val > 0) return chalk.green(str);
  if (val < -5) return chalk.bold.red(str);
  if (val < 0) return chalk.red(str);
  return chalk.gray(str);
}

function rsiColor(rsi: number): string {
  const str = rsi.toFixed(0);
  if (rsi >= 70) return chalk.bgRed.white(` ${str} `);
  if (rsi >= 60) return chalk.yellow(str);
  if (rsi <= 30) return chalk.bgGreen.white(` ${str} `);
  if (rsi <= 40) return chalk.cyan(str);
  return chalk.gray(str);
}

export function renderTrendBreakdown(
  sectorTrends: ETFTrendDetail[],
  assetClassTrends: ETFTrendDetail[]
): void {
  // --- Sector ETFs (US Equities breakdown) ---
  console.log(chalk.bold.underline("\n📈 Sector Trend Breakdown (US Equities)\n"));

  const sectorTable = new Table({
    head: [
      chalk.white.bold("Sector"),
      chalk.white.bold("ETF"),
      chalk.white.bold("vs SMA20"),
      chalk.white.bold("vs SMA50"),
      chalk.white.bold("vs SMA200"),
      chalk.white.bold("RSI"),
      chalk.white.bold("Trend Phase"),
      chalk.white.bold("Actionability"),
    ],
    style: { head: [], border: ["gray"] },
    colWidths: [22, 7, 10, 10, 11, 7, 20, 40],
  });

  for (const t of sectorTrends) {
    sectorTable.push([
      chalk.bold(t.label),
      chalk.dim(t.ticker),
      smaBar(t.sma20),
      smaBar(t.sma50),
      smaBar(t.sma200),
      rsiColor(t.rsi),
      colorTrendPhase(t.trendPhase),
      chalk.dim(trendPhaseActionability(t.trendPhase)),
    ]);
  }

  console.log(sectorTable.toString());
  console.log(
    chalk.dim(
      "  Sorted by SMA50 distance (strongest uptrend first). RSI >70 = overbought, <30 = oversold."
    )
  );

  // --- Individual asset class ETFs ---
  console.log(chalk.bold.underline("\n📈 Individual ETF Trend Breakdown\n"));

  const etfTable = new Table({
    head: [
      chalk.white.bold("ETF"),
      chalk.white.bold("Name"),
      chalk.white.bold("vs SMA20"),
      chalk.white.bold("vs SMA50"),
      chalk.white.bold("vs SMA200"),
      chalk.white.bold("RSI"),
      chalk.white.bold("Trend Phase"),
      chalk.white.bold("Actionability"),
    ],
    style: { head: [], border: ["gray"] },
    colWidths: [7, 22, 10, 10, 11, 7, 20, 40],
  });

  for (const t of assetClassTrends) {
    etfTable.push([
      chalk.bold(t.ticker),
      chalk.dim(t.label),
      smaBar(t.sma20),
      smaBar(t.sma50),
      smaBar(t.sma200),
      rsiColor(t.rsi),
      colorTrendPhase(t.trendPhase),
      chalk.dim(trendPhaseActionability(t.trendPhase)),
    ]);
  }

  console.log(etfTable.toString());
}

// ---------------------------------------------------------------------------
// Action Signals — BUY / SELL / HOLD / TRIM
// ---------------------------------------------------------------------------

function colorAction(action: string): string {
  switch (action) {
    case "BUY": return chalk.bgGreen.white.bold(" BUY ");
    case "HOLD": return chalk.yellow.bold("HOLD ");
    case "TRIM": return chalk.yellow.bold("TRIM ");
    case "SELL": return chalk.bgRed.white.bold(" SELL");
    default: return chalk.gray(action);
  }
}

function confidenceBar(confidence: number): string {
  const filled = Math.round(confidence / 10);
  const empty = 10 - filled;
  const bar = "█".repeat(filled) + "░".repeat(empty);
  if (confidence >= 70) return chalk.green(`${bar} ${confidence}%`);
  if (confidence >= 50) return chalk.yellow(`${bar} ${confidence}%`);
  return chalk.dim(`${bar} ${confidence}%`);
}

export function renderActionSignals(
  sectorRecs: ActionRecommendation[],
  assetClassRecs: ActionRecommendation[]
): void {
  console.log(chalk.bold.underline("\n🎯 Action Signals — Sector ETFs\n"));

  const sectorTable = new Table({
    head: [
      chalk.white.bold("ETF"),
      chalk.white.bold("Action"),
      chalk.white.bold("Sector"),
      chalk.white.bold("Confidence"),
      chalk.white.bold("Rationale"),
    ],
    style: { head: [], border: ["gray"] },
    colWidths: [7, 9, 22, 18, 55],
  });

  for (const r of sectorRecs) {
    sectorTable.push([
      chalk.bold(r.ticker),
      colorAction(r.action),
      r.label,
      confidenceBar(r.confidence),
      chalk.dim(r.rationale),
    ]);
  }

  console.log(sectorTable.toString());

  console.log(chalk.bold.underline("\n🎯 Action Signals — Asset Class ETFs\n"));

  const etfTable = new Table({
    head: [
      chalk.white.bold("ETF"),
      chalk.white.bold("Action"),
      chalk.white.bold("Name"),
      chalk.white.bold("Confidence"),
      chalk.white.bold("Rationale"),
    ],
    style: { head: [], border: ["gray"] },
    colWidths: [7, 9, 22, 18, 55],
  });

  for (const r of assetClassRecs) {
    etfTable.push([
      chalk.bold(r.ticker),
      colorAction(r.action),
      r.label,
      confidenceBar(r.confidence),
      chalk.dim(r.rationale),
    ]);
  }

  console.log(etfTable.toString());

  // Print supporting factors for top conviction signals
  const highConviction = [...sectorRecs, ...assetClassRecs].filter(
    (r) => r.confidence >= 65 && r.action !== "HOLD"
  );
  if (highConviction.length > 0) {
    console.log(chalk.bold("\n  High-Conviction Signals (≥65% confidence):\n"));
    for (const r of highConviction) {
      const actionColor = r.action === "BUY"
        ? chalk.green
        : chalk.red;
      console.log(actionColor(`    ${r.action} ${r.ticker} (${r.label})`));
      for (const f of r.factors) {
        console.log(chalk.dim(`      • ${f}`));
      }
      console.log();
    }
  }
}

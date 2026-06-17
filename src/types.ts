/** Raw per-stock data after joining map perf + screener */
export interface StockData {
  ticker: string;
  company: string;
  sector: string;
  industry: string;
  marketCap: number; // in dollars
  perf1W: number;    // % change
  perf1M: number;
  perf3M: number;
}

/** Aggregated sector-level performance */
export interface SectorPerformance {
  sector: string;
  stockCount: number;
  // Market-cap-weighted averages
  mcw1W: number;
  mcw1M: number;
  mcw3M: number;
  // Equal-weight averages
  ew1W: number;
  ew1M: number;
  ew3M: number;
  // Breadth: % of stocks positive
  breadth1W: number;
  breadth1M: number;
  breadth3M: number;
  // Top movers (by 1W performance)
  topMovers: { ticker: string; perf1W: number }[];
}

/** Rotation signal for a single sector */
export interface RotationSignal {
  sector: string;
  signal: "INFLOW" | "OUTFLOW" | "NEUTRAL";
  rotationScore: number;
  // Components
  rankShift: number;        // 3M rank - 1W rank (positive = rotating in)
  momentumAccel: number;    // annualized 1W vs 3M diff
  institutionalSpread: number; // MCW - EW for 1W (positive = large-cap led)
  breadthDivergence: number;   // breadth1W - breadth3M
  rank1W: number;
  rank3M: number;
}

/** Sector ETF data from screener */
export interface SectorETF {
  ticker: string;       // e.g. "XLK"
  sector: string;       // mapped sector name
  perf1W: number;
  perf1M: number;
  perf3M: number;
  avgVolume: number;
  relVolume: number;
  price: number;
}

/** ETF validation result */
export interface ETFValidation {
  etfTicker: string;
  sector: string;
  etfPerf1W: number;
  stockAvg1W: number;    // MCW average from stock data
  divergence: number;     // etfPerf1W - stockAvg1W
  relVolume: number;
  volumeSignal: "HIGH" | "NORMAL" | "LOW";
}

/** Asset class definition for cross-asset rotation */
export interface AssetClassETF {
  ticker: string;
  assetClass: string;
  label: string;        // display label
  perf1W: number;
  perf1M: number;
  perf3M: number;
  relVolume: number;
}

/** Asset class rotation result */
export interface AssetClassFlow {
  assetClass: string;
  label: string;
  tickers: string[];
  avgPerf1W: number;
  avgPerf1M: number;
  avgPerf3M: number;
  avgRelVolume: number;
  flowScore: number;      // positive = inflow, negative = outflow
  signal: "INFLOW" | "OUTFLOW" | "NEUTRAL";
  trendPhase?: TrendPhase; // trend maturity classification
}

/** Trend phase classification */
export type TrendPhase =
  | "EARLY_UPTREND"       // just crossed above SMA50, SMA200 still flat/below
  | "ESTABLISHED_UPTREND" // above SMA50 and SMA200, confirmed
  | "EXTENDED"            // far above both SMAs, overextended / late in trend
  | "EARLY_DOWNTREND"     // just crossed below SMA50, SMA200 still above
  | "ESTABLISHED_DOWNTREND" // below both SMA50 and SMA200
  | "COUNTER_TREND_BOUNCE"  // above SMA20, below SMA50 (bounce in downtrend)
  | "PULLBACK_IN_UPTREND"   // below SMA20, above SMA50 (dip in uptrend)
  | "NEUTRAL";              // no clear phase

/** Technical data for an ETF (from finviz screener v=171) */
export interface TechnicalData {
  ticker: string;
  sma20: number;    // % distance from price to 20-day SMA (positive = above)
  sma50: number;    // % distance from price to 50-day SMA
  sma200: number;   // % distance from price to 200-day SMA
  rsi: number;      // RSI(14)
  from52WHigh: number; // % below 52-week high (negative value)
  from52WLow: number;  // % above 52-week low (positive value)
}

/** Per-ETF trend detail — used for granular breakdowns */
export interface ETFTrendDetail {
  ticker: string;
  label: string;      // human-readable name (e.g. "Technology" or "Gold")
  sma20: number;
  sma50: number;
  sma200: number;
  rsi: number;
  trendPhase: TrendPhase;
}

/** Action signal for an ETF */
export type ActionSignal = "BUY" | "SELL" | "HOLD" | "TRIM";

/** Capital deployment context */
export type CapitalMode = "deploy" | "rotate";

/** Investment strategy philosophy */
export type Strategy = "momentum" | "contrarian" | "rotation";

/** Combined investing mode */
export interface InvestingMode {
  capital: CapitalMode;
  strategy: Strategy;
}

/** Buy/Sell/Hold recommendation with rationale */
export interface ActionRecommendation {
  ticker: string;
  label: string;
  action: ActionSignal;
  confidence: number;   // 0-100 conviction level
  rationale: string;    // one-line explanation
  factors: string[];    // supporting evidence bullets
}

/** Timeframe identifiers for the map API */
export type Timeframe = "w1" | "w4" | "w13";

/** Screener stock row (sector mapping + market cap) */
export interface ScreenerStock {
  ticker: string;
  company: string;
  sector: string;
  industry: string;
  marketCap: number;
}

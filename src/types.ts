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

/** Real fund flow data from ETF creation/redemption */
export interface ETFFundFlow {
  ticker: string;
  sector: string;
  totalAssets: number;  // current AUM in dollars (for treemap sizing)
  sharesOutstanding: number; // current shares (derived: totalAssets / price)
  sharesPct5Day: number;    // % change in shares over 5 days
  sharesPct1Month: number;  // % change in shares over 1 month
  sharesPct3Month: number;  // % change in shares over 3 months
  sharesPct1Year: number;   // % change in shares over 1 year
  flow5Day: number;     // net dollars in/out over 5 days (from daily AUM snapshots)
  flow1Month: number;   // net dollars in/out over 1 month
  flow3Month: number;   // net dollars in/out over 3 months (from SEC N-PORT or snapshots)
  flow6Month: number;   // net dollars in/out over 6 months (from SEC N-PORT)
  flow1Year: number;    // net dollars in/out over 1 year (from SEC N-PORT)
}

/** Daily AUM snapshot for a sector ETF (stored in history for flow computation) */
export interface ETFAUMSnapshot {
  ticker: string;
  sector: string;
  totalAssets: number;  // from Yahoo Finance summaryDetail.totalAssets
  price: number;        // closing price
  date: string;         // ISO date YYYY-MM-DD
}

/** Quarterly N-PORT data from SEC EDGAR */
export interface NPortQuarterlyData {
  seriesId: string;
  ticker: string;
  sector: string;
  netAssets: number;    // from <netAssets> in N-PORT XML
  periodEnd: string;    // reporting period end date (YYYY-MM-DD)
  filingDate: string;   // when filed with SEC
}

/** Screener stock row (sector mapping + market cap) */
export interface ScreenerStock {
  ticker: string;
  company: string;
  sector: string;
  industry: string;
  marketCap: number;
}

/** Sector rotation diagnostic — shows raw evidence for phase detection */
export interface SectorDiagnostic {
  sector: string;
  ticker: string; // sector ETF ticker

  // Momentum regime
  perf1W: number;          // actual 1-week % return
  perf1WAnnualized: number; // annualized (×52)
  perf3MAnnualized: number; // annualized (×4)
  momentumRegime: "ACCELERATING" | "DECELERATING" | "STEADY";

  // Breadth health
  breadth1W: number;       // % of stocks positive this week
  breadth3M: number;       // % of stocks positive over 3 months
  breadthDirection: "BROADENING" | "NARROWING" | "STABLE";

  // Size leadership (institutional fingerprint)
  mcw1W: number;           // market-cap-weighted 1W return
  ew1W: number;            // equal-weight 1W return
  sizeSpread: number;      // mcw - ew (positive = large-cap led)
  sizeLeadership: "LARGE_CAP_LED" | "BROAD_BASED" | "SMALL_CAP_LED";

  // Flow-price alignment
  sharesPctChange: number; // shares outstanding % change (active timeframe)
  priceChange: number;     // price change % (matching timeframe)
  flowPriceSignal: "ACCUMULATION" | "DISTRIBUTION" | "CONFIRMED_BULL" | "CONFIRMED_BEAR" | "NEUTRAL";

  // Rank velocity
  rank1W: number;
  rank3M: number;
  rankVelocity: number;    // rank3M - rank1W (positive = rising)
  rankSignal: "RAPID_ASCENT" | "RISING" | "STABLE" | "FALLING" | "RAPID_DESCENT";

  // Dark pool signal (with trend)
  darkPoolShortRatio: number;    // most recent day's short ratio (0-1)
  darkPoolShortRatio5d: number;  // 5-day average short ratio
  darkPoolShortRatio20d: number; // 20-day average short ratio
  darkPoolTrend: "INCREASING" | "DECREASING" | "STABLE"; // 5d vs 20d direction
  darkPoolSignal: "HEAVY_SHORTING" | "ELEVATED_SHORTING" | "NEUTRAL_DP" | "LOW_SHORTING";

  // Options signal
  putCallRatio: number;          // put volume / call volume (>1 = bearish positioning)
  putCallOIRatio: number;        // put OI / call OI (accumulated positioning)
  impliedVolatility: number;     // ATM IV (annualized decimal, e.g. 0.25 = 25%)
  optionsSignal: "HEAVY_PUT_BUYING" | "ELEVATED_PUTS" | "NEUTRAL_OPT" | "CALL_HEAVY" | "EXTREME_FEAR";

  // Synthesis (human-readable, not a black box)
  phase: "EARLY_ACCUMULATION" | "CONFIRMED_UPTREND" | "LATE_STAGE" | "DISTRIBUTION" | "EARLY_DECLINE" | "CONFIRMED_DOWNTREND" | "NEUTRAL";
  evidence: string[]; // list of plain-English reasons for the phase
}

/** Dark pool short volume data for an ETF — single day, single source */
export interface DarkPoolData {
  ticker: string;
  sector: string;
  source: "FINRA" | "NYSE_ARCA" | "NASDAQ"; // which exchange reported this
  shortVolume: number;       // shares sold short
  totalVolume: number;       // total volume on this venue
  shortRatio: number;        // shortVolume / totalVolume (0-1)
  date: string;              // ISO date YYYY-MM-DD
}

/** Cross-validated dark pool aggregate for an ETF — combines all sources for one day */
export interface DarkPoolAggregate {
  ticker: string;
  sector: string;
  date: string;
  // Per-source ratios (for transparency / validation)
  finraRatio: number;        // FINRA (off-exchange) short ratio
  arcaRatio: number;         // NYSE Arca short ratio
  nasdaqRatio: number;       // Nasdaq short ratio
  // Volume-weighted combined ratio (the signal we use)
  combinedShortRatio: number;
  combinedShortVolume: number;
  combinedTotalVolume: number;
  // Validation flag: do sources agree?
  sourcesAgree: boolean;     // true if max divergence between sources < 10%
  maxDivergence: number;     // largest difference between any two source ratios
}

/** Aggregated dark pool trend for an ETF over multiple days */
export interface DarkPoolTrend {
  ticker: string;
  sector: string;
  shortRatio1d: number;      // most recent day's combined short ratio
  shortRatio5d: number;      // 5-day average combined short ratio
  shortRatio20d: number;     // 20-day (monthly) average combined short ratio
  trend: "INCREASING" | "DECREASING" | "STABLE"; // 5d avg vs 20d avg direction
  trendStrength: number;     // magnitude of change (5d avg - 20d avg, in ratio units)
  daysOfData: number;        // how many days of data we have
  sourcesAgree: boolean;     // did all sources agree on today's reading?
  maxDivergence: number;     // largest divergence between sources today
}

/** Options flow data for an ETF */
export interface OptionsData {
  ticker: string;
  sector: string;
  putVolume: number;         // total put contracts traded
  callVolume: number;        // total call contracts traded
  putCallRatio: number;      // putVolume / callVolume
  putOpenInterest: number;   // total put open interest
  callOpenInterest: number;  // total call open interest
  putCallOIRatio: number;    // putOI / callOI
  impliedVolatility: number; // ATM IV (annualized, decimal)
  date: string;              // ISO date
}

import * as cheerio from "cheerio";
import type { Timeframe, ScreenerStock, StockData, SectorETF, AssetClassETF, TechnicalData, ETFFundFlow, ETFAUMSnapshot, NPortQuarterlyData, DarkPoolData, DarkPoolAggregate, OptionsData } from "./types.js";

const BASE_URL = "https://finviz.com";
const MAP_API = `${BASE_URL}/api/map_perf.ashx`;
const SCREENER_URL = `${BASE_URL}/screener.ashx`;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const ETF_SECTOR_MAP: Record<string, string> = {
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

const SECTOR_ETF_TICKERS = Object.keys(ETF_SECTOR_MAP).join(",");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url: string, retries = 3): Promise<Response> {
  for (let i = 0; i <= retries; i++) {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          Accept: "text/html,application/json;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "User-Agent": USER_AGENT,
        },
      });
    } catch (err) {
      if (i === retries) throw err;
      await sleep(2000 * (i + 1));
      continue;
    }

    if (res.ok) return res;
    if (
      (res.status === 403 || res.status === 429 || res.status >= 500) &&
      i < retries
    ) {
      const retryAfterHeader = res.headers.get("retry-after");
      const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : NaN;
      await sleep(Number.isFinite(retryAfter) ? retryAfter * 1000 : 2000 * (i + 1));
      continue;
    }
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  throw new Error(`Failed after ${retries} retries: ${url}`);
}

// ---------------------------------------------------------------------------
// 1. Map Performance API — returns ticker → % change
// ---------------------------------------------------------------------------

export async function fetchMapPerformance(
  timeframe: Timeframe
): Promise<Map<string, number>> {
  const url = `${MAP_API}?t=sec&st=${timeframe}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetchWithRetry(url);
    const json = (await res.json()) as { nodes?: Record<string, number> };
    const performance = new Map(Object.entries(json.nodes ?? {}));
    if (performance.size > 400) return performance;

    if (attempt < 3) {
      console.warn(
        `  ⚠ ${timeframe} map returned only ${performance.size} stocks; retrying (${attempt}/3)`
      );
      await sleep(2000 * attempt);
    }
  }

  throw new Error(
    `${timeframe} map returned fewer than 400 S&P 500 stocks after 3 attempts`
  );
}

// ---------------------------------------------------------------------------
// 2. Screener — parse HTML tables for sector mapping + market cap
// ---------------------------------------------------------------------------

/**
 * Parse a Finviz numeric cell into a plain number.
 *
 * Tolerates the formatting variance Finviz applies across views: thousands
 * separators, currency symbols, leading "+", unicode minus, percent suffixes,
 * magnitude suffixes (K/M/B/T) and the "-"/"N/A" placeholders used for missing
 * data. Returns `fallback` when the cell holds no number.
 */
function parseNumeric(raw: string, fallback = 0): number {
  const cleaned = raw
    .replace(/[\u2212\u2012-\u2015]/g, "-") // unicode minus / dashes → ASCII
    .replace(/[,\s$%+]/g, "")
    .trim();
  const match = cleaned.match(/^(-?\d*\.?\d+)([KMBT])?$/i);
  if (!match) return fallback;

  const multipliers: Record<string, number> = { T: 1e12, B: 1e9, M: 1e6, K: 1e3 };
  const value = parseFloat(match[1]);
  if (!Number.isFinite(value)) return fallback;
  return value * (match[2] ? multipliers[match[2].toUpperCase()] : 1);
}

/** Parse market cap strings like "3643.71B", "78.83M", "1.2T" into raw dollars */
function parseMarketCap(raw: string): number {
  return parseNumeric(raw);
}

/** Parse a percentage string like "-3.80%" → -3.80 */
function parsePct(raw: string): number {
  return parseNumeric(raw);
}

/** Parse a volume string like "18,570,783" or "2.19M" → number */
function parseVolume(raw: string): number {
  return parseNumeric(raw);
}

/**
 * A single screener result row, with its columns addressable by the table's own
 * header labels. Finviz renames, reorders and restyles view columns without
 * notice, so positional indexes never escape this module.
 */
export interface ScreenerRow {
  ticker: string;
  /**
   * Look up a cell by header label. Labels are matched case-insensitively and
   * ignoring punctuation/whitespace ("Market Cap." === "market cap"), then by
   * prefix, so a renamed "Perf Week" → "Perf Week %" still resolves. The first
   * label that matches wins; returns "" when none do.
   */
  get(...labels: string[]): string;
}

/** Reduce a header label to a comparable key: lowercase alphanumerics only. */
function normalizeLabel(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Extract a ticker symbol from any Finviz link that carries a `t=` parameter. */
function tickerFromHref(href: string): string | null {
  const match = href.match(/[?&]t=([^&"'#]+)/);
  if (!match) return null;
  const ticker = decodeURIComponent(match[1]).trim().toUpperCase();
  return /^[A-Z0-9.\-]{1,10}$/.test(ticker) ? ticker : null;
}

/**
 * Parse a Finviz screener HTML page into label-addressable rows.
 *
 * Deliberately assumes as little as possible about the markup:
 * - The results table is located by finding the header row that contains a
 *   "Ticker" column, not by class name (Finviz churns its CSS classes).
 * - Columns are addressed by header label, never by position.
 * - Tickers come from each row's link `t=` parameter, not from cell text: the
 *   ticker cell also renders a logo whose alt text duplicates the first letter
 *   (e.g. AAPL reads as "AAAPL").
 * - Header and data cells may be `th` or `td`.
 */
export function parseScreenerTable(html: string): ScreenerRow[] {
  const $ = cheerio.load(html);

  // The header row is any row whose cells include a bare "Ticker" label. Prefer
  // the last such row so a nested/duplicated layout header loses to the real one.
  const headerRows = $("tr")
    .toArray()
    .filter((row) =>
      $(row)
        .children("th,td")
        .toArray()
        .some((cell) => normalizeLabel($(cell).text()) === "ticker")
    );
  const headerRow = headerRows[headerRows.length - 1];
  if (!headerRow) return [];

  const columnIndex = new Map<string, number>();
  $(headerRow)
    .children("th,td")
    .toArray()
    .forEach((cell, index) => {
      const key = normalizeLabel($(cell).text());
      if (key && !columnIndex.has(key)) columnIndex.set(key, index);
    });

  const resolveColumn = (label: string): number | undefined => {
    const key = normalizeLabel(label);
    if (!key) return undefined;
    const exact = columnIndex.get(key);
    if (exact !== undefined) return exact;
    for (const [candidate, index] of columnIndex) {
      if (candidate.startsWith(key)) return index;
    }
    return undefined;
  };

  // Data rows are the siblings of the header row inside the same table.
  const table = $(headerRow).closest("table");
  const candidateRows = (table.length > 0 ? table.find("tr") : $("tr")).toArray();

  const rows: ScreenerRow[] = [];
  for (const row of candidateRows) {
    if (row === headerRow) continue;

    const ticker = $(row)
      .find("a[href]")
      .toArray()
      .map((link) => tickerFromHref($(link).attr("href") ?? ""))
      .find((value): value is string => value !== null);
    if (!ticker) continue;

    const cells = $(row)
      .children("th,td")
      .toArray()
      .map((cell) => $(cell).text().trim());
    if (cells.length === 0) continue;

    rows.push({
      ticker,
      get(...labels: string[]): string {
        for (const label of labels) {
          const index = resolveColumn(label);
          if (index !== undefined && cells[index] !== undefined) return cells[index];
        }
        return "";
      },
    });
  }

  return rows;
}

async function fetchScreenerPage(offset: number): Promise<ScreenerStock[]> {
  const url = `${SCREENER_URL}?v=152&f=idx_sp500&r=${offset}`;
  const validSectors = new Set(Object.values(ETF_SECTOR_MAP));

  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetchWithRetry(url);
    const stocks: ScreenerStock[] = [];

    for (const row of parseScreenerTable(await res.text())) {
      const sector = row.get("Sector");
      if (!validSectors.has(sector)) continue;

      stocks.push({
        ticker: row.ticker,
        company: row.get("Company"),
        sector,
        industry: row.get("Industry"),
        marketCap: parseMarketCap(row.get("Market Cap")),
      });
    }

    // Every page except the final partial page should contain 20 constituents.
    const minimumExpected = offset >= 501 ? 1 : 15;
    if (stocks.length >= minimumExpected) return stocks;

    if (attempt < 3) {
      console.warn(
        `  ⚠ Screener offset ${offset} returned only ${stocks.length} stocks; retrying (${attempt}/3)`
      );
      await sleep(2000 * attempt);
    }
  }

  throw new Error(`Screener offset ${offset} returned too few stocks after 3 attempts`);
}

export async function fetchSectorMapping(): Promise<Map<string, ScreenerStock>> {
  const allStocks = new Map<string, ScreenerStock>();
  const totalPages = 26; // 503 stocks, 20 per page

  // Finviz throttles cloud-hosted IPs aggressively. Fetch sequentially so a CI run does
  // not issue ten requests at once (five pages plus the other top-level Finviz calls).
  for (let page = 0; page < totalPages; page++) {
    const stocks = await fetchScreenerPage(page * 20 + 1);
    for (const stock of stocks) {
      allStocks.set(stock.ticker, stock);
    }
    if (page + 1 < totalPages) await sleep(250);
  }

  console.log(`  Fetched sector mapping for ${allStocks.size} stocks`);
  if (allStocks.size <= 400) {
    throw new Error(`Finviz screener returned only ${allStocks.size} S&P 500 stocks`);
  }
  return allStocks;
}

// ---------------------------------------------------------------------------
// 3. Sector ETFs — single page fetch
// ---------------------------------------------------------------------------

export async function fetchSectorETFs(): Promise<SectorETF[]> {
  const url = `${SCREENER_URL}?v=140&t=${SECTOR_ETF_TICKERS}`;
  const res = await fetchWithRetry(url);

  const etfs: SectorETF[] = [];
  for (const row of parseScreenerTable(await res.text())) {
    if (!(row.ticker in ETF_SECTOR_MAP)) continue;

    etfs.push({
      ticker: row.ticker,
      sector: ETF_SECTOR_MAP[row.ticker],
      perf1W: parsePct(row.get("Perf Week")),
      perf1M: parsePct(row.get("Perf Month")),
      perf3M: parsePct(row.get("Perf Quart", "Perf Quarter")),
      avgVolume: parseVolume(row.get("Avg Volume", "Average Volume")),
      relVolume: parseNumeric(row.get("Rel Volume", "Relative Volume"), 1),
      price: parseNumeric(row.get("Price")),
    });
  }

  console.log(`  Fetched ${etfs.length} sector ETFs`);
  const expected = Object.keys(ETF_SECTOR_MAP).length;
  if (etfs.length < expected) {
    throw new Error(`Sector ETF screener returned ${etfs.length}/${expected} ETFs`);
  }
  return etfs;
}

// ---------------------------------------------------------------------------
// 4. Asset Class ETFs — cross-asset rotation tracking
// ---------------------------------------------------------------------------

const ASSET_CLASS_ETF_MAP: Record<string, { assetClass: string; label: string }> = {
  // US Equities (benchmark)
  SPY:  { assetClass: "US Equities",    label: "S&P 500" },
  // Treasuries / Bonds
  TLT:  { assetClass: "Bonds",          label: "20+ Yr Treasury" },
  IEF:  { assetClass: "Bonds",          label: "7-10 Yr Treasury" },
  SHY:  { assetClass: "Bonds",          label: "1-3 Yr Treasury" },
  BIL:  { assetClass: "Cash",           label: "T-Bills / Cash" },
  // Gold / Precious Metals
  GLD:  { assetClass: "Gold",           label: "Gold" },
  GDX:  { assetClass: "Gold",           label: "Gold Miners" },
  // Commodities
  DBC:  { assetClass: "Commodities",    label: "Commodity Index" },
  USO:  { assetClass: "Commodities",    label: "Oil" },
  // Crypto
  IBIT: { assetClass: "Crypto",         label: "Bitcoin ETF" },
  BITO: { assetClass: "Crypto",         label: "Bitcoin Futures" },
  // International
  EFA:  { assetClass: "International",  label: "Developed Markets" },
  EEM:  { assetClass: "International",  label: "Emerging Markets" },
};

const ASSET_CLASS_TICKERS = Object.keys(ASSET_CLASS_ETF_MAP).join(",");

export async function fetchAssetClassETFs(): Promise<AssetClassETF[]> {
  const url = `${SCREENER_URL}?v=140&t=${ASSET_CLASS_TICKERS}`;
  const res = await fetchWithRetry(url);

  const etfs: AssetClassETF[] = [];
  for (const row of parseScreenerTable(await res.text())) {
    const info = ASSET_CLASS_ETF_MAP[row.ticker];
    if (!info) continue;

    etfs.push({
      ticker: row.ticker,
      assetClass: info.assetClass,
      label: info.label,
      perf1W: parsePct(row.get("Perf Week")),
      perf1M: parsePct(row.get("Perf Month")),
      perf3M: parsePct(row.get("Perf Quart", "Perf Quarter")),
      relVolume: parseNumeric(row.get("Rel Volume", "Relative Volume"), 1),
    });
  }

  console.log(`  Fetched ${etfs.length} asset class ETFs`);
  if (etfs.length === 0) {
    throw new Error("Asset class ETF screener returned no rows");
  }
  return etfs;
}

// ---------------------------------------------------------------------------
// 4b. Technical Data — SMA distances + RSI for trend phase classification
// ---------------------------------------------------------------------------

export async function fetchTechnicalData(tickers: string[]): Promise<Map<string, TechnicalData>> {
  const results = new Map<string, TechnicalData>();

  // Finviz screener paginates at 20 rows — split into batches to ensure we get all
  const BATCH_SIZE = 20;
  for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
    const batch = tickers.slice(i, i + BATCH_SIZE);
    const tickerStr = batch.join(",");
    // v=171 = Technical view: No, Ticker, Beta, ATR, SMA20, SMA50, SMA200, 52W High, 52W Low, RSI, ...
    const url = `${SCREENER_URL}?v=171&t=${tickerStr}`;
    const res = await fetchWithRetry(url);

    for (const row of parseScreenerTable(await res.text())) {
      if (!batch.includes(row.ticker)) continue;

      results.set(row.ticker, {
        ticker: row.ticker,
        sma20: parsePct(row.get("SMA20", "SMA 20")),
        sma50: parsePct(row.get("SMA50", "SMA 50")),
        sma200: parsePct(row.get("SMA200", "SMA 200")),
        from52WHigh: parsePct(row.get("52W High", "52-Week High")),
        from52WLow: parsePct(row.get("52W Low", "52-Week Low")),
        rsi: parseNumeric(row.get("RSI", "Relative Strength Index"), 50),
      });
    }

    if (i + BATCH_SIZE < tickers.length) {
      await sleep(300);
    }
  }

  console.log(`  Fetched technical data for ${results.size}/${tickers.length} tickers`);
  if (results.size < tickers.length) {
    throw new Error(
      `Technical screener returned ${results.size}/${tickers.length} tickers`
    );
  }
  return results;
}

// ---------------------------------------------------------------------------
// 5. Yahoo Finance — current AUM (totalAssets) for daily snapshots
// ---------------------------------------------------------------------------

/** Get a Yahoo Finance crumb + cookies for authenticated API access */
async function getYahooCrumb(): Promise<{ crumb: string; cookie: string }> {
  // Step 1: Hit fc.yahoo.com to get session cookies
  const cookieRes = await fetch("https://fc.yahoo.com", {
    headers: { "User-Agent": USER_AGENT },
    redirect: "manual",
  });
  const setCookies = cookieRes.headers.getSetCookie?.() || [];
  const cookie = setCookies.map(c => c.split(";")[0]).join("; ");

  // Step 2: Get crumb using cookies
  const crumbRes = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", {
    headers: { "User-Agent": USER_AGENT, Cookie: cookie },
  });
  const crumb = await crumbRes.text();
  if (!crumb || crumb.includes("Unauthorized")) {
    throw new Error("Failed to get Yahoo crumb");
  }
  return { crumb, cookie };
}

/** Fetch current totalAssets and price for sector ETFs from Yahoo Finance */
export async function fetchYahooAUM(): Promise<ETFAUMSnapshot[]> {
  console.log("  Fetching AUM from Yahoo Finance...");
  const tickers = Object.keys(ETF_SECTOR_MAP);
  const snapshots: ETFAUMSnapshot[] = [];
  const today = new Date().toISOString().slice(0, 10);

  try {
    const { crumb, cookie } = await getYahooCrumb();

    for (const ticker of tickers) {
      try {
        const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=summaryDetail,price&crumb=${encodeURIComponent(crumb)}`;
        const res = await fetch(url, {
          headers: { "User-Agent": USER_AGENT, Cookie: cookie },
        });
        const json = await res.json() as any;
        const detail = json?.quoteSummary?.result?.[0]?.summaryDetail;
        const priceData = json?.quoteSummary?.result?.[0]?.price;
        const totalAssets = detail?.totalAssets?.raw ?? 0;
        const price = priceData?.regularMarketPrice?.raw ?? detail?.regularMarketPreviousClose?.raw ?? 0;

        if (totalAssets > 0) {
          snapshots.push({
            ticker,
            sector: ETF_SECTOR_MAP[ticker],
            totalAssets,
            price,
            date: today,
          });
          console.log(`    ${ticker}: $${(totalAssets / 1e9).toFixed(2)}B AUM @ $${price.toFixed(2)}`);
        } else {
          console.warn(`    ⚠ ${ticker}: no totalAssets in Yahoo response`);
        }
        await sleep(200); // rate limit
      } catch (err) {
        console.warn(`    ⚠ ${ticker}: Yahoo fetch failed: ${err}`);
      }
    }
  } catch (err) {
    console.warn(`  ⚠ Yahoo crumb auth failed: ${err}`);
  }

  console.log(`  Fetched AUM for ${snapshots.length}/${tickers.length} sector ETFs`);
  return snapshots;
}

/** Historical daily close prices for sector ETFs (past ~35 trading days) */
export interface ChartPriceHistory {
  ticker: string;
  /** date → close price map (ISO date strings) */
  prices: Map<string, number>;
}

/** Fetch ~35 days of daily closing prices from Yahoo Finance chart API */
export async function fetchYahooChart(): Promise<ChartPriceHistory[]> {
  console.log("  Fetching historical prices from Yahoo Finance...");
  const tickers = Object.keys(ETF_SECTOR_MAP);
  const results: ChartPriceHistory[] = [];

  try {
    const { crumb, cookie } = await getYahooCrumb();

    for (const ticker of tickers) {
      try {
        const url = `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?range=6mo&interval=1d&crumb=${encodeURIComponent(crumb)}`;
        const res = await fetch(url, {
          headers: { "User-Agent": USER_AGENT, Cookie: cookie },
        });
        const json = await res.json() as any;
        const result = json?.chart?.result?.[0];
        const timestamps: number[] = result?.timestamp || [];
        const closes: number[] = result?.indicators?.quote?.[0]?.close || [];

        const prices = new Map<string, number>();
        for (let i = 0; i < timestamps.length; i++) {
          if (closes[i] != null) {
            const date = new Date(timestamps[i] * 1000).toISOString().slice(0, 10);
            prices.set(date, closes[i]);
          }
        }

        if (prices.size > 0) {
          results.push({ ticker, prices });
          console.log(`    ${ticker}: ${prices.size} daily prices`);
        }
        await sleep(200);
      } catch (err) {
        console.warn(`    ⚠ ${ticker}: chart fetch failed: ${err}`);
      }
    }
  } catch (err) {
    console.warn(`  ⚠ Yahoo chart crumb auth failed: ${err}`);
  }

  console.log(`  Fetched chart history for ${results.length}/${tickers.length} ETFs`);
  return results;
}

// ---------------------------------------------------------------------------
// 6. SEC EDGAR N-PORT — quarterly net assets for long-term flow computation
// ---------------------------------------------------------------------------

const SEC_USER_AGENT = "finviz-scanner hsarella@tql.com";
const SPDR_CIK = "0001064641"; // SELECT SECTOR SPDR TRUST

// seriesId → ticker mapping (from SEC EDGAR filings)
const SERIES_TO_TICKER: Record<string, string> = {
  S000006415: "XLK",  // Technology
  S000006411: "XLF",  // Financial
  S000006410: "XLE",  // Energy
  S000006412: "XLV",  // Health Care
  S000006408: "XLY",  // Consumer Discretionary
  S000006409: "XLP",  // Consumer Staples
  S000006413: "XLI",  // Industrial
  S000006414: "XLB",  // Materials
  S000062095: "XLC",  // Communication Services
  S000051152: "XLRE", // Real Estate
  S000006416: "XLU",  // Utilities
};

// Sector name mapping for SEC names → our names
const SEC_SECTOR_MAP: Record<string, string> = {
  XLK: "Technology", XLF: "Financial", XLE: "Energy",
  XLV: "Healthcare", XLY: "Consumer Cyclical", XLP: "Consumer Defensive",
  XLI: "Industrials", XLB: "Basic Materials", XLC: "Communication Services",
  XLRE: "Real Estate", XLU: "Utilities",
};

/** Fetch quarterly N-PORT data from SEC EDGAR for all sector ETFs */
export async function fetchNPortData(): Promise<NPortQuarterlyData[]> {
  console.log("  Fetching quarterly data from SEC EDGAR...");
  const results: NPortQuarterlyData[] = [];

  try {
    // Get filing list for Select Sector SPDR Trust
    const subRes = await fetch(`https://data.sec.gov/submissions/CIK${SPDR_CIK}.json`, {
      headers: { "User-Agent": SEC_USER_AGENT },
    });
    const subData = await subRes.json() as any;
    const recent = subData.filings.recent;

    // Find the last 4 NPORT-P filing dates (quarterly)
    const nportDates = [...new Set(
      recent.form
        .map((form: string, i: number) => ({ form, date: recent.filingDate[i], accession: recent.accessionNumber[i] }))
        .filter((x: any) => x.form === "NPORT-P")
        .map((x: any) => x.date)
    )].slice(0, 4) as string[];

    console.log(`    Filing dates: ${nportDates.join(", ")}`);

    // For each filing date, get all accessions
    const allNports = recent.form
      .map((form: string, i: number) => ({
        form,
        date: recent.filingDate[i],
        accession: recent.accessionNumber[i],
      }))
      .filter((x: any) => x.form === "NPORT-P" && nportDates.includes(x.date));

    // Fetch each filing XML to get seriesId + netAssets
    for (const filing of allNports) {
      try {
        const accPath = filing.accession.replace(/-/g, "");
        const xmlUrl = `https://www.sec.gov/Archives/edgar/data/${parseInt(SPDR_CIK)}/` +
          `${accPath}/primary_doc.xml`;
        const xmlRes = await fetch(xmlUrl, {
          headers: { "User-Agent": SEC_USER_AGENT },
        });
        const xml = await xmlRes.text();

        // Extract seriesId
        const sidMatch = xml.match(/<seriesId>([^<]+)/);
        const seriesId = sidMatch?.[1] ?? "";
        const ticker = SERIES_TO_TICKER[seriesId];
        if (!ticker) continue; // Skip "Premium Income" variants etc.

        // Extract netAssets and period
        const naMatch = xml.match(/<netAssets>([^<]+)/);
        const pdMatch = xml.match(/<repPdDate>([^<]+)/);
        const netAssets = parseFloat(naMatch?.[1] ?? "0");
        const periodEnd = pdMatch?.[1] ?? "";

        if (netAssets > 0) {
          results.push({
            seriesId,
            ticker,
            sector: SEC_SECTOR_MAP[ticker] ?? ticker,
            netAssets,
            periodEnd,
            filingDate: filing.date,
          });
        }

        await sleep(150); // SEC rate limit: 10 req/sec
      } catch (err) {
        // Skip individual filing errors
      }
    }
  } catch (err) {
    console.warn(`  ⚠ SEC EDGAR fetch failed: ${err}`);
  }

  // Deduplicate: keep one entry per ticker per periodEnd
  const seen = new Set<string>();
  const deduped = results.filter(r => {
    const key = `${r.ticker}-${r.periodEnd}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const uniquePeriods = [...new Set(deduped.map(r => r.periodEnd))];
  console.log(`  Fetched ${deduped.length} N-PORT records across ${uniquePeriods.length} quarters`);
  return deduped;
}

// ---------------------------------------------------------------------------
// 7. Dark Pool Data — FINRA short volume
// ---------------------------------------------------------------------------

/**
 * Fetches short volume from a pipe-delimited text file.
 * Works for FINRA CNMSshvol, NYSE, and NYSE Arca files (same format).
 * Format: Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market
 */
async function fetchShortVolumeFile(
  url: string,
  source: DarkPoolData["source"],
  tickers: Set<string>,
  isoDate: string
): Promise<DarkPoolData[]> {
  const results: DarkPoolData[] = [];
  try {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) return results;

    const text = await res.text();
    const lines = text.split("\n");

    for (const line of lines) {
      const parts = line.split("|");
      if (parts.length < 5) continue;
      const symbol = parts[1];
      if (!tickers.has(symbol)) continue;

      const shortVolume = parseInt(parts[2]) || 0;
      const shortExempt = parseInt(parts[3]) || 0;
      const totalVolume = parseInt(parts[4]) || 0;
      if (totalVolume === 0) continue;

      const totalShort = shortVolume + shortExempt;
      results.push({
        ticker: symbol,
        sector: ETF_SECTOR_MAP[symbol],
        source,
        shortVolume: totalShort,
        totalVolume,
        shortRatio: totalShort / totalVolume,
        date: isoDate,
      });
    }
  } catch {}
  return results;
}

/**
 * Fetches short volume from Nasdaq BX.
 * Format differs: Symbol|Short Volume|Total Volume|Date
 */
async function fetchNasdaqShortVolume(
  dateStr: string,
  tickers: Set<string>,
  isoDate: string
): Promise<DarkPoolData[]> {
  const results: DarkPoolData[] = [];
  try {
    // Nasdaq publishes to nasdaqtrader.com in slightly different format
    const url = `https://cdn.finra.org/equity/regsho/daily/FNQCshvol${dateStr}.txt`;
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) return results;

    const text = await res.text();
    const lines = text.split("\n");

    for (const line of lines) {
      const parts = line.split("|");
      if (parts.length < 5) continue;
      const symbol = parts[1];
      if (!tickers.has(symbol)) continue;

      const shortVolume = parseInt(parts[2]) || 0;
      const shortExempt = parseInt(parts[3]) || 0;
      const totalVolume = parseInt(parts[4]) || 0;
      if (totalVolume === 0) continue;

      const totalShort = shortVolume + shortExempt;
      results.push({
        ticker: symbol,
        sector: ETF_SECTOR_MAP[symbol],
        source: "NASDAQ",
        shortVolume: totalShort,
        totalVolume,
        shortRatio: totalShort / totalVolume,
        date: isoDate,
      });
    }
  } catch {}
  return results;
}

/** Fetch dark pool data from all 3 sources, cross-validate, and produce aggregates */
export async function fetchDarkPoolData(): Promise<{ raw: DarkPoolData[]; aggregates: DarkPoolAggregate[] }> {
  console.log("  Fetching dark pool data from 3 sources (FINRA + NYSE Arca + Nasdaq)...");
  const tickers = new Set(Object.keys(ETF_SECTOR_MAP));
  const allRaw: DarkPoolData[] = [];

  // Find most recent trading day with data
  const dates: string[] = [];
  const now = new Date();
  for (let i = 0; i < 7 && dates.length < 3; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const day = d.getDay();
    if (day === 0 || day === 6) continue;
    dates.push(d.toISOString().slice(0, 10).replace(/-/g, ""));
  }

  let usedDate = "";
  for (const dateStr of dates) {
    const isoDate = `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;

    // Fetch all 3 sources in parallel
    const [finraData, arcaData, nasdaqData] = await Promise.all([
      fetchShortVolumeFile(
        `https://cdn.finra.org/equity/regsho/daily/CNMSshvol${dateStr}.txt`,
        "FINRA", tickers, isoDate
      ),
      fetchShortVolumeFile(
        `https://ftp.nyse.com/ShortData/ARCAshvol/current/ARCAshvol${dateStr}.txt`,
        "NYSE_ARCA", tickers, isoDate
      ),
      fetchNasdaqShortVolume(dateStr, tickers, isoDate),
    ]);

    if (finraData.length > 0 || arcaData.length > 0) {
      allRaw.push(...finraData, ...arcaData, ...nasdaqData);
      usedDate = isoDate;
      console.log(`    Date ${isoDate}: FINRA=${finraData.length}, Arca=${arcaData.length}, Nasdaq=${nasdaqData.length} ETFs`);
      break;
    }
  }

  if (allRaw.length === 0) {
    console.warn("  ⚠ No dark pool data found from any source");
    return { raw: [], aggregates: [] };
  }

  // Cross-validate: combine sources per ticker into volume-weighted aggregate
  const aggregates: DarkPoolAggregate[] = [];
  for (const ticker of tickers) {
    const tickerData = allRaw.filter(d => d.ticker === ticker);
    if (tickerData.length === 0) continue;

    const finra = tickerData.find(d => d.source === "FINRA");
    const arca = tickerData.find(d => d.source === "NYSE_ARCA");
    const nasdaq = tickerData.find(d => d.source === "NASDAQ");

    const finraRatio = finra?.shortRatio ?? 0;
    const arcaRatio = arca?.shortRatio ?? 0;
    const nasdaqRatio = nasdaq?.shortRatio ?? 0;

    // Volume-weighted combined ratio
    const totalShort = tickerData.reduce((s, d) => s + d.shortVolume, 0);
    const totalVol = tickerData.reduce((s, d) => s + d.totalVolume, 0);
    const combinedShortRatio = totalVol > 0 ? totalShort / totalVol : 0;

    // Validation: check divergence between available sources
    const availableRatios = [finraRatio, arcaRatio, nasdaqRatio].filter(r => r > 0);
    let maxDivergence = 0;
    for (let i = 0; i < availableRatios.length; i++) {
      for (let j = i + 1; j < availableRatios.length; j++) {
        const diff = Math.abs(availableRatios[i] - availableRatios[j]);
        if (diff > maxDivergence) maxDivergence = diff;
      }
    }
    const sourcesAgree = maxDivergence < 0.10; // sources within 10% of each other

    aggregates.push({
      ticker,
      sector: ETF_SECTOR_MAP[ticker],
      date: usedDate,
      finraRatio,
      arcaRatio,
      nasdaqRatio,
      combinedShortRatio,
      combinedShortVolume: totalShort,
      combinedTotalVolume: totalVol,
      sourcesAgree,
      maxDivergence,
    });

    if (!sourcesAgree) {
      console.warn(`    ⚠ ${ticker}: sources diverge by ${(maxDivergence * 100).toFixed(1)}% — FINRA=${(finraRatio * 100).toFixed(0)}% Arca=${(arcaRatio * 100).toFixed(0)}% Nasdaq=${(nasdaqRatio * 100).toFixed(0)}%`);
    }
  }

  console.log(`  Aggregated ${aggregates.length} ETFs, ${aggregates.filter(a => a.sourcesAgree).length} sources agree, ${aggregates.filter(a => !a.sourcesAgree).length} diverge`);
  return { raw: allRaw, aggregates };
}

// ---------------------------------------------------------------------------
// 8. Options Data — Yahoo Finance options chains
// ---------------------------------------------------------------------------

/** Fetch options data (P/C ratio, OI, IV) for sector ETFs from Yahoo Finance */
export async function fetchOptionsData(): Promise<OptionsData[]> {
  console.log("  Fetching options data from Yahoo Finance...");
  const tickers = Object.keys(ETF_SECTOR_MAP);
  const results: OptionsData[] = [];
  const today = new Date().toISOString().slice(0, 10);

  try {
    const { crumb, cookie } = await getYahooCrumb();

    for (const ticker of tickers) {
      try {
        // First get available expirations
        const infoUrl = `https://query2.finance.yahoo.com/v7/finance/options/${ticker}?crumb=${encodeURIComponent(crumb)}`;
        const infoRes = await fetch(infoUrl, {
          headers: { "User-Agent": USER_AGENT, Cookie: cookie },
        });
        const infoJson = await infoRes.json() as any;
        const expirations: number[] = infoJson?.optionChain?.result?.[0]?.expirationDates || [];

        // Pick expiration closest to 30 days out (for representative IV)
        const now = Math.floor(Date.now() / 1000);
        const target30d = now + 30 * 86400;
        let bestExp = expirations[0];
        let bestDiff = Infinity;
        for (const exp of expirations) {
          if (exp <= now) continue; // skip expired
          const diff = Math.abs(exp - target30d);
          if (diff < bestDiff) { bestDiff = diff; bestExp = exp; }
        }

        // Fetch the 30-day chain
        const url = bestExp
          ? `https://query2.finance.yahoo.com/v7/finance/options/${ticker}?crumb=${encodeURIComponent(crumb)}&date=${bestExp}`
          : infoUrl;
        const res = bestExp ? await fetch(url, {
          headers: { "User-Agent": USER_AGENT, Cookie: cookie },
        }) : infoRes;
        const json = bestExp ? await res.json() as any : infoJson;
        const optionChain = json?.optionChain?.result?.[0];
        if (!optionChain) continue;

        const options = optionChain.options?.[0];
        if (!options) continue;

        const puts: any[] = options.puts || [];
        const calls: any[] = options.calls || [];

        // Aggregate volume and OI
        let putVolume = 0, callVolume = 0;
        let putOI = 0, callOI = 0;
        let ivSum = 0, ivCount = 0;

        for (const p of puts) {
          putVolume += p.volume ?? p.volume?.raw ?? 0;
          putOI += p.openInterest ?? p.openInterest?.raw ?? 0;
          const pIV = p.impliedVolatility ?? p.impliedVolatility?.raw;
          if (pIV) { ivSum += pIV; ivCount++; }
        }
        for (const c of calls) {
          callVolume += c.volume ?? c.volume?.raw ?? 0;
          callOI += c.openInterest ?? c.openInterest?.raw ?? 0;
          const cIV = c.impliedVolatility ?? c.impliedVolatility?.raw;
          if (cIV) { ivSum += cIV; ivCount++; }
        }

        // ATM IV: average of puts and calls near the money
        const currentPrice = optionChain.quote?.regularMarketPrice ?? 0;
        let atmIV = ivCount > 0 ? ivSum / ivCount : 0;
        if (currentPrice > 0) {
          // Find options closest to ATM for better IV estimate
          const atmPuts = puts.filter((p: any) => Math.abs((p.strike ?? p.strike?.raw ?? 0) - currentPrice) / currentPrice < 0.03);
          const atmCalls = calls.filter((c: any) => Math.abs((c.strike ?? c.strike?.raw ?? 0) - currentPrice) / currentPrice < 0.03);
          const atmOptions = [...atmPuts, ...atmCalls];
          if (atmOptions.length > 0) {
            const atmIvSum = atmOptions.reduce((s: number, o: any) => s + (o.impliedVolatility ?? o.impliedVolatility?.raw ?? 0), 0);
            atmIV = atmIvSum / atmOptions.length;
          }
        }

        const putCallRatio = callVolume > 0 ? putVolume / callVolume : 0;
        const putCallOIRatio = callOI > 0 ? putOI / callOI : 0;

        results.push({
          ticker,
          sector: ETF_SECTOR_MAP[ticker],
          putVolume,
          callVolume,
          putCallRatio,
          putOpenInterest: putOI,
          callOpenInterest: callOI,
          putCallOIRatio,
          impliedVolatility: atmIV,
          date: today,
        });

        console.log(`    ${ticker}: P/C=${putCallRatio.toFixed(2)} OI_P/C=${putCallOIRatio.toFixed(2)} IV=${(atmIV * 100).toFixed(1)}%`);
        await sleep(200);
      } catch (err) {
        console.warn(`    ⚠ ${ticker}: options fetch failed: ${err}`);
      }
    }
  } catch (err) {
    console.warn(`  ⚠ Yahoo options crumb auth failed: ${err}`);
  }

  console.log(`  Fetched options data for ${results.length}/${tickers.length} sector ETFs`);
  return results;
}

// ---------------------------------------------------------------------------
// 9. Orchestrator — join all data
// ---------------------------------------------------------------------------

export async function fetchAllData(): Promise<{
  stocks: StockData[];
  etfs: SectorETF[];
  assetClassETFs: AssetClassETF[];
  technicals: Map<string, TechnicalData>;
  aumSnapshots: ETFAUMSnapshot[];
  nportData: NPortQuarterlyData[];
  chartHistory: ChartPriceHistory[];
  darkPoolData: DarkPoolData[];
  darkPoolAggregates: DarkPoolAggregate[];
  optionsData: OptionsData[];
}> {
  console.log("Fetching data from finviz...");

  // Keep Finviz requests sequential. Bursting requests from GitHub-hosted runners causes
  // successful-looking but incomplete responses instead of a reliable HTTP 429.
  const perf1W = await fetchMapPerformance("w1");
  console.log("  1W performance: done");
  const perf1M = await fetchMapPerformance("w4");
  console.log("  1M performance: done");
  const perf3M = await fetchMapPerformance("w13");
  console.log("  3M performance: done");
  const sectorMap = await fetchSectorMapping();
  const etfs = await fetchSectorETFs();
  const assetClassETFs = await fetchAssetClassETFs();

  // Fetch technical data for all ETFs (asset class + sector)
  const allETFTickers = [
    ...Object.keys(ASSET_CLASS_ETF_MAP),
    ...Object.keys(ETF_SECTOR_MAP),
  ];
  const technicals = await fetchTechnicalData(allETFTickers);

  // Join: only include stocks that appear in both map perf and screener
  const stocks: StockData[] = [];
  for (const [ticker, info] of sectorMap) {
    const w1 = perf1W.get(ticker);
    const w4 = perf1M.get(ticker);
    const w13 = perf3M.get(ticker);
    if (w1 !== undefined && w4 !== undefined && w13 !== undefined) {
      stocks.push({
        ticker,
        company: info.company,
        sector: info.sector,
        industry: info.industry,
        marketCap: info.marketCap,
        perf1W: w1,
        perf1M: w4,
        perf3M: w13,
      });
    }
  }

  console.log(`  Joined ${stocks.length} stocks with performance data`);
  if (stocks.length <= 400) {
    throw new Error(
      `Only ${stocks.length} stocks matched between the Finviz screener and map performance data`
    );
  }

  // Fetch AUM snapshots from Yahoo Finance + quarterly data from SEC EDGAR + chart history
  const [aumSnapshots, nportData, chartHistory] = await Promise.all([
    fetchYahooAUM(),
    fetchNPortData(),
    fetchYahooChart(),
  ]);

  // Fetch dark pool + options data (can run in parallel)
  const [darkPoolResult, optionsData] = await Promise.all([
    fetchDarkPoolData(),
    fetchOptionsData(),
  ]);
  const { raw: darkPoolData, aggregates: darkPoolAggregates } = darkPoolResult;

  return { stocks, etfs, assetClassETFs, technicals, aumSnapshots, nportData, chartHistory, darkPoolData, darkPoolAggregates, optionsData };
}

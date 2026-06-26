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

async function fetchWithRetry(url: string, retries = 2): Promise<Response> {
  for (let i = 0; i <= retries; i++) {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
    });
    if (res.ok) return res;
    if (res.status === 429 && i < retries) {
      await sleep(2000 * (i + 1));
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
  const res = await fetchWithRetry(url);
  const json = (await res.json()) as { nodes: Record<string, number> };
  return new Map(Object.entries(json.nodes));
}

// ---------------------------------------------------------------------------
// 2. Screener — parse HTML tables for sector mapping + market cap
// ---------------------------------------------------------------------------

/** Parse market cap strings like "3643.71B", "78.83M", "1.2T" into raw dollars */
function parseMarketCap(raw: string): number {
  const cleaned = raw.trim().replace(/,/g, "");
  const match = cleaned.match(/^([\d.]+)\s*([BMTK]?)$/i);
  if (!match) return 0;
  const num = parseFloat(match[1]);
  const suffix = match[2].toUpperCase();
  const multipliers: Record<string, number> = {
    T: 1e12,
    B: 1e9,
    M: 1e6,
    K: 1e3,
    "": 1,
  };
  return num * (multipliers[suffix] ?? 1);
}

/** Parse a percentage string like "-3.80%" → -3.80 */
function parsePct(raw: string): number {
  const cleaned = raw.trim().replace("%", "");
  const val = parseFloat(cleaned);
  return isNaN(val) ? 0 : val;
}

/** Parse a volume string like "18,570,783" or "2.19M" → number */
function parseVolume(raw: string): number {
  const cleaned = raw.trim().replace(/,/g, "");
  const match = cleaned.match(/^([\d.]+)\s*([BMTK]?)$/i);
  if (!match) return parseFloat(cleaned) || 0;
  const num = parseFloat(match[1]);
  const suffix = match[2].toUpperCase();
  const multipliers: Record<string, number> = {
    T: 1e12,
    B: 1e9,
    M: 1e6,
    K: 1e3,
    "": 1,
  };
  return num * (multipliers[suffix] ?? 1);
}

async function fetchScreenerPage(offset: number): Promise<ScreenerStock[]> {
  const url = `${SCREENER_URL}?v=152&f=idx_sp500&r=${offset}`;
  const res = await fetchWithRetry(url);
  const html = await res.text();
  const $ = cheerio.load(html);

  const stocks: ScreenerStock[] = [];

  // The screener table uses class "screener_table" or is inside #screener-content
  // Each data row in the main table has class "styled-row" or is a <tr> inside the table body
  const rows = $("table.screener_table tr, table.table-light tr").toArray();

  for (const row of rows) {
    const cells = $(row).find("td").toArray();
    if (cells.length < 8) continue;

    const cellTexts = cells.map((c) => $(c).text().trim());
    // v=152 columns: #, Ticker, Company, Sector, Industry, Country, Market Cap, P/E, ...
    const ticker = cellTexts[1];
    const company = cellTexts[2];
    const sector = cellTexts[3];
    const industry = cellTexts[4];
    const marketCapStr = cellTexts[6];

    // Skip header rows or rows without valid ticker
    if (!ticker || ticker === "Ticker" || !sector) continue;

    stocks.push({
      ticker,
      company,
      sector,
      industry,
      marketCap: parseMarketCap(marketCapStr),
    });
  }

  return stocks;
}

export async function fetchSectorMapping(): Promise<Map<string, ScreenerStock>> {
  const allStocks = new Map<string, ScreenerStock>();
  const totalPages = 26; // 503 stocks, 20 per page

  // Fetch in batches of 5 with delays
  for (let batch = 0; batch < totalPages; batch += 5) {
    const promises: Promise<ScreenerStock[]>[] = [];
    for (let i = batch; i < Math.min(batch + 5, totalPages); i++) {
      const offset = i * 20 + 1;
      promises.push(fetchScreenerPage(offset));
    }
    const results = await Promise.all(promises);
    for (const stocks of results) {
      for (const stock of stocks) {
        allStocks.set(stock.ticker, stock);
      }
    }
    // Delay between batches to avoid rate limiting
    if (batch + 5 < totalPages) {
      await sleep(300);
    }
  }

  console.log(`  Fetched sector mapping for ${allStocks.size} stocks`);
  return allStocks;
}

// ---------------------------------------------------------------------------
// 3. Sector ETFs — single page fetch
// ---------------------------------------------------------------------------

export async function fetchSectorETFs(): Promise<SectorETF[]> {
  const url = `${SCREENER_URL}?v=140&t=${SECTOR_ETF_TICKERS}`;
  const res = await fetchWithRetry(url);
  const html = await res.text();
  const $ = cheerio.load(html);

  const etfs: SectorETF[] = [];
  const rows = $("table.screener_table tr, table.table-light tr").toArray();

  for (const row of rows) {
    const cells = $(row).find("td").toArray();
    if (cells.length < 16) continue;

    const cellTexts = cells.map((c) => $(c).text().trim());
    // v=140 performance view columns:
    // #, Ticker, Perf Week, Perf Month, Perf Quart, Perf Half, Perf Year, Perf YTD,
    // ... more perf columns ..., Volatility W, Volatility M, Recom, Avg Volume, Rel Volume, Price, Change, Volume
    const ticker = cellTexts[1];

    if (!ticker || !(ticker in ETF_SECTOR_MAP)) continue;

    etfs.push({
      ticker,
      sector: ETF_SECTOR_MAP[ticker],
      perf1W: parsePct(cellTexts[2]),
      perf1M: parsePct(cellTexts[3]),
      perf3M: parsePct(cellTexts[4]),
      avgVolume: parseVolume(cellTexts[12]),
      relVolume: parseFloat(cellTexts[13]) || 1,
      price: parseFloat(cellTexts[14].replace(",", "")) || 0,
    });
  }

  console.log(`  Fetched ${etfs.length} sector ETFs`);
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
  const html = await res.text();
  const $ = cheerio.load(html);

  const etfs: AssetClassETF[] = [];
  const rows = $("table.screener_table tr, table.table-light tr").toArray();

  for (const row of rows) {
    const cells = $(row).find("td").toArray();
    if (cells.length < 16) continue;

    const cellTexts = cells.map((c) => $(c).text().trim());
    const ticker = cellTexts[1];

    if (!ticker || !(ticker in ASSET_CLASS_ETF_MAP)) continue;

    const info = ASSET_CLASS_ETF_MAP[ticker];
    etfs.push({
      ticker,
      assetClass: info.assetClass,
      label: info.label,
      perf1W: parsePct(cellTexts[2]),
      perf1M: parsePct(cellTexts[3]),
      perf3M: parsePct(cellTexts[4]),
      relVolume: parseFloat(cellTexts[13]) || 1,
    });
  }

  console.log(`  Fetched ${etfs.length} asset class ETFs`);
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
    const html = await res.text();
    const $ = cheerio.load(html);

    const rows = $("table.screener_table tr, table.table-light tr").toArray();

    for (const row of rows) {
      const cells = $(row).find("td").toArray();
      if (cells.length < 10) continue;

      const cellTexts = cells.map((c) => $(c).text().trim());
      const ticker = cellTexts[1];

      if (!ticker || !batch.includes(ticker)) continue;

      // v=171 columns (0-indexed):
      // 0: #, 1: Ticker, 2: Beta, 3: ATR, 4: SMA20, 5: SMA50, 6: SMA200,
      // 7: 52W High, 8: 52W Low, 9: RSI, 10: from Open, 11: Gap, ...
      results.set(ticker, {
        ticker,
        sma20: parsePct(cellTexts[4]),
        sma50: parsePct(cellTexts[5]),
        sma200: parsePct(cellTexts[6]),
        from52WHigh: parsePct(cellTexts[7]),
        from52WLow: parsePct(cellTexts[8]),
        rsi: parseFloat(cellTexts[9]) || 50,
      });
    }

    if (i + BATCH_SIZE < tickers.length) {
      await sleep(300);
    }
  }

  console.log(`  Fetched technical data for ${results.size}/${tickers.length} tickers`);
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

  // Fetch map performance (3 timeframes) + sector mapping + ETFs in parallel
  const [perf1W, perf1M, perf3M, sectorMap, etfs, assetClassETFs] = await Promise.all([
    fetchMapPerformance("w1").then((r) => {
      console.log("  1W performance: done");
      return r;
    }),
    fetchMapPerformance("w4").then((r) => {
      console.log("  1M performance: done");
      return r;
    }),
    fetchMapPerformance("w13").then((r) => {
      console.log("  3M performance: done");
      return r;
    }),
    fetchSectorMapping(),
    fetchSectorETFs(),
    fetchAssetClassETFs(),
  ]);

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

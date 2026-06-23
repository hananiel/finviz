import * as cheerio from "cheerio";
import type { Timeframe, ScreenerStock, StockData, SectorETF, AssetClassETF, TechnicalData, ETFFundFlow } from "./types.js";

const BASE_URL = "https://finviz.com";
const MAP_API = `${BASE_URL}/api/map_perf.ashx`;
const SCREENER_URL = `${BASE_URL}/screener.ashx`;
const ETFDB_URL = "https://etfdb.com/etf";

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

/** Fetch with full browser-like headers (needed for ETFdb anti-bot) */
async function fetchBrowser(url: string, retries = 2): Promise<Response> {
  for (let i = 0; i <= retries; i++) {
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Accept-Encoding": "gzip, deflate, br",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
      },
    });
    if (res.ok) return res;
    if ((res.status === 429 || res.status === 403) && i < retries) {
      await sleep(3000 * (i + 1));
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
// 5. ETFdb Fund Flows — real creation/redemption dollar flows
// ---------------------------------------------------------------------------

/** Parse a fund flow value like "8.33 B", "-10.1 M", "317.86 M" → raw dollars */
function parseFlowValue(raw: string): number {
  const cleaned = raw.trim();
  if (!cleaned) return 0;
  const match = cleaned.match(/^(-?[\d.]+)\s*([BMK]?)$/i);
  if (!match) return 0;
  const num = parseFloat(match[1]);
  const suffix = match[2].toUpperCase();
  const multipliers: Record<string, number> = { B: 1e9, M: 1e6, K: 1e3, "": 1 };
  return num * (multipliers[suffix] ?? 1);
}

async function fetchETFFlowPage(ticker: string): Promise<Omit<ETFFundFlow, "sector"> | null> {
  try {
    const url = `${ETFDB_URL}/${ticker}/`;

    // ETFdb has aggressive bot protection that blocks Node fetch even with browser headers.
    // Use child_process curl which works reliably (proven via manual testing).
    const { execSync } = await import("node:child_process");
    const html = execSync(
      `curl -s "${url}" -H "User-Agent: ${USER_AGENT}" -H "Accept: text/html" --max-time 15`,
      { encoding: "utf-8", maxBuffer: 5 * 1024 * 1024 }
    );

    if (!html || html.length < 1000) {
      throw new Error(`Empty or blocked response for ${ticker}`);
    }

    // Parse net flow spans: <span class='net-fund-flow 5-day'>\n<b>label</b>\nvalue\n</span>
    // Use [\s\S] for cross-platform newline handling (Windows \r\n vs Unix \n)
    const flowRegex = /net-fund-flow\s+([\w-]+)'>\s*<b>[^<]*<\/b>\s*([-\d.]+\s*[BMTK]?)/gi;
    const flows: Record<string, number> = {};

    let m;
    while ((m = flowRegex.exec(html)) !== null) {
      const period = m[1].trim();  // "5-day", "1-month", "3-month", etc.
      const value = m[2].trim();
      flows[period] = parseFlowValue(value);
    }

    return {
      ticker,
      flow5Day: flows["5-day"] ?? 0,
      flow1Month: flows["1-month"] ?? 0,
      flow3Month: flows["3-month"] ?? 0,
      flow6Month: flows["6-month"] ?? 0,
      flow1Year: flows["1-year"] ?? 0,
    };
  } catch (err) {
    console.error(`  Warning: failed to fetch fund flow for ${ticker}: ${err}`);
    return null;
  }
}

export async function fetchFundFlows(): Promise<ETFFundFlow[]> {
  console.log("  Fetching real fund flows from ETFdb...");
  const tickers = Object.keys(ETF_SECTOR_MAP);
  const flows: ETFFundFlow[] = [];

  // Fetch in batches of 2 with delays to avoid rate limiting
  for (let i = 0; i < tickers.length; i += 2) {
    const batch = tickers.slice(i, i + 2);
    const results = await Promise.all(batch.map(fetchETFFlowPage));
    for (const result of results) {
      if (result) {
        flows.push({ ...result, sector: ETF_SECTOR_MAP[result.ticker] });
      }
    }
    if (i + 2 < tickers.length) {
      await sleep(1000);
    }
  }

  console.log(`  Fetched fund flows for ${flows.length}/${tickers.length} sector ETFs`);
  return flows;
}

// ---------------------------------------------------------------------------
// 6. Orchestrator — join all data
// ---------------------------------------------------------------------------

export async function fetchAllData(): Promise<{
  stocks: StockData[];
  etfs: SectorETF[];
  assetClassETFs: AssetClassETF[];
  technicals: Map<string, TechnicalData>;
  fundFlows: ETFFundFlow[];
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

  // Fetch real fund flows from ETFdb (separate from finviz)
  const fundFlows = await fetchFundFlows();

  return { stocks, etfs, assetClassETFs, technicals, fundFlows };
}

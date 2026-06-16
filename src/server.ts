// Allow self-signed certs (corporate proxy/firewall)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

import http from "node:http";
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
} from "./analyzer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "3000", 10);

let cachedData: object | null = null;
let cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getData() {
  if (cachedData && Date.now() - cacheTime < CACHE_TTL) {
    return cachedData;
  }

  const { stocks, etfs, assetClassETFs, technicals } = await fetchAllData();

  const sectorPerfs = aggregateBySector(stocks);
  const signals = calculateRotationSignals(sectorPerfs);
  const etfValidations = validateWithETFs(sectorPerfs, etfs);
  const assetClassFlows = calculateAssetClassFlows(assetClassETFs, technicals);
  const { sectorTrends, assetClassTrends } = buildETFTrendDetails(
    etfs, assetClassETFs, technicals
  );

  const flowMap = new Map(assetClassFlows.map((f) => [f.assetClass, f]));
  const sectorRecs = generateActionSignals(sectorTrends, flowMap, signals);
  const assetClassRecs = generateActionSignals(assetClassTrends, flowMap);

  const result = {
    timestamp: new Date().toISOString(),
    stockCount: stocks.length,
    sectorPerformance: sectorPerfs,
    rotationSignals: signals,
    etfValidation: etfValidations,
    assetClassFlows,
    sectorTrends,
    assetClassTrends,
    actionSignals: { sector: sectorRecs, assetClass: assetClassRecs },
  };

  cachedData = result;
  cacheTime = Date.now();
  return result;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);

  if (url.pathname === "/api/data") {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    try {
      const data = await getData();
      res.writeHead(200);
      res.end(JSON.stringify(data));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  // Serve static HTML
  if (url.pathname === "/" || url.pathname === "/index.html") {
    const htmlPath = path.join(__dirname, "..", "public", "index.html");
    try {
      const html = fs.readFileSync(htmlPath, "utf-8");
      res.setHeader("Content-Type", "text/html");
      res.writeHead(200);
      res.end(html);
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`API endpoint: http://localhost:${PORT}/api/data`);
});

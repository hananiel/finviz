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
} from "./analyzer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function build() {
  console.log("Building static data...");

  const { stocks, etfs, assetClassETFs, technicals } = await fetchAllData();

  if (stocks.length === 0) {
    console.error("No stock data fetched.");
    process.exit(1);
  }

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

  // Write to docs/ for GitHub Pages
  const docsDir = path.join(__dirname, "..", "docs");
  fs.mkdirSync(docsDir, { recursive: true });

  // Copy HTML
  const htmlSrc = path.join(__dirname, "..", "public", "index.html");
  const htmlDst = path.join(docsDir, "index.html");
  fs.copyFileSync(htmlSrc, htmlDst);

  // Write JSON data
  const jsonDst = path.join(docsDir, "data.json");
  fs.writeFileSync(jsonDst, JSON.stringify(result, null, 2));

  console.log(`\nBuild complete:`);
  console.log(`  docs/index.html`);
  console.log(`  docs/data.json (${stocks.length} stocks, ${new Date().toISOString()})`);
}

build().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});

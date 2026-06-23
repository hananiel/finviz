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
import type { CapitalMode, Strategy } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function build() {
  console.log("Building static data...");

  const { stocks, etfs, assetClassETFs, technicals, fundFlows } = await fetchAllData();

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

  // Generate signals for all 6 mode combinations
  const capitalModes: CapitalMode[] = ["deploy", "rotate"];
  const strategies: Strategy[] = ["momentum", "contrarian", "rotation"];
  const actionSignals: Record<string, { sector: ReturnType<typeof generateActionSignals>; assetClass: ReturnType<typeof generateActionSignals> }> = {};

  for (const capital of capitalModes) {
    for (const strategy of strategies) {
      const mode = { capital, strategy };
      const key = `${capital}_${strategy}`;
      actionSignals[key] = {
        sector: generateActionSignals(sectorTrends, flowMap, signals, mode),
        assetClass: generateActionSignals(assetClassTrends, flowMap, undefined, mode),
      };
    }
  }

  const result = {
    timestamp: new Date().toISOString(),
    stockCount: stocks.length,
    sectorPerformance: sectorPerfs,
    rotationSignals: signals,
    etfValidation: etfValidations,
    assetClassFlows,
    fundFlows,
    sectorTrends,
    assetClassTrends,
    actionSignals,
  };

  // Write to docs/ for GitHub Pages (HTML files live directly in docs/)
  const docsDir = path.join(__dirname, "..", "docs");
  fs.mkdirSync(docsDir, { recursive: true });

  // Write JSON data only — HTML files are edited directly in docs/
  const jsonDst = path.join(docsDir, "data.json");
  fs.writeFileSync(jsonDst, JSON.stringify(result, null, 2));

  // Write data.js for file:// protocol support (no fetch needed)
  const jsDst = path.join(docsDir, "data.js");
  fs.writeFileSync(jsDst, `window.__FINVIZ_DATA = ${JSON.stringify(result)};`);

  console.log(`\nBuild complete:`);
  console.log(`  docs/index.html`);
  console.log(`  docs/data.json (${stocks.length} stocks, ${new Date().toISOString()})`);
  console.log(`  docs/data.js (file:// fallback)`);
}

build().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});

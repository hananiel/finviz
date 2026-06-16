// Allow self-signed certs (corporate proxy/firewall)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

import { fetchAllData } from "./scraper.js";
import {
  aggregateBySector,
  calculateRotationSignals,
  validateWithETFs,
  calculateAssetClassFlows,
  buildETFTrendDetails,
  generateActionSignals,
} from "./analyzer.js";
import {
  renderPerformanceTable,
  renderRotationTable,
  renderETFTable,
  renderSummary,
  renderAssetClassTable,
  renderFlowFunnel,
  renderTrendBreakdown,
  renderActionSignals,
} from "./display.js";

async function main() {
  const jsonMode = process.argv.includes("--json");

  try {
    // 1. Fetch all data
    const { stocks, etfs, assetClassETFs, technicals } = await fetchAllData();

    if (stocks.length === 0) {
      console.error("No stock data fetched. Check network / finviz availability.");
      process.exit(1);
    }

    // 2. Analyze
    const sectorPerfs = aggregateBySector(stocks);
    const signals = calculateRotationSignals(sectorPerfs);
    const etfValidations = validateWithETFs(sectorPerfs, etfs);
    const assetClassFlows = calculateAssetClassFlows(assetClassETFs, technicals);
    const { sectorTrends, assetClassTrends } = buildETFTrendDetails(
      etfs, assetClassETFs, technicals
    );

    // Build flow lookup for action signal generation
    const flowMap = new Map(assetClassFlows.map((f) => [f.assetClass, f]));
    const sectorRecs = generateActionSignals(sectorTrends, flowMap, signals);
    const assetClassRecs = generateActionSignals(assetClassTrends, flowMap);

    // 3. Output
    if (jsonMode) {
      const output = {
        timestamp: new Date().toISOString(),
        stockCount: stocks.length,
        sectorPerformance: sectorPerfs,
        rotationSignals: signals,
        etfValidation: etfValidations,
        assetClassFlows,
      };
      console.log(JSON.stringify(output, null, 2));
    } else {
      renderPerformanceTable(sectorPerfs, signals);
      renderRotationTable(signals, sectorPerfs);
      renderETFTable(etfValidations);
      renderAssetClassTable(assetClassFlows);
      renderFlowFunnel(assetClassFlows);
      renderTrendBreakdown(sectorTrends, assetClassTrends);
      renderActionSignals(sectorRecs, assetClassRecs);
      renderSummary(signals, etfValidations);
    }
  } catch (err) {
    console.error("Error:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main();

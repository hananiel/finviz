/**
 * Post-build verification: validates the dashboard renders without errors.
 * Run after `npm run build` to catch broken renders before pushing.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const docsDir = path.join(__dirname, "..", "docs");

let errors = 0;

function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}${detail ? ': ' + detail : ''}`);
    errors++;
  }
}

console.log("Verifying build output...\n");

// 1. Check files exist
const requiredFiles = ["index.html", "data.json", "data.js"];
for (const f of requiredFiles) {
  check(`${f} exists`, fs.existsSync(path.join(docsDir, f)));
}

// 2. Load and validate data.json
const dataPath = path.join(docsDir, "data.json");
let data: any;
try {
  data = JSON.parse(fs.readFileSync(dataPath, "utf8"));
  check("data.json parses as valid JSON", true);
} catch (e: any) {
  check("data.json parses as valid JSON", false, e.message);
  process.exit(1);
}

// 3. Check required data fields
const requiredFields = [
  "timestamp", "stockCount", "sectorPerformance", "rotationSignals",
  "diagnostics", "fundFlows", "aumSnapshots", "actionSignals",
  "sectorTrends", "assetClassTrends", "darkPoolData", "optionsData",
];
for (const field of requiredFields) {
  check(`data.${field} present`, field in data);
}

// 4. Check data integrity
check("stockCount > 400", data.stockCount > 400, `got ${data.stockCount}`);
check("11 rotation signals", data.rotationSignals?.length === 11, `got ${data.rotationSignals?.length}`);
check("11 diagnostics", data.diagnostics?.length === 11, `got ${data.diagnostics?.length}`);
check("11 fund flows", data.fundFlows?.length === 11, `got ${data.fundFlows?.length}`);
check("fund flows have totalAssets", data.fundFlows?.every((f: any) => f.totalAssets > 0), "some have 0");
check("fund flows have sharesOutstanding", data.fundFlows?.every((f: any) => f.sharesOutstanding > 0), "some have 0");
check("diagnostics have evidence", data.diagnostics?.every((d: any) => Array.isArray(d.evidence)), "missing evidence array");
check("diagnostics have phase", data.diagnostics?.every((d: any) => d.phase), "missing phase");
check("diagnostics have darkPoolSignal", data.diagnostics?.every((d: any) => d.darkPoolSignal), "missing darkPoolSignal");
check("diagnostics have optionsSignal", data.diagnostics?.every((d: any) => d.optionsSignal), "missing optionsSignal");
check("darkPoolData is array", Array.isArray(data.darkPoolData));
check("optionsData is array", Array.isArray(data.optionsData));

// 5. Validate HTML script renders without errors
const htmlPath = path.join(docsDir, "index.html");
const html = fs.readFileSync(htmlPath, "utf8");
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
check("index.html has <script> block", !!scriptMatch);

if (scriptMatch) {
  try {
    // Parse the script (syntax check)
    new Function("window", "document", "fetch", "location", scriptMatch[1]);
    check("Script parses without syntax errors", true);
  } catch (e: any) {
    check("Script parses without syntax errors", false, e.message);
  }

  try {
    // Simulate render
    const mockEl = { innerHTML: "", style: {}, classList: { add() {}, remove() {} } };
    const mockDoc = { getElementById: () => mockEl, querySelector: () => mockEl, querySelectorAll: () => [] };
    const mockWin = { __FINVIZ_DATA: data, addEventListener: () => {} };

    const fn = new Function(
      "window", "document", "fetch", "location",
      scriptMatch[1] + "; renderDashboard(); return 'OK';"
    );
    const result = fn(mockWin, mockDoc, () => {}, { protocol: "file:" });
    check("renderDashboard() executes without error", result === "OK");
  } catch (e: any) {
    check("renderDashboard() executes without error", false, e.message);
  }
}

// 6. Check data.js (file:// fallback)
const dataJsPath = path.join(docsDir, "data.js");
try {
  const dataJsContent = fs.readFileSync(dataJsPath, "utf8");
  const mockWindow: any = {};
  new Function("window", dataJsContent)(mockWindow);
  check("data.js executes and sets window.__FINVIZ_DATA", !!mockWindow.__FINVIZ_DATA);
  check("data.js has same keys as data.json",
    JSON.stringify(Object.keys(mockWindow.__FINVIZ_DATA).sort()) === JSON.stringify(Object.keys(data).sort())
  );
} catch (e: any) {
  check("data.js loads correctly", false, e.message);
}

console.log(`\n${errors === 0 ? '✅ All checks passed' : `❌ ${errors} check(s) failed`}`);
process.exit(errors === 0 ? 0 : 1);

import fs from "node:fs";
import path from "node:path";
import {
  EXPORTS_DIR,
  INVENTORY_JSON,
  LOGS_DIR,
  ensureDir,
  exportZipName,
  parseArgs,
  writeCsv
} from "./common.mjs";

const args = parseArgs(process.argv);
const inventoryPath = path.resolve(args.inventory || INVENTORY_JSON);
const exportsDir = path.resolve(args.exportsDir || EXPORTS_DIR);
const logsDir = path.resolve(args.logsDir || LOGS_DIR);

ensureDir(logsDir);

if (!fs.existsSync(inventoryPath)) {
  console.error(`Missing inventory file: ${inventoryPath}`);
  process.exit(1);
}

const inventory = JSON.parse(fs.readFileSync(inventoryPath, "utf8"));
const sites = Array.isArray(inventory) ? inventory : inventory.sites;
if (!Array.isArray(sites)) throw new Error("Inventory must be an array or contain a sites array.");

function existingZip(filePath) {
  if (!fs.existsSync(filePath)) return { exists: false, bytes: 0 };
  const stat = fs.statSync(filePath);
  return { exists: stat.isFile() && stat.size > 1024, bytes: stat.size };
}

function readFailedSiteIds() {
  const failedPath = path.join(logsDir, "export-failed.csv");
  if (!fs.existsSync(failedPath)) return new Set();
  const lines = fs.readFileSync(failedPath, "utf8").trim().split(/\r?\n/).slice(1);
  return new Set(lines.map((line) => line.split(",")[1]).filter(Boolean));
}

function readSkippedSiteIds() {
  const skippedPath = path.join(logsDir, "export-skipped.csv");
  if (!fs.existsSync(skippedPath)) return new Set();
  const lines = fs.readFileSync(skippedPath, "utf8").trim().split(/\r?\n/).slice(1);
  return new Set(lines.map((line) => line.split(",")[1]).filter(Boolean));
}

const failedSiteIds = readFailedSiteIds();
const skippedSiteIds = readSkippedSiteIds();
const rows = sites.map((rawSite, index) => {
  const site = { ...rawSite, id: rawSite.id || rawSite.siteId, siteId: rawSite.siteId || rawSite.id };
  const outputPath = path.join(exportsDir, exportZipName(site));
  const zip = existingZip(outputPath);
  const status = zip.exists
    ? "completed"
    : skippedSiteIds.has(site.siteId)
      ? "skipped"
      : failedSiteIds.has(site.siteId)
        ? "failed"
        : "remaining";
  return {
    index: index + 1,
    status,
    siteId: site.siteId,
    displayName: site.displayName || "",
    shortName: site.shortName || "",
    lastUpdated: site.lastUpdated || "",
    lastPublished: site.lastPublished || "",
    outputPath,
    bytes: zip.bytes
  };
});

const summary = rows.reduce(
  (acc, row) => {
    acc[row.status] += 1;
    acc.total += 1;
    return acc;
  },
  { total: 0, completed: 0, skipped: 0, failed: 0, remaining: 0 }
);

const statusJsonPath = path.join(logsDir, "export-status.json");
const statusCsvPath = path.join(logsDir, "export-status.csv");
fs.writeFileSync(statusJsonPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), summary, sites: rows }, null, 2)}\n`, "utf8");
writeCsv(statusCsvPath, rows, [
  "index",
  "status",
  "siteId",
  "displayName",
  "shortName",
  "lastUpdated",
  "lastPublished",
  "outputPath",
  "bytes"
]);

console.log(summary);
console.log(`Wrote ${statusJsonPath}`);
console.log(`Wrote ${statusCsvPath}`);

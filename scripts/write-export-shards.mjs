import fs from "node:fs";
import path from "node:path";
import {
  EXPORTS_DIR,
  INVENTORY_JSON,
  LOGS_DIR,
  ensureDir,
  exportZipName,
  parseArgs
} from "./common.mjs";

const args = parseArgs(process.argv);
const workers = Number(args.workers || 3);
const inventoryPath = path.resolve(args.inventory || INVENTORY_JSON);
const exportsDir = path.resolve(args.exportsDir || EXPORTS_DIR);
const logsDir = path.resolve(args.logsDir || LOGS_DIR);
const shardsDir = path.join(logsDir, "shards");

ensureDir(shardsDir);

const inventory = JSON.parse(fs.readFileSync(inventoryPath, "utf8"));
const sites = Array.isArray(inventory) ? inventory : inventory.sites;
if (!Array.isArray(sites)) throw new Error("Inventory must be an array or contain a sites array.");

function readSiteIds(csvPath) {
  if (!fs.existsSync(csvPath)) return new Set();
  const lines = fs.readFileSync(csvPath, "utf8").trim().split(/\r?\n/).slice(1);
  return new Set(lines.map((line) => line.split(",")[1]).filter(Boolean));
}

function existingZipIsComplete(filePath) {
  if (!fs.existsSync(filePath)) return false;
  const stat = fs.statSync(filePath);
  return stat.isFile() && stat.size > 1024;
}

const skipped = readSiteIds(path.join(logsDir, "export-skipped.csv"));
const failed = readSiteIds(path.join(logsDir, "export-failed.csv"));
const remaining = sites
  .map((rawSite, index) => ({ ...rawSite, id: rawSite.id || rawSite.siteId, siteId: rawSite.siteId || rawSite.id, index: index + 1 }))
  .filter((site) => site.siteId && site.shortName)
  .filter((site) => !skipped.has(site.siteId))
  .filter((site) => !failed.has(site.siteId))
  .filter((site) => !existingZipIsComplete(path.join(exportsDir, exportZipName(site))));

const shards = Array.from({ length: workers }, () => []);
remaining.forEach((site, index) => {
  shards[index % workers].push(site);
});

for (let i = 0; i < workers; i += 1) {
  const worker = i + 1;
  const rows = shards[i];
  fs.writeFileSync(path.join(shardsDir, `worker-${worker}.siteids.txt`), `${rows.map((site) => site.siteId).join("\n")}\n`, "utf8");
  fs.writeFileSync(path.join(shardsDir, `worker-${worker}.json`), `${JSON.stringify(rows, null, 2)}\n`, "utf8");
}

console.log({
  workers,
  remaining: remaining.length,
  shardCounts: shards.map((rows) => rows.length),
  shardsDir
});

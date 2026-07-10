import fs from "node:fs";
import path from "node:path";
import {
  EXPORTS_DIR,
  INVENTORY_JSON,
  LOGS_DIR,
  ensureDir,
  exportZipName,
  writeCsv
} from "./common.mjs";

const logsDir = LOGS_DIR;
const exportsDir = EXPORTS_DIR;
ensureDir(logsDir);

function parseCsvLine(line) {
  const cells = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted && char === '"' && line[i + 1] === '"') {
      cell += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (!quoted && char === ",") {
      cells.push(cell);
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  return cells;
}

function readCsv(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] || ""]));
  });
}

function existingZipIsComplete(filePath) {
  if (!fs.existsSync(filePath)) return false;
  const stat = fs.statSync(filePath);
  return stat.isFile() && stat.size > 1024;
}

const inventory = JSON.parse(fs.readFileSync(INVENTORY_JSON, "utf8"));
const sites = Array.isArray(inventory) ? inventory : inventory.sites;
const sitesById = new Map(
  sites.map((rawSite, index) => {
    const site = { ...rawSite, id: rawSite.id || rawSite.siteId, siteId: rawSite.siteId || rawSite.id, index: index + 1 };
    return [site.siteId, site];
  })
);

const latestBySite = new Map();
for (const row of readCsv(path.join(logsDir, "export-skipped.csv"))) {
  latestBySite.set(row.siteId, {
    siteId: row.siteId,
    status: "skipped",
    recordedAt: row.skippedAt,
    reason: row.reason
  });
}
for (const row of readCsv(path.join(logsDir, "export-failed.csv"))) {
  latestBySite.set(row.siteId, {
    siteId: row.siteId,
    status: "failed",
    recordedAt: row.failedAt,
    reason: row.error
  });
}

const rows = [];
for (const record of latestBySite.values()) {
  const site = sitesById.get(record.siteId);
  if (!site) continue;
  const outputPath = path.join(exportsDir, exportZipName(site));
  if (existingZipIsComplete(outputPath)) continue;
  rows.push({
    index: site.index,
    status: record.status,
    siteId: site.siteId,
    displayName: site.displayName || "",
    shortName: site.shortName || "",
    lastUpdated: site.lastUpdated || "",
    lastPublished: site.lastPublished || "",
    reason: record.reason || "",
    recordedAt: record.recordedAt || "",
    outputPath
  });
}

rows.sort((a, b) => a.index - b.index);

const csvPath = path.join(logsDir, "export-retry-candidates.csv");
const jsonPath = path.join(logsDir, "export-retry-candidates.json");
writeCsv(csvPath, rows, [
  "index",
  "status",
  "siteId",
  "displayName",
  "shortName",
  "lastUpdated",
  "lastPublished",
  "reason",
  "recordedAt",
  "outputPath"
]);
fs.writeFileSync(jsonPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), count: rows.length, sites: rows }, null, 2)}\n`, "utf8");

console.log({ retryCandidates: rows.length, csvPath, jsonPath });

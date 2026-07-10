import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  EXPORTS_DIR,
  INVENTORY_JSON,
  LOGS_DIR,
  csvEscape,
  ensureDir,
  exportZipName,
  parseArgs,
  safeFileSegment,
  writeCsv
} from "./common.mjs";

const args = parseArgs(process.argv);
const exportsDir = path.resolve(args.exportsDir || EXPORTS_DIR);
const logsDir = path.resolve(args.logsDir || LOGS_DIR);
const organizedDir = path.resolve(args.organizedDir || path.join(path.dirname(exportsDir), "exports-organized"));
const apply = Boolean(args.apply);
const mode = String(args.mode || "hardlink");
const fetchLive = args.fetchLive !== "false";

if (!["hardlink", "copy", "move"].includes(mode)) {
  throw new Error("--mode must be hardlink, copy, or move.");
}

ensureDir(logsDir);

function loadDotenvToken() {
  if (!fs.existsSync(".env")) return "";
  const lines = fs.readFileSync(".env", "utf8").split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*(WEBFLOW_API_TOKEN|WEBFLOW_TOKEN)\s*=\s*(.+?)\s*$/);
    if (match) return match[2].replace(/^["']|["']$/g, "");
  }
  return "";
}

function loadWebflowCliToken() {
  const authPath = path.join(os.homedir(), ".config", "webflow", "auth.json");
  if (!fs.existsSync(authPath)) return "";
  try {
    const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
    return auth.accessToken || "";
  } catch {
    return "";
  }
}

async function loadSites() {
  const token = args.token || process.env.WEBFLOW_API_TOKEN || process.env.WEBFLOW_TOKEN || loadDotenvToken() || loadWebflowCliToken();
  if (fetchLive && token) {
    const response = await fetch("https://api.webflow.com/v2/sites", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json"
      }
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`${response.status} ${response.statusText} from /v2/sites: ${body.slice(0, 500)}`);
    }
    const payload = await response.json();
    if (Array.isArray(payload.sites)) return payload.sites;
  }

  const inventory = JSON.parse(fs.readFileSync(INVENTORY_JSON, "utf8"));
  return Array.isArray(inventory) ? inventory : inventory.sites;
}

function inferType(site) {
  const text = `${site.displayName || ""} ${site.shortName || ""}`.toLowerCase();
  if (/\bcomponent(s)?\b/.test(text)) return "Components";
  if (/\btemplate(s)?\b/.test(text)) return "Templates";
  if (/\bhero section\b|\bhero\b/.test(text)) return "Hero Sections";
  if (/\bform\b|\bsign in\b|\bsign up\b|\bonboarding\b|\binput\b/.test(text)) return "Forms and Inputs";
  if (/\bportfolio\b|\bresume\b|\bcv\b/.test(text)) return "Portfolios";
  if (/\bclient\b|\bcopy of\b/.test(text)) return "Client or Copied Sites";
  return "Uncategorized";
}

function loadFolderNameOverrides() {
  const overridesPath = path.join(logsDir, "webflow-folder-names.json");
  if (!fs.existsSync(overridesPath)) return {};
  return JSON.parse(fs.readFileSync(overridesPath, "utf8"));
}

function folderLabel(folderId, overrides) {
  if (!folderId) return "Root";
  return overrides[folderId] || `Webflow Folder ${folderId}`;
}

function relativeTarget(...segments) {
  return path.join(...segments.map((segment) => safeFileSegment(segment, "unknown")));
}

function placeFile(source, target) {
  ensureDir(path.dirname(target));
  if (fs.existsSync(target)) return "exists";
  if (mode === "copy") {
    fs.copyFileSync(source, target);
    return "copied";
  }
  if (mode === "move") {
    fs.renameSync(source, target);
    return "moved";
  }
  fs.linkSync(source, target);
  return "linked";
}

const sites = await loadSites();
const overrides = loadFolderNameOverrides();
const rows = [];
const folderGroups = new Map();

for (let index = 0; index < sites.length; index += 1) {
  const rawSite = sites[index];
  const site = {
    ...rawSite,
    id: rawSite.id || rawSite.siteId,
    siteId: rawSite.siteId || rawSite.id
  };
  const fileName = exportZipName(site);
  const sourcePath = path.join(exportsDir, fileName);
  if (!fs.existsSync(sourcePath)) continue;
  const stat = fs.statSync(sourcePath);
  if (!stat.isFile() || stat.size <= 1024) continue;

  const parentFolderId = site.parentFolderId || "";
  const label = folderLabel(parentFolderId, overrides);
  const type = inferType(site);
  const byFolderRelative = relativeTarget("by-webflow-folder", label, fileName);
  const byTypeRelative = relativeTarget("by-inferred-type", type, fileName);
  const row = {
    index: index + 1,
    siteId: site.siteId,
    displayName: site.displayName || "",
    shortName: site.shortName || "",
    workspaceId: site.workspaceId || "",
    parentFolderId,
    webflowFolderLabel: label,
    inferredType: type,
    sourcePath,
    bytes: stat.size,
    byWebflowFolderPath: path.join(organizedDir, byFolderRelative),
    byInferredTypePath: path.join(organizedDir, byTypeRelative)
  };
  rows.push(row);

  const groupKey = parentFolderId || "_root";
  if (!folderGroups.has(groupKey)) {
    folderGroups.set(groupKey, {
      parentFolderId,
      webflowFolderLabel: label,
      count: 0,
      samples: []
    });
  }
  const group = folderGroups.get(groupKey);
  group.count += 1;
  if (group.samples.length < 10) group.samples.push(site.displayName || site.shortName || site.siteId);
}

let applied = [];
if (apply) {
  ensureDir(organizedDir);
  for (const row of rows) {
    const byFolderAction = placeFile(row.sourcePath, row.byWebflowFolderPath);
    const byTypeAction = mode === "move" ? "skipped-for-move-mode" : placeFile(row.sourcePath, row.byInferredTypePath);
    applied.push({ siteId: row.siteId, byFolderAction, byTypeAction });
  }
}

const folderRows = [...folderGroups.values()].sort((a, b) => b.count - a.count || a.webflowFolderLabel.localeCompare(b.webflowFolderLabel));
const planCsvPath = path.join(logsDir, "export-organization-plan.csv");
const planJsonPath = path.join(logsDir, "export-organization-plan.json");
const foldersCsvPath = path.join(logsDir, "webflow-folder-groups.csv");
const foldersJsonPath = path.join(logsDir, "webflow-folder-groups.json");

writeCsv(planCsvPath, rows, [
  "index",
  "siteId",
  "displayName",
  "shortName",
  "workspaceId",
  "parentFolderId",
  "webflowFolderLabel",
  "inferredType",
  "sourcePath",
  "bytes",
  "byWebflowFolderPath",
  "byInferredTypePath"
]);
fs.writeFileSync(planJsonPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), apply, mode, organizedDir, count: rows.length, applied, sites: rows }, null, 2)}\n`, "utf8");

writeCsv(foldersCsvPath, folderRows.map((row) => ({ ...row, samples: row.samples.join("; ") })), [
  "parentFolderId",
  "webflowFolderLabel",
  "count",
  "samples"
]);
fs.writeFileSync(foldersJsonPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), count: folderRows.length, folders: folderRows }, null, 2)}\n`, "utf8");

console.log({
  apply,
  mode,
  organizedDir,
  exportedZipsPlanned: rows.length,
  webflowFolderGroups: folderRows.length,
  planCsvPath,
  foldersCsvPath
});

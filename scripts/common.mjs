import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const EXPORTS_DIR = path.join(ROOT, "exports");
export const LOGS_DIR = path.join(ROOT, "logs");
export const PROFILE_DIR = path.join(ROOT, ".webflow-browser-profile");
export const INVENTORY_JSON = path.join(ROOT, "webflow-sites-inventory.json");
export const INVENTORY_CSV = path.join(ROOT, "webflow-sites-inventory.csv");

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const text = Array.isArray(value) ? value.join("; ") : String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

export function writeCsv(filePath, rows, headers) {
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((header) => csvEscape(row[header])).join(","));
  }
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

export function appendCsv(filePath, row, headers) {
  const exists = fs.existsSync(filePath);
  const line = headers.map((header) => csvEscape(row[header])).join(",");
  fs.appendFileSync(filePath, `${exists ? "" : `${headers.join(",")}\n`}${line}\n`, "utf8");
}

export function safeFileSegment(value, fallback = "untitled") {
  const text = String(value || fallback)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[/:\\\0-\x1f\x7f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+$/, fallback)
    .slice(0, 140);
  return text || fallback;
}

export function exportZipName(site) {
  const safeDisplayName = safeFileSegment(site.displayName || site.shortName || site.id, "untitled");
  const shortName = safeFileSegment(site.shortName || "no-short-name", "no-short-name");
  const siteId = safeFileSegment(site.id || site.siteId, "no-site-id");
  return `${safeDisplayName}**${shortName}**${siteId}.zip`;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const key = rawKey.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    if (inlineValue !== undefined) {
      args[key] = inlineValue;
    } else if (argv[i + 1] && !argv[i + 1].startsWith("--")) {
      args[key] = argv[i + 1];
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

import fs from "node:fs";
import { appendFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  INVENTORY_CSV,
  INVENTORY_JSON,
  LOGS_DIR,
  csvEscape,
  ensureDir,
  parseArgs,
  sleep,
  writeCsv
} from "./common.mjs";

const args = parseArgs(process.argv);
const token = args.token || process.env.WEBFLOW_API_TOKEN || process.env.WEBFLOW_TOKEN || loadDotenvToken() || loadWebflowCliToken();
const API_BASE = "https://api.webflow.com/v2";
const DOMAIN_DELAY_MS = Number(args.domainDelayMs || process.env.WEBFLOW_DOMAIN_DELAY_MS || 350);
const MAX_DOMAIN_RETRIES = Number(args.domainRetries || 3);

if (!token) {
  console.error("Missing Webflow token. Set WEBFLOW_API_TOKEN, pass --token <token>, or run `webflow auth login`.");
  process.exit(1);
}

ensureDir(LOGS_DIR);

async function requestJson(url, { attempt = 1 } = {}) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json"
    }
  });

  if (response.status === 429 && attempt <= 6) {
    const retryAfter = Number(response.headers.get("retry-after") || 0);
    const backoffMs = retryAfter > 0 ? retryAfter * 1000 : 1000 * attempt * attempt;
    await sleep(backoffMs);
    return requestJson(url, { attempt: attempt + 1 });
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`${response.status} ${response.statusText} from ${url}: ${body.slice(0, 500)}`);
  }

  return response.json();
}

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

async function fetchDomains(siteId) {
  for (let attempt = 1; attempt <= MAX_DOMAIN_RETRIES; attempt += 1) {
    try {
      const payload = await requestJson(`${API_BASE}/sites/${encodeURIComponent(siteId)}/custom_domains`);
      return payload.customDomains || [];
    } catch (error) {
      if (attempt === MAX_DOMAIN_RETRIES) {
        await appendFile(
          `${LOGS_DIR}/inventory-domain-errors.csv`,
          `${csvEscape(new Date().toISOString())},${csvEscape(siteId)},${csvEscape(error.message)}\n`,
          "utf8"
        );
        return [];
      }
      await sleep(750 * attempt);
    }
  }
  return [];
}

console.log("Fetching Webflow sites from documented Data API endpoint /v2/sites...");
const sitesPayload = await requestJson(`${API_BASE}/sites`);
const sites = sitesPayload.sites || [];

if (!Array.isArray(sites)) {
  throw new Error("Unexpected /v2/sites response: missing sites array.");
}

console.log(`Found ${sites.length} sites. Fetching custom domains with safe pacing...`);
const inventory = [];
for (let index = 0; index < sites.length; index += 1) {
  const site = sites[index];
  const customDomains = Array.isArray(site.customDomains) ? site.customDomains : await fetchDomains(site.id);
  inventory.push({
    id: site.id,
    siteId: site.id,
    displayName: site.displayName || "",
    shortName: site.shortName || "",
    lastUpdated: site.lastUpdated || "",
    lastPublished: site.lastPublished || "",
    customDomains,
    customDomainUrls: customDomains.map((domain) => domain.url).filter(Boolean)
  });

  if ((index + 1) % 25 === 0 || index + 1 === sites.length) {
    console.log(`Inventory progress: ${index + 1}/${sites.length}`);
  }

  if (index + 1 < sites.length) await sleep(DOMAIN_DELAY_MS);
}

fs.writeFileSync(INVENTORY_JSON, `${JSON.stringify(inventory, null, 2)}\n`, "utf8");
writeCsv(
  INVENTORY_CSV,
  inventory.map((site) => ({
    siteId: site.siteId,
    displayName: site.displayName,
    shortName: site.shortName,
    lastUpdated: site.lastUpdated,
    lastPublished: site.lastPublished,
    customDomains: site.customDomainUrls
  })),
  ["siteId", "displayName", "shortName", "lastUpdated", "lastPublished", "customDomains"]
);

console.log(`Wrote ${INVENTORY_JSON}`);
console.log(`Wrote ${INVENTORY_CSV}`);

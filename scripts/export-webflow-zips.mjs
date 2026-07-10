import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import {
  EXPORTS_DIR,
  INVENTORY_JSON,
  LOGS_DIR,
  PROFILE_DIR,
  appendCsv,
  ensureDir,
  exportZipName,
  parseArgs,
  sleep
} from "./common.mjs";

const args = parseArgs(process.argv);
const inventoryPath = path.resolve(args.inventory || INVENTORY_JSON);
const exportsDir = path.resolve(args.exportsDir || EXPORTS_DIR);
const logsDir = path.resolve(args.logsDir || LOGS_DIR);
const profileDir = path.resolve(args.profileDir || PROFILE_DIR);

const minDelayMs = Number(args.minDelayMs || process.env.WEBFLOW_MIN_DELAY_MS || 45000);
const maxDelayMs = Number(args.maxDelayMs || process.env.WEBFLOW_MAX_DELAY_MS || 120000);
const retries = Number(args.retries || process.env.WEBFLOW_EXPORT_RETRIES || 3);
const timeoutMs = Number(args.timeoutMs || process.env.WEBFLOW_EXPORT_TIMEOUT_MS || 10 * 60 * 1000);
const limit = args.limit ? Number(args.limit) : Infinity;
const startAt = args.startAt ? String(args.startAt) : "";
const browserExecutable = args.browserExecutable || process.env.WEBFLOW_BROWSER_EXECUTABLE || "";
const cdpUrl = args.cdpUrl || process.env.WEBFLOW_CDP_URL || "";

const successLog = path.join(logsDir, "export-success.csv");
const failedLog = path.join(logsDir, "export-failed.csv");
const skippedLog = path.join(logsDir, "export-skipped.csv");

const successHeaders = ["completedAt", "siteId", "displayName", "shortName", "outputPath", "bytes", "attempt"];
const failedHeaders = ["failedAt", "siteId", "displayName", "shortName", "attempts", "error"];
const skippedHeaders = ["skippedAt", "siteId", "displayName", "shortName", "reason", "outputPath"];

ensureDir(exportsDir);
ensureDir(logsDir);
ensureDir(profileDir);

function randomDelay() {
  const low = Math.min(minDelayMs, maxDelayMs);
  const high = Math.max(minDelayMs, maxDelayMs);
  return low + Math.floor(Math.random() * (high - low + 1));
}

function designerUrl(site) {
  return `https://webflow.com/design/${encodeURIComponent(site.shortName)}`;
}

function existingZipIsComplete(filePath) {
  if (!fs.existsSync(filePath)) return false;
  const stat = fs.statSync(filePath);
  return stat.isFile() && stat.size > 1024;
}

function readSkippedSiteIds() {
  if (!fs.existsSync(skippedLog)) return new Set();
  const lines = fs.readFileSync(skippedLog, "utf8").trim().split(/\r?\n/).slice(1);
  return new Set(lines.map((line) => line.split(",")[1]).filter(Boolean));
}

async function clickFirstVisible(page, candidates, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    for (const locator of candidates) {
      try {
        const count = await locator.count();
        for (let i = 0; i < count; i += 1) {
          const item = locator.nth(i);
          if (await item.isVisible().catch(() => false)) {
            await item.click({ timeout: 5000 });
            return;
          }
        }
      } catch (error) {
        lastError = error;
      }
    }
    await sleep(500);
  }
  throw lastError || new Error("No visible matching control found.");
}

async function anyVisible(candidates) {
  for (const locator of candidates) {
    const count = await locator.count().catch(() => 0);
    for (let i = 0; i < count; i += 1) {
      if (await locator.nth(i).isVisible().catch(() => false)) return true;
    }
  }
  return false;
}

async function waitForDownloadWithRepeatedClicks(page, downloadLocators, timeout) {
  const deadline = Date.now() + timeout;
  const downloadPromise = page.waitForEvent("download", { timeout });
  let lastClickError;

  while (Date.now() < deadline) {
    for (const locator of downloadLocators) {
      try {
        const target = locator.last();
        if (await target.isVisible({ timeout: 1000 }).catch(() => false)) {
          await target.click({ timeout: Math.min(5000, Math.max(1000, deadline - Date.now())) });
          lastClickError = null;
          break;
        }
      } catch (error) {
        lastClickError = error;
      }
    }

    const result = await Promise.race([
      downloadPromise.then((download) => ({ download })).catch((error) => ({ error })),
      sleep(15000).then(() => null)
    ]);
    if (result?.download) return result.download;
    if (result?.error) throw result.error;
  }

  try {
    return await downloadPromise;
  } catch (error) {
    if (lastClickError) error.message = `${error.message}\nLast download click error: ${lastClickError.message}`;
    throw error;
  }
}

async function openCodeExport(page) {
  await page.bringToFront().catch(() => {});
  const cookieAccept = page.getByText(/^Accept$/i);
  if (await cookieAccept.first().isVisible().catch(() => false)) {
    await cookieAccept.first().click().catch(() => {});
    await page.waitForTimeout(1000);
  }

  const exportPanelText = page
    .getByText(/prepare zip|download zip|download|code export|export code|loading code/i)
    .first();

  if (await exportPanelText.isVisible().catch(() => false)) return;

  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await page.bringToFront().catch(() => {});
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(500);
      await page.mouse.click(600, 300).catch(() => {});
      await page.keyboard.press("Shift+E");
      await exportPanelText.waitFor({ timeout: 15000 });
      return;
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(1000 * attempt);
    }
  }

  throw lastError || new Error("Could not open Webflow Export Code panel with Shift+E.");
}

async function exportOneSite(page, site, outputPath, attempt) {
  await page.goto(designerUrl(site), { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForLoadState("networkidle", { timeout: 120000 }).catch(() => {});
  await sleep(5000);

  await openCodeExport(page);
  const downloadLocators = [
    page.getByRole("button", { name: /download(?: zip)?/i }),
    page.getByRole("link", { name: /download(?: zip)?/i }),
    page.getByText(/download zip/i),
    page.getByText(/^download$/i)
  ];

  if (!(await anyVisible(downloadLocators))) {
    await clickFirstVisible(page, [
      page.getByRole("button", { name: /prepare zip/i }),
      page.getByText(/prepare zip/i)
    ], timeoutMs);
  }

  const download = await waitForDownloadWithRepeatedClicks(page, downloadLocators, timeoutMs);
  const tempPath = `${outputPath}.part-${process.pid}-${attempt}`;
  const failure = await download.failure();
  if (failure) throw new Error(`Download failed: ${failure}`);
  try {
    await download.saveAs(tempPath);
    fs.renameSync(tempPath, outputPath);
  } catch (error) {
    const suggestedName = download.suggestedFilename();
    const directPath = path.join(exportsDir, suggestedName);
    if (suggestedName && fs.existsSync(directPath)) {
      fs.renameSync(directPath, outputPath);
    } else {
      throw error;
    }
  }
}

if (args.login) {
  if (cdpUrl) {
    console.error("--login is not used with --cdp-url. Open Brave manually with remote debugging, log in there, then run export.");
    process.exit(1);
  }
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    acceptDownloads: true,
    executablePath: browserExecutable || undefined
  });
  const page = context.pages()[0] || (await context.newPage());
  await page.goto("https://webflow.com/dashboard", { waitUntil: "domcontentloaded" });
  console.log(`Persistent profile opened at ${profileDir}`);
  console.log("Log into Webflow in the browser window. Press Ctrl+C here when finished.");
  await new Promise(() => {});
}

if (!fs.existsSync(inventoryPath)) {
  console.error(`Missing inventory file: ${inventoryPath}`);
  console.error("Run npm run inventory first.");
  process.exit(1);
}

const inventory = JSON.parse(fs.readFileSync(inventoryPath, "utf8"));
const sites = Array.isArray(inventory) ? inventory : inventory.sites;
if (!Array.isArray(sites)) throw new Error("Inventory must be an array or contain a sites array.");

let filteredSites = sites.filter((site) => site.id || site.siteId);
if (args.siteIdsFile) {
  const siteIdsPath = path.resolve(args.siteIdsFile);
  const siteIds = new Set(
    fs.readFileSync(siteIdsPath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  );
  filteredSites = filteredSites.filter((site) => siteIds.has(site.id || site.siteId));
}
if (startAt) {
  const index = filteredSites.findIndex((site) => site.id === startAt || site.siteId === startAt || site.shortName === startAt);
  if (index === -1) throw new Error(`Could not find --start-at value in inventory: ${startAt}`);
  filteredSites = filteredSites.slice(index);
}
filteredSites = filteredSites.slice(0, limit);

let context;
let page;
let browser;
const skippedSiteIds = readSkippedSiteIds();
if (!args.dryRun) {
  if (cdpUrl) {
    browser = await chromium.connectOverCDP(cdpUrl);
    const browserSession = await browser.newBrowserCDPSession();
    await browserSession.send("Browser.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: exportsDir,
      eventsEnabled: true
    });
    context = browser.contexts()[0] || (await browser.newContext({ acceptDownloads: true }));
  } else {
    context = await chromium.launchPersistentContext(profileDir, {
      headless: false,
      acceptDownloads: true,
      executablePath: browserExecutable || undefined,
      viewport: { width: 1440, height: 1000 }
    });
  }
  page = context.pages()[0] || (await context.newPage());
  page.setDefaultTimeout(60000);
}

let processed = 0;
try {
  for (let siteIndex = 0; siteIndex < filteredSites.length; siteIndex += 1) {
    const rawSite = filteredSites[siteIndex];
    const site = { ...rawSite, id: rawSite.id || rawSite.siteId, siteId: rawSite.siteId || rawSite.id };
    const outputPath = path.join(exportsDir, exportZipName(site));

    if (skippedSiteIds.has(site.siteId)) {
      console.log(`Skipped ${site.displayName || site.shortName}: marked skipped in export-skipped.csv`);
      processed += 1;
      continue;
    }

    if (!site.shortName) {
      appendCsv(skippedLog, {
        skippedAt: new Date().toISOString(),
        siteId: site.siteId,
        displayName: site.displayName,
        shortName: site.shortName,
        reason: "missing shortName; cannot construct documented Designer URL",
        outputPath
      }, skippedHeaders);
      console.log(`Skipped ${site.siteId}: missing shortName`);
      processed += 1;
      continue;
    }

    if (existingZipIsComplete(outputPath)) {
      appendCsv(skippedLog, {
        skippedAt: new Date().toISOString(),
        siteId: site.siteId,
        displayName: site.displayName,
        shortName: site.shortName,
        reason: "zip already exists",
        outputPath
      }, skippedHeaders);
      console.log(`Skipped ${site.displayName || site.shortName}: already exported`);
      processed += 1;
      continue;
    }

    if (args.dryRun) {
      console.log(`[dry-run] Would export ${site.displayName || site.shortName} -> ${outputPath}`);
      processed += 1;
      continue;
    }

    let lastError;
    for (let attempt = 1; attempt <= retries; attempt += 1) {
      try {
        console.log(`Exporting ${site.displayName || site.shortName} (${site.siteId}), attempt ${attempt}/${retries}`);
        await exportOneSite(page, site, outputPath, attempt);
        const bytes = fs.statSync(outputPath).size;
        appendCsv(successLog, {
          completedAt: new Date().toISOString(),
          siteId: site.siteId,
          displayName: site.displayName,
          shortName: site.shortName,
          outputPath,
          bytes,
          attempt
        }, successHeaders);
        console.log(`Saved ${outputPath} (${bytes} bytes)`);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        console.warn(`Attempt ${attempt} failed for ${site.siteId}: ${error.message}`);
        await page.screenshot({ path: path.join(logsDir, `failure-${site.siteId}-attempt-${attempt}.png`), fullPage: true }).catch(() => {});
        await sleep(5000 * attempt);
      }
    }

    if (lastError) {
      appendCsv(failedLog, {
        failedAt: new Date().toISOString(),
        siteId: site.siteId,
        displayName: site.displayName,
        shortName: site.shortName,
        attempts: retries,
        error: lastError.message
      }, failedHeaders);
      console.error(`Failed ${site.displayName || site.shortName}: ${lastError.message}`);
    }

    processed += 1;
    const hasMoreUnexportedSites = filteredSites.slice(siteIndex + 1).some((candidate) => {
      const normalized = { ...candidate, id: candidate.id || candidate.siteId, siteId: candidate.siteId || candidate.id };
      return normalized.shortName
        && !skippedSiteIds.has(normalized.siteId)
        && !existingZipIsComplete(path.join(exportsDir, exportZipName(normalized)));
    });
    if (hasMoreUnexportedSites) {
      const delay = randomDelay();
      console.log(`Pacing delay: ${Math.round(delay / 1000)}s`);
      await sleep(delay);
    }
  }
} finally {
  if (browser) await browser.close();
  else await context?.close();
}

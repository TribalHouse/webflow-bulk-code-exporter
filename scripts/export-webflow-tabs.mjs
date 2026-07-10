import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import {
  EXPORTS_DIR,
  INVENTORY_JSON,
  LOGS_DIR,
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
const cdpUrl = args.cdpUrl || process.env.WEBFLOW_CDP_URL || "http://127.0.0.1:9222";
const workers = Number(args.workers || 3);
const minDelayMs = Number(args.minDelayMs || process.env.WEBFLOW_MIN_DELAY_MS || 20000);
const maxDelayMs = Number(args.maxDelayMs || process.env.WEBFLOW_MAX_DELAY_MS || 40000);
const retries = Number(args.retries || process.env.WEBFLOW_EXPORT_RETRIES || 2);
const timeoutMs = Number(args.timeoutMs || process.env.WEBFLOW_EXPORT_TIMEOUT_MS || 5 * 60 * 1000);

const successLog = path.join(logsDir, "export-success.csv");
const failedLog = path.join(logsDir, "export-failed.csv");
const skippedLog = path.join(logsDir, "export-skipped.csv");
const successHeaders = ["completedAt", "siteId", "displayName", "shortName", "outputPath", "bytes", "attempt"];
const failedHeaders = ["failedAt", "siteId", "displayName", "shortName", "attempts", "error"];

ensureDir(exportsDir);
ensureDir(logsDir);

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

function readSiteIds(csvPath) {
  if (!fs.existsSync(csvPath)) return new Set();
  const lines = fs.readFileSync(csvPath, "utf8").trim().split(/\r?\n/).slice(1);
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

function createLock() {
  let current = Promise.resolve();
  return async (fn) => {
    const previous = current;
    let release;
    current = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

const focusLock = createLock();

async function openCodeExport(page) {
  await focusLock(async () => {
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
  });
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
  const failure = await download.failure();
  if (failure) throw new Error(`Download failed: ${failure}`);

  const tempPath = `${outputPath}.part-${process.pid}-${attempt}`;
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

if (!fs.existsSync(inventoryPath)) {
  console.error(`Missing inventory file: ${inventoryPath}`);
  process.exit(1);
}

const inventory = JSON.parse(fs.readFileSync(inventoryPath, "utf8"));
const sites = (Array.isArray(inventory) ? inventory : inventory.sites)
  .map((rawSite, index) => ({ ...rawSite, id: rawSite.id || rawSite.siteId, siteId: rawSite.siteId || rawSite.id, index: index + 1 }));

const skippedSiteIds = readSiteIds(skippedLog);
const failedSiteIds = readSiteIds(failedLog);
const queue = sites
  .filter((site) => site.siteId && site.shortName)
  .filter((site) => !skippedSiteIds.has(site.siteId))
  .filter((site) => !failedSiteIds.has(site.siteId))
  .filter((site) => !existingZipIsComplete(path.join(exportsDir, exportZipName(site))));

console.log(`Starting ${workers} tab workers against ${queue.length} remaining sites via ${cdpUrl}`);

const browser = await chromium.connectOverCDP(cdpUrl);
const browserSession = await browser.newBrowserCDPSession();
await browserSession.send("Browser.setDownloadBehavior", {
  behavior: "allow",
  downloadPath: exportsDir,
  eventsEnabled: true
});
const context = browser.contexts()[0] || (await browser.newContext({ acceptDownloads: true }));

let nextIndex = 0;
function takeSite() {
  if (nextIndex >= queue.length) return null;
  const site = queue[nextIndex];
  nextIndex += 1;
  return site;
}

async function runWorker(workerId) {
  const page = await context.newPage();
  page.setDefaultTimeout(60000);

  while (true) {
    const site = takeSite();
    if (!site) break;
    const outputPath = path.join(exportsDir, exportZipName(site));
    if (existingZipIsComplete(outputPath)) continue;

    let lastError;
    for (let attempt = 1; attempt <= retries; attempt += 1) {
      try {
        console.log(`[tab ${workerId}] Exporting ${site.displayName || site.shortName} (${site.siteId}), attempt ${attempt}/${retries}`);
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
        console.log(`[tab ${workerId}] Saved ${outputPath} (${bytes} bytes)`);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        console.warn(`[tab ${workerId}] Attempt ${attempt} failed for ${site.siteId}: ${error.message}`);
        await page.screenshot({ path: path.join(logsDir, `failure-${site.siteId}-tab-${workerId}-attempt-${attempt}.png`), fullPage: true }).catch(() => {});
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
      console.error(`[tab ${workerId}] Failed ${site.displayName || site.shortName}: ${lastError.message}`);
    }

    const delay = randomDelay();
    console.log(`[tab ${workerId}] Pacing delay: ${Math.round(delay / 1000)}s`);
    await sleep(delay);
  }

  await page.close().catch(() => {});
  console.log(`[tab ${workerId}] Done`);
}

try {
  await Promise.all(Array.from({ length: workers }, (_, index) => runWorker(index + 1)));
} finally {
  await browser.close();
}

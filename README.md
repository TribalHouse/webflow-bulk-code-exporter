# Webflow Bulk Code Exporter

Download official Webflow Designer code export ZIPs in bulk from accounts you are authorized to access. The exporter is a local Playwright automation tool for Webflow backup, migration prep, account cleanup, and long-running site preservation.

Webflow does not provide a documented public API or CLI command for bulk official code ZIP export. This project uses documented API reads for inventory, then drives the normal Webflow Designer UI flow in a real signed-in browser:

```text
Open Designer -> Shift+E -> Prepare ZIP -> Download ZIP
```

It is built for reliability, resumability, and auditability rather than speed.

## Boundaries

This tool does not bypass authentication, billing, plan permissions, workspace permissions, bot checks, or access controls. You log in manually. The exporter only acts through the visible Designer UI available to your account.

The code export itself intentionally does not rely on private or undocumented Webflow HTTP endpoints.

## Features

- Build a Webflow site inventory with the documented Data API.
- Export official Designer ZIPs with a persistent browser profile.
- Resume safely by skipping ZIPs already present on disk.
- Log successes, failures, skipped sites, retry candidates, and status snapshots.
- Run one tab for reliability or multiple tabs for cautious throughput.
- Retry failed sites with longer timeouts.
- Organize downloaded ZIPs into hardlink views by Webflow folder ID and inferred type.

## Requirements

- Node.js 20 or newer
- npm
- A Webflow account with access to the target sites
- A Webflow API token for inventory generation
- A Chromium-based browser

Install dependencies:

```bash
npm install
npx playwright install chromium
```

Create your environment file:

```bash
cp .env.example .env
```

Then set `WEBFLOW_API_TOKEN` in `.env`, or export it in your shell.

## Inventory

Inventory uses documented Webflow Data API reads.

```bash
npm run inventory
```

This writes local private files:

- `webflow-sites-inventory.json`
- `webflow-sites-inventory.csv`

These files are ignored by Git because they contain account and site metadata.

## Browser Login

The most reliable path is a manually opened Chromium-based browser with remote debugging:

```bash
npm run browser:debug
```

In that browser window, open `https://webflow.com/dashboard` and log in manually. Complete any Webflow security prompts yourself. Leave the window open.

For Playwright-launched Chromium:

```bash
npm run export:login
```

To use a specific browser application for the debug profile, set `WEBFLOW_BROWSER_APP`:

```bash
WEBFLOW_BROWSER_APP="Google Chrome" npm run browser:debug
```

Browser profile folders are ignored by Git because they contain cookies, sessions, and local storage.

## Export ZIPs

Dry run:

```bash
npm run export:zips:dry-run -- --limit 3
```

Export through a manually opened Chromium-based browser session:

```bash
npm run export:zips:browser-cdp
```

Same-profile multi-tab export:

```bash
WEBFLOW_TAB_WORKERS=1 npm run export:zips:tabs
WEBFLOW_TAB_WORKERS=3 npm run export:zips:tabs
WEBFLOW_TAB_WORKERS=5 npm run export:zips:tabs
```

Useful pacing controls:

```bash
WEBFLOW_TAB_WORKERS=3 \
WEBFLOW_MIN_DELAY_MS=20000 \
WEBFLOW_MAX_DELAY_MS=40000 \
WEBFLOW_EXPORT_TIMEOUT_MS=600000 \
WEBFLOW_EXPORT_RETRIES=2 \
npm run export:zips:tabs
```

`WEBFLOW_TAB_WORKERS` controls how many Designer tabs the exporter keeps active in the signed-in browser profile.

- `1` tab is the most reliable setting.
- `3` tabs is a practical balance for large accounts.
- `5` tabs is the upper end for most runs.

Running more than five tabs at a time is not recommended. Higher concurrency can increase Designer load failures, download timeouts, browser instability, and Webflow security friction.

ZIPs are saved in `exports/` using:

```text
{safeDisplayName}**{shortName}**{siteId}.zip
```

## Status, Resume, And Retry

Refresh status files:

```bash
npm run export:status
npm run export:retry-candidates
npm run export:snapshots
```

Generated logs include:

- `logs/export-success.csv`
- `logs/export-failed.csv`
- `logs/export-skipped.csv`
- `logs/export-status.csv`
- `logs/export-status.json`
- `logs/export-retry-candidates.csv`
- `logs/export-retry-candidates.json`

Logs are ignored by Git because they can contain account metadata, local paths, screenshots, and error details.

Retry a specific generated site-id list:

```bash
WEBFLOW_CDP_URL="http://127.0.0.1:9222" node scripts/export-webflow-zips.mjs \
  --site-ids-file logs/final-failed-retry.siteids.txt \
  --timeout-ms 600000 \
  --retries 1
```

## Organize Exports

Create a non-destructive organization plan:

```bash
npm run exports:organize
```

Create hardlink views:

```bash
npm run exports:organize -- --apply --mode hardlink
```

The organizer can create:

- `exports-organized/by-webflow-folder/...`
- `exports-organized/by-inferred-type/...`

Webflow’s site list exposes `parentFolderId`, but not always the human-readable folder name. To provide names, copy `examples/webflow-folder-names.example.json` to `logs/webflow-folder-names.json`, fill in folder names, then rerun the organizer.

## Troubleshooting

If Webflow changes the Designer export modal, the script may fail rather than falling back to private endpoints. Check `logs/failure-*.png`, update selectors in `scripts/export-webflow-zips.mjs` or `scripts/export-webflow-tabs.mjs`, then rerun. Existing ZIPs are skipped automatically.

If a ZIP looks incomplete, delete only that ZIP and rerun the exporter.

# Operations Guide

## Inventory

Inventory uses documented Webflow Data API reads. Set `WEBFLOW_API_TOKEN` and run:

```bash
npm run inventory
```

Generated inventory files are private account metadata and are ignored by Git.

## Login

Use a persistent Chromium-based browser profile and log in manually:

```bash
npm run browser:debug
```

Open `https://webflow.com/dashboard` in that browser window and complete any Webflow login or verification prompts yourself.

To choose the browser application:

```bash
WEBFLOW_BROWSER_APP="Google Chrome" npm run browser:debug
```

## Export

For maximum reliability:

```bash
WEBFLOW_TAB_WORKERS=1 npm run export:zips:tabs
```

For cautious multi-tab throughput:

```bash
WEBFLOW_TAB_WORKERS=3 WEBFLOW_MIN_DELAY_MS=20000 WEBFLOW_MAX_DELAY_MS=40000 npm run export:zips:tabs
```

For larger runs, set the tab count explicitly:

```bash
WEBFLOW_TAB_WORKERS=1 npm run export:zips:tabs
WEBFLOW_TAB_WORKERS=3 npm run export:zips:tabs
WEBFLOW_TAB_WORKERS=5 npm run export:zips:tabs
```

Do not run more than five tabs at a time. More concurrency tends to increase Designer load failures, download timeouts, browser instability, and Webflow security friction.

The exporter skips completed ZIPs, so reruns are resumable.

## Status And Retry

```bash
npm run export:status
npm run export:retry-candidates
npm run export:snapshots
```

Retry a generated list with:

```bash
WEBFLOW_CDP_URL="http://127.0.0.1:9222" node scripts/export-webflow-zips.mjs \
  --site-ids-file logs/final-failed-retry.siteids.txt \
  --timeout-ms 600000 \
  --retries 1
```

## Organizing Exports

```bash
npm run exports:organize
npm run exports:organize -- --apply --mode hardlink
```

The organizer creates hardlink views by Webflow `parentFolderId` and by inferred type. Hardlinks avoid duplicating ZIP data on disk.

# Security Policy

This project controls a real browser session. Treat browser profiles and generated logs as sensitive.

## Never Commit

- `.env` or API tokens
- `webflow.json`
- browser profile folders such as `.webflow-browser-profile/` and `.chromium-webflow-profile/`
- downloaded ZIPs in `exports/`
- generated logs, screenshots, inventories, and retry files in `logs/`
- `webflow-sites-inventory.json` or `webflow-sites-inventory.csv`

The repository `.gitignore` excludes these by default. Do not upload the local working folder through a web form, because manual uploads can bypass ignore rules.

## Responsible Use

Use this tool only with Webflow accounts and sites you are allowed to access. It does not bypass authentication, billing, permissions, plan limits, security checks, or Webflow access controls.

The exporter intentionally drives the official Webflow Designer UI. It does not rely on private export endpoints for downloading ZIPs.

## Reporting Issues

If you find a bug that could expose credentials, cookies, downloaded site files, or private account metadata, do not post those artifacts publicly. Open a minimal issue with redacted details or contact the maintainer privately if available.

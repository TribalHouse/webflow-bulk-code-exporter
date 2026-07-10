import fs from "node:fs";

const status = JSON.parse(fs.readFileSync("logs/export-status.json", "utf8"));
const groups = {
  completed: status.sites.filter((site) => site.status === "completed"),
  skipped: status.sites.filter((site) => site.status === "skipped"),
  failed: status.sites.filter((site) => site.status === "failed"),
  remaining: status.sites.filter((site) => site.status === "remaining")
};

const headers = ["index", "status", "siteId", "displayName", "shortName", "lastUpdated", "lastPublished", "outputPath", "bytes"];
const esc = (value) => {
  const text = value == null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

for (const [name, rows] of Object.entries(groups)) {
  fs.writeFileSync(
    `logs/export-${name}-so-far.json`,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), count: rows.length, sites: rows }, null, 2)}\n`
  );
  fs.writeFileSync(
    `logs/export-${name}-so-far.csv`,
    `${[headers.join(","), ...rows.map((row) => headers.map((header) => esc(row[header])).join(","))].join("\n")}\n`
  );
}

const next = groups.remaining[0];
const last = groups.completed.at(-1);
fs.writeFileSync(
  "logs/RESUME-NOTE.md",
  `# Webflow Export Resume Note

Generated: ${new Date().toISOString()}

Summary:
- Total inventory sites: ${status.summary.total}
- Completed ZIP exports: ${status.summary.completed}
- Skipped sites: ${status.summary.skipped}
- Failed sites: ${status.summary.failed}
- Remaining: ${status.summary.remaining}

Last completed site:
- Index: ${last?.index ?? ""}
- Site ID: ${last?.siteId ?? ""}
- Display name: ${last?.displayName ?? ""}
- Short name: ${last?.shortName ?? ""}
- ZIP: ${last?.outputPath ?? ""}

Next remaining site at checkpoint time:
- Index: ${next?.index ?? ""}
- Site ID: ${next?.siteId ?? ""}
- Display name: ${next?.displayName ?? ""}
- Short name: ${next?.shortName ?? ""}

Resume command:
\`\`\`bash
WEBFLOW_TAB_WORKERS=3 npm run export:zips:tabs
\`\`\`
`
);

console.log({ generatedAt: new Date().toISOString(), summary: status.summary, lastCompleted: last?.displayName, nextRemaining: next?.displayName });

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();

const forbiddenPaths = [
  ".env",
  "webflow.json",
  "webflow-sites-inventory.json",
  "webflow-sites-inventory.csv",
  "exports",
  "exports-organized",
  "logs",
  ".webflow-browser-profile",
  ".chromium-webflow-profile",
  ".chromium-worker-1",
  ".chromium-worker-2",
  ".chromium-worker-3"
];

const scanExtensions = new Set([".js", ".mjs", ".json", ".md", ".yml", ".yaml", ".txt", ".csv"]);
const skipDirs = new Set([
  ".git",
  "node_modules",
  "exports",
  "exports-organized",
  "logs",
  ".webflow-browser-profile",
  ".chromium-webflow-profile",
  ".chromium-worker-1",
  ".chromium-worker-2",
  ".chromium-worker-3"
]);

const suspiciousPatterns = [
  /WEBFLOW_API_TOKEN\s*=\s*[^#\s]+/i,
  /WEBFLOW_TOKEN\s*=\s*[^#\s]+/i,
  /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/,
  /accessToken"\s*:\s*"[^"]{20,}"/i,
  /refreshToken"\s*:\s*"[^"]{20,}"/i,
  /\/Users\/[A-Za-z0-9._-]+/,
  /\/Volumes\/DevSSD/
];

const problems = [];

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skipDirs.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(root, fullPath);
    if (entry.isDirectory()) {
      walk(fullPath, files);
      continue;
    }
    if (!scanExtensions.has(path.extname(entry.name))) continue;
    files.push(relativePath);
  }
  return files;
}

function publishCandidateFiles() {
  try {
    const output = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    const files = output.split(/\r?\n/).filter(Boolean);
    if (files.length) return files;
  } catch {
    // Fall back to a filesystem walk when Git is unavailable.
  }
  return walk(root);
}

const candidateFiles = publishCandidateFiles();
const existingCandidateFiles = candidateFiles.filter((relativePath) => fs.existsSync(path.join(root, relativePath)));
const candidateSet = new Set(existingCandidateFiles);

for (const relativePath of forbiddenPaths) {
  if (candidateSet.has(relativePath) || existingCandidateFiles.some((file) => file.startsWith(`${relativePath}/`))) {
    problems.push(`Local-only path would be published: ${relativePath}`);
  }
}

for (const relativePath of existingCandidateFiles) {
  if (!scanExtensions.has(path.extname(relativePath))) continue;
  const text = fs.readFileSync(path.join(root, relativePath), "utf8");
  for (const pattern of suspiciousPatterns) {
    if (pattern.test(text)) {
      problems.push(`Suspicious content matched ${pattern} in ${relativePath}`);
    }
  }
}

if (problems.length) {
  console.error("Prepublish check failed:");
  for (const problem of problems) console.error(`- ${problem}`);
  console.error("\nUse git with .gitignore, or publish from a clean clone that contains only source files.");
  process.exit(1);
}

console.log(`Prepublish check passed for ${existingCandidateFiles.length} candidate files.`);

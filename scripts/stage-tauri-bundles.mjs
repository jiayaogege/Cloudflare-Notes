import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

const [sourceRoot, outputDirectory, platformLabel] = process.argv.slice(2);
if (!sourceRoot || !outputDirectory || !platformLabel) {
  throw new Error("Usage: node stage-tauri-bundles.mjs <target-dir> <output-dir> <platform-label>");
}
const releaseTag = process.env.GITHUB_REF_NAME ?? "local";
const prefix = `Cloudflare-Private-Notes-${releaseTag}-${platformLabel}-unsigned`;

const installerExtensions = new Set([".msi", ".exe", ".dmg", ".deb", ".rpm", ".appimage"]);
const files = [];

function walk(directory, inBundle = false) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const isBundle = inBundle || entry.name === "bundle";
    if (entry.isDirectory()) {
      walk(path, isBundle);
    } else if (isBundle && installerExtensions.has(entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase())) {
      files.push(path);
    }
  }
}

walk(sourceRoot);
if (files.length === 0) throw new Error(`No Tauri installers found under ${sourceRoot}`);

mkdirSync(outputDirectory, { recursive: true });
const usedNames = new Set();
for (const source of files) {
  const originalName = basename(source);
  let targetName = `${prefix}-${originalName}`;
  let duplicate = 2;
  while (usedNames.has(targetName)) {
    targetName = `${prefix}-${duplicate++}-${originalName}`;
  }
  usedNames.add(targetName);
  copyFileSync(source, join(outputDirectory, targetName));
}

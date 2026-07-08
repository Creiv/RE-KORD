#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath = path.join(root, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const version = String(pkg.version || "0.0.0").trim();
const parts = version.split(".").map((p) => Number(p) || 0);
const versionCode = parts[0] * 1000 + parts[1] * 10 + parts[2];
const versionShort = version.split(".").slice(0, 2).join(".");

const gradlePath = path.join(root, "android/app/build.gradle");
let gradle = readFileSync(gradlePath, "utf8");
gradle = gradle.replace(/versionCode\s+\d+/, `versionCode ${versionCode}`);
gradle = gradle.replace(/versionName\s+"[^"]+"/, `versionName "${version}"`);
writeFileSync(gradlePath, gradle);

const composePath = path.join(root, "docker-compose.yml");
let compose = readFileSync(composePath, "utf8");
compose = compose.replace(/image:\s*rekord:[^\s]+/, `image: rekord:${version}`);
writeFileSync(composePath, compose);

const readmePath = path.join(root, "README.md");
let readme = readFileSync(readmePath, "utf8");
readme = readme.replace(/RE-KORD \d+\.\d+(\.\d+)?/g, `RE-KORD ${versionShort}`);
readme = readme.replace(
  /npm run pack:[\w:]+ -- \d+\.\d+\.\d+/g,
  (match) => match.replace(/\d+\.\d+\.\d+/, version),
);
writeFileSync(readmePath, readme);

const featuresPath = path.join(root, "docs/FEATURES.md");
let features = readFileSync(featuresPath, "utf8");
features = features.replace(
  /> Versione app: \*\*[\d.]+\*\*/,
  `> Versione app: **${version}**`,
);
features = features.replace(
  /> Versione app: [\d.]+/,
  `> Versione app: **${version}**`,
);
writeFileSync(featuresPath, features);

console.log(`Synced version ${version} (code ${versionCode})`);

#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const version = String(pkg.version || "").trim();
const gradle = readFileSync(path.join(root, "android/app/build.gradle"), "utf8");
const compose = readFileSync(path.join(root, "docker-compose.yml"), "utf8");
const gradleMatch = gradle.match(/versionName\s+"([^"]+)"/);
const composeMatch = compose.match(/image:\s*rekord:([^\s]+)/);
const features = readFileSync(path.join(root, "docs/FEATURES.md"), "utf8");
const featuresMatch = features.match(/Versione app: \*\*([\d.]+)\*\*/);
let ok = true;
if (gradleMatch?.[1] !== version) {
  console.error(`Gradle versionName mismatch: ${gradleMatch?.[1]} != ${version}`);
  ok = false;
}
if (composeMatch?.[1] !== version) {
  console.error(`docker-compose image tag mismatch: ${composeMatch?.[1]} != ${version}`);
  ok = false;
}
if (featuresMatch?.[1] !== version) {
  console.error(`docs/FEATURES.md version mismatch: ${featuresMatch?.[1]} != ${version}`);
  ok = false;
}
if (!ok) process.exit(1);
console.log(`Version check OK: ${version}`);

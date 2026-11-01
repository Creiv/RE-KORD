#!/usr/bin/env node
/**
 * A single version for all of RE-KORD next.
 *
 *   node scripts/version.mjs sync 5.2.0   writes 5.2.0 everywhere
 *   node scripts/version.mjs sync         realigns everything to the package.json version
 *   node scripts/version.mjs check 5.2.0  checks that 5.2.0 is everywhere
 *   node scripts/version.mjs check        checks that everything matches package.json
 *
 * Where the version lives:
 *   - package.json (root, apps/*, packages/*)
 *   - Cargo.toml `[workspace.package] version` (the crates use version.workspace)
 *   - Cargo.lock, entries of the workspace crates (otherwise `cargo --locked` fails)
 *   - apps/client-shell/src-tauri/tauri.conf.json `version`, if present (normally
 *     absent: Tauri takes it from Cargo.toml)
 *   - apps/client-ui/src/lib/version.ts `APP_VERSION`
 *   - apps/client-shell/src-tauri/gen/android/app/tauri.properties (git-ignored, written
 *     by `tauri android init` and never updated by the Tauri CLI afterwards: versionName
 *     and versionCode = major * 1000000 + minor * 1000 + patch, 5.3.0 → 5003000)
 *
 * `check` exits with code 1 on any mismatch: CI uses it (next.yml).
 * No dependencies: runs with plain node.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const rel = (p) => path.relative(ROOT, p) || p;

/** Tauri's Android versionCode for a version: 5.3.0 → 5003000 (pre-release tags ignored). */
export function androidVersionCode(version) {
  const [major, minor, patch] = version.split(/[-+]/)[0].split(".").map(Number);
  return major * 1_000_000 + minor * 1_000 + patch;
}
const read = (p) => readFileSync(p, "utf8");

function packageJsonFiles() {
  const out = [path.join(ROOT, "package.json")];
  for (const group of ["apps", "packages"]) {
    const dir = path.join(ROOT, group);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      const p = path.join(dir, name, "package.json");
      if (existsSync(p)) out.push(p);
    }
  }
  return out;
}

/** Names of the workspace crates, read from their Cargo.toml files. */
function workspaceCrates() {
  const cargo = read(path.join(ROOT, "Cargo.toml"));
  const members = /members\s*=\s*\[([\s\S]*?)\]/.exec(cargo)?.[1] ?? "";
  const names = [];
  for (const m of members.matchAll(/"([^"]+)"/g)) {
    const toml = path.join(ROOT, m[1], "Cargo.toml");
    if (!existsSync(toml)) continue;
    const name = /^\s*name\s*=\s*"([^"]+)"/m.exec(read(toml))?.[1];
    if (name) names.push(name);
  }
  return names;
}

/**
 * Each "location" knows how to read its own version and write a new one
 * (preserving the rest of the file byte for byte).
 */
function locations() {
  const list = [];

  for (const file of packageJsonFiles()) {
    list.push({
      file,
      label: rel(file),
      get: (src) => JSON.parse(src).version ?? null,
      set: (src, v) => src.replace(/("version"\s*:\s*")[^"]*(")/, `$1${v}$2`),
    });
  }

  const cargoToml = path.join(ROOT, "Cargo.toml");
  const wsVersion = /(\[workspace\.package\][^[]*?\bversion\s*=\s*")([^"]*)(")/;
  list.push({
    file: cargoToml,
    label: "Cargo.toml [workspace.package]",
    get: (src) => wsVersion.exec(src)?.[2] ?? null,
    set: (src, v) => src.replace(wsVersion, `$1${v}$3`),
  });

  const lock = path.join(ROOT, "Cargo.lock");
  if (existsSync(lock)) {
    for (const crate of workspaceCrates()) {
      const re = new RegExp(`(\\[\\[package\\]\\]\\nname = "${crate}"\\nversion = ")([^"]*)(")`);
      list.push({
        file: lock,
        label: `Cargo.lock (${crate})`,
        optional: true,
        get: (src) => re.exec(src)?.[2] ?? null,
        set: (src, v) => src.replace(re, `$1${v}$3`),
      });
    }
  }

  const tauriConf = path.join(ROOT, "apps/client-shell/src-tauri/tauri.conf.json");
  if (existsSync(tauriConf)) {
    list.push({
      file: tauriConf,
      label: "tauri.conf.json",
      // Absent = inherited from Cargo.toml: that's fine, there is nothing to align.
      optional: true,
      get: (src) => {
        const v = JSON.parse(src).version;
        return typeof v === "string" && SEMVER.test(v) ? v : null;
      },
      set: (src, v) => src.replace(/("version"\s*:\s*")\d[^"]*(")/, `$1${v}$2`),
    });
  }

  const versionTs = path.join(ROOT, "apps/client-ui/src/lib/version.ts");
  list.push({
    file: versionTs,
    label: "client-ui/src/lib/version.ts",
    get: (src) => /APP_VERSION\s*=\s*"([^"]*)"/.exec(src)?.[1] ?? null,
    set: (src, v) => src.replace(/(APP_VERSION\s*=\s*")[^"]*(")/, `$1${v}$2`),
  });

  // The Android project takes versionName/versionCode from this generated file
  // (build.gradle.kts). The Tauri CLI writes it at `android init` only, so without
  // this entry every later APK keeps the first version (5.3.0 shipped as 5.1.0).
  // android-build.sh rewrites it before each build; this keeps `check` honest.
  const tauriProps = path.join(ROOT, "apps/client-shell/src-tauri/gen/android/app/tauri.properties");
  const propName = /^(tauri\.android\.versionName=)(.*)$/m;
  const propCode = /^(tauri\.android\.versionCode=)(\d*)$/m;
  list.push({
    file: tauriProps,
    label: "gen/android/app/tauri.properties",
    optional: true,
    get: (src) => {
      const name = propName.exec(src)?.[2]?.trim();
      const code = propCode.exec(src)?.[2];
      if (!name || code == null) return null;
      return code === String(androidVersionCode(name)) ? name : `${name} (versionCode ${code})`;
    },
    set: (src, v) =>
      src.replace(propName, `$1${v}`).replace(propCode, `$1${androidVersionCode(v)}`),
  });

  return list;
}

function usage(code = 2) {
  console.error("Usage: node scripts/version.mjs <sync|check> [x.y.z]");
  process.exit(code);
}

const [cmd, wanted] = process.argv.slice(2);
if (cmd !== "sync" && cmd !== "check") usage();

const rootVersion = JSON.parse(read(path.join(ROOT, "package.json"))).version;
const target = wanted ?? rootVersion;
if (!SEMVER.test(target)) {
  console.error(`Invalid version: ${target}`);
  process.exit(2);
}

const locs = locations();
let bad = 0;

if (cmd === "check") {
  for (const loc of locs) {
    if (!existsSync(loc.file)) {
      if (!loc.optional) {
        console.error(`MISSING ${loc.label}`);
        bad++;
      }
      continue;
    }
    const found = loc.get(read(loc.file));
    if (found == null) {
      if (!loc.optional) {
        console.error(`??      ${loc.label}: version not found`);
        bad++;
      }
      continue;
    }
    if (found !== target) {
      console.error(`MISMATCH ${loc.label}: ${found} (expected ${target})`);
      bad++;
    } else {
      console.log(`ok      ${loc.label}: ${found}`);
    }
  }
  if (bad) {
    console.error(`\n${bad} mismatch(es). Align with: node scripts/version.mjs sync ${target}`);
    process.exit(1);
  }
  console.log(`\nEverything at ${target}.`);
  process.exit(0);
}

// sync: grouped by file, so Cargo.lock is read and written only once.
const byFile = new Map();
for (const loc of locs) {
  if (!existsSync(loc.file)) continue;
  if (!byFile.has(loc.file)) byFile.set(loc.file, []);
  byFile.get(loc.file).push(loc);
}
for (const [file, group] of byFile) {
  const before = read(file);
  let src = before;
  for (const loc of group) {
    const found = loc.get(src);
    if (found == null) {
      if (!loc.optional) console.warn(`warning: ${loc.label}: version not found, skipping`);
      continue;
    }
    src = loc.set(src, target);
    console.log(`${found === target ? "=" : "→"} ${loc.label}: ${found} → ${target}`);
  }
  if (src !== before) writeFileSync(file, src);
}
console.log(`\nVersion ${target} written. Check: node scripts/version.mjs check`);

# Development

How to build, run, test and package RE-KORD from source. For the layout of the code, read
[architecture.md](architecture.md) first.

- [Prerequisites](#prerequisites)
- [First run](#first-run)
- [Everyday commands](#everyday-commands)
- [Tests and checks](#tests-and-checks)
- [Desktop shell](#desktop-shell)
- [Android](#android)
- [Packaging](#packaging)
- [Versioning](#versioning)
- [Release checklist](#release-checklist)

## Prerequisites

| Tool | Version | Needed for |
|---|---|---|
| Rust | recent stable (CI uses `stable`) | hub, desktop and Android shells |
| Node.js | 20 or newer (CI uses 22) | client, admin panel, scripts |
| pnpm | 9.15 (`corepack enable` picks it up from `package.json`) | workspace |
| ffmpeg | any recent | transcode and preview tests, Cast, WMA/AIFF/ALAC playback |
| Docker | any recent | packaging Linux and Windows builds |

For the **desktop shell** you also need the
[Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/). On Debian/Ubuntu:

```bash
sudo apt install build-essential pkg-config libwebkit2gtk-4.1-dev libgtk-3-dev \
  libayatana-appindicator3-dev librsvg2-dev libdbus-1-dev libssl-dev libsoup-3.0-dev \
  patchelf file
```

For **Android**: Android SDK and NDK, and JDK 17 or newer. See [Android](#android).

## First run

```bash
git clone https://github.com/Creiv/RE-KORD.git && cd RE-KORD
corepack enable
pnpm install
pnpm build:ui          # client and admin panel, so the hub can serve them
pnpm run server        # cargo run -p rekord-server
```

Open `http://127.0.0.1:7420/admin`, choose a music folder and run a scan, then open
`http://127.0.0.1:7420/`. The hub listens on `0.0.0.0:7420`; use
`REKORD_BIND=127.0.0.1:7420 pnpm run server` to keep it on this machine.

A development hub stores its data in the default data folder (`~/.local/share/RE-KORD` on
Linux). To keep it apart from a real install:

```bash
pnpm run server -- --data-dir /tmp/rekord-dev --music-root ~/Music
```

`pnpm run server -- --help` lists every flag and its environment variable. Always write
`pnpm run server`: plain `pnpm server` is a built-in pnpm command, not this script.

## Everyday commands

Run the hub and the UIs with hot reload in separate terminals:

```bash
pnpm run server        # hub API on :7420
pnpm dev:hub           # hub + client UI + admin panel together (no Tauri, no GTK dev packages)
pnpm dev:client-ui     # client on http://localhost:7422 (proxies /api and /media to :7420)
pnpm dev:server-ui     # admin panel on http://localhost:7421/admin/
pnpm dev:client        # the Tauri desktop shell around the client dev server
```

`pnpm dev:hub` runs `cargo run -p rekord-server` and both Vite servers with prefixed output; Ctrl+C
stops all three. Extra arguments go to the hub (`pnpm dev:hub -- --data-dir <dir>`). Without one,
it uses `REKORD_DATA_DIR`, else on Linux the RE-KORD Server app's data
(`~/.local/share/app.rekord.server/hub`) when present. It refuses to start if 7420–7422 are taken.

The dev servers' origins are on the hub's allow list, so they work against a local hub
without extra configuration.

| Command | What it does |
|---|---|
| `pnpm build:ui` | Builds `apps/client-ui/dist` and `apps/server-ui/dist` |
| `pnpm build:server` | `cargo build -p rekord-server --release` |
| `pnpm build:client` | Desktop client bundle (`target/release/bundle/`) |
| `pnpm build:client:server-flavor` | RE-KORD Server: client plus embedded hub |
| `pnpm dev:client:server-flavor` | The same, in development mode |
| `pnpm docker:build` | Builds the `rekord:<version>` image |
| `pnpm fetch:tools` | Downloads verified yt-dlp, QuickJS-ng (`qjs`), cloudflared and ffmpeg into `release/bin/<platform>/` |

In debug builds the hub also looks for tools in `release/bin/<platform>/`, so after
`pnpm fetch:tools` a development hub uses the same versions as the packages.

## Tests and checks

Run these before opening a pull request. CI (`.github/workflows/ci.yml`) runs the same.

```bash
node scripts/version.mjs check                     # one version everywhere
cargo fmt --all --check
cargo clippy --workspace --exclude rekord-client --all-targets --locked -- -D warnings
cargo test --workspace --exclude rekord-client --locked
pnpm -r --if-present check                         # svelte-check on every package
pnpm -r --if-present test                          # client and admin unit tests, i18n parity
pnpm build:ui
```

`pnpm test` runs the JavaScript tests and `cargo test` together; `pnpm check` runs the
type checks.

- Rust integration tests live in `crates/core/tests/` (HTTP permissions, CORS, media,
  downloads, scans, legacy merge, schema migration, and more). Some media tests need
  `ffmpeg` on `PATH`.
- Client tests are `apps/client-ui/src/lib/*.test.mjs`, run with Node's built-in test
  runner. `i18nTables.test.mjs` fails when the Italian, English and German tables differ.
- The shell crate (`rekord-client`) needs WebKitGTK, so it is excluded from the workspace
  commands above. To check it:

  ```bash
  pnpm build:ui
  cargo clippy -p rekord-client --locked -- -D warnings
  cargo clippy -p rekord-client --features hub --locked -- -D warnings
  ```

## Desktop shell

`apps/client-shell/src-tauri` is a Tauri 2 app.

- `tauri.conf.json`: the client (`app.rekord.client`, product name "RE-KORD").
- `tauri.hub.conf.json`: overrides for the server flavor (`app.rekord.server`, product
  name "RE-KORD Server", binary `rekord-server-app`), used with `--features hub`.
- The window loads the bundled client. On start-up the client probes the saved hub address,
  the page origin and `http://127.0.0.1:7420`, so a shell running next to a hub connects
  on its own.

## Android

The Android project lives in `apps/client-shell/src-tauri/gen/android` and is versioned:
it contains hand-written Kotlin (media service, Cast, file saving) and manifest changes.
[ANDROID.md](ANDROID.md) explains what is in it and why.

Requirements: Android SDK and NDK, JDK 17+. CI uses NDK `28.2.13676358`, platform
`android-36` and build-tools `36.0.0`. `scripts/lib/android-env.sh` finds the SDK
(`ANDROID_HOME`, `ANDROID_SDK_ROOT`, `~/Android/Sdk`), picks the newest NDK unless
`NDK_HOME` is set, checks the JDK and installs missing Rust Android targets.

```bash
pnpm android:init               # toolchain check; regenerates gen/android if it was deleted
pnpm android:build              # debug APK, arm64, debug key
pnpm android:build --install    # ... and install it on the connected device (adb)
pnpm android:dev                # tauri android dev on a device or emulator
pnpm android:apk                # release, one APK per ABI (needs a keystore)
pnpm pack:android               # release/android/RE-KORD-Client-<v>-android-arm64.apk
```

`bash scripts/android-build.sh --help` lists all flags. Release signing uses
`gen/android/keystore.properties`; without it, `pack:android` signs with the debug key.
See [ANDROID.md](ANDROID.md#signing-a-release-apk).

## Packaging

One command per platform and flavor. Packages land in `release/<platform>/` together with
`SHA256SUMS` and a full `build.log`.

| Command | Output |
|---|---|
| `pnpm pack:linux:server` | `RE-KORD-Server-<v>-linux-x64.AppImage`, `.deb`, and `RE-KORD-Server-<v>-linux-x64-headless.tar.gz` |
| `pnpm pack:linux:client` | `RE-KORD-Client-<v>-linux-x64.AppImage`, `.deb` |
| `pnpm pack:win:server` | `RE-KORD-Server-<v>-windows-x64.zip` (portable folder with `RE-KORD Server.exe`) |
| `pnpm pack:win:client` | `RE-KORD-Client-<v>-windows-x64.exe` (single portable executable) |
| `pnpm pack:android` | `RE-KORD-Client-<v>-android-arm64.apk` |
| `pnpm pack:all` | All of the above |
| `pnpm pack:macos` | On a Mac only: hub tarball and client `.dmg` (not part of the official release set) |

The underlying script is `scripts/pack.sh <linux|windows|android|all> [server|client|all]`
(`bash scripts/pack.sh --help`). Append options directly, without a `--` separator
(`pnpm pack:linux:server --no-tools`):

- `--no-tools`: server packages without yt-dlp, qjs, cloudflared and ffmpeg (the hub then
  uses the copies on `PATH`).
- `--native`: build with the local toolchain instead of Docker.

How it works:

- **Bundled tools.** Server packages include yt-dlp, QuickJS-ng (`qjs`, MIT; yt-dlp's
  JavaScript runtime for YouTube), cloudflared and ffmpeg (LGPL build), downloaded from
  the official releases at pinned versions and verified against
  `scripts/third-party.sha256`.
- **Docker builder.** Linux and Windows builds run inside
  `scripts/docker/builder.Dockerfile` (Ubuntu 24.04 with WebKitGTK, GStreamer and
  cargo-xwin). The host only needs Docker. The first run builds the image, which takes a
  few minutes; caches live in `~/.cache/rekord-builder` (`REKORD_BUILDER_CACHE`). The
  image tag follows the Dockerfile's hash, so editing it rebuilds the image. A Linux build
  skips Docker on its own when the host already has the `webkit2gtk-4.1` and `dbus-1`
  development packages; the packages then link against the host's glibc.
- **Windows from Linux.** cargo-xwin downloads the Microsoft CRT and Windows SDK on first
  use, which means accepting Microsoft's license.
- **glibc.** Because the builder is Ubuntu 24.04, the Linux AppImage and `.deb` need glibc
  2.39 or newer.
- **Android** uses the local SDK/NDK, not Docker.

## Versioning

One version for everything: `package.json` files, the Cargo workspace, `Cargo.lock` and
`apps/client-ui/src/lib/version.ts`.

```bash
pnpm version:sync 5.0.1   # write the version everywhere
pnpm version:check        # verify (also in CI and at the start of every pack)
```

`tauri.conf.json` has no version: Tauri reads it from `Cargo.toml`, and the Android
`versionCode` derives from it (5.0.0 becomes 5000000).

The hub reports `version`, `apiVersion` and `minClientVersion` in `/api/v1/health`.
`API_VERSION` and `MIN_CLIENT_VERSION` are in `crates/core/src/api.rs`: raise
`MIN_CLIENT_VERSION` only when older native clients can no longer work with the hub.

## Release checklist

1. Update `CHANGELOG.md`.
2. `pnpm version:sync <x.y.z>`, then `pnpm version:check`.
3. Run every check in [Tests and checks](#tests-and-checks), plus the shell clippy.
4. `pnpm pack:all` (and `pnpm pack:linux:server` alone if you only need the hub).
5. Smoke-test the packages:
   - Linux AppImage and `.deb`, Server and Client: first run, choose a library, scan, play
     MP3, FLAC and a WMA or AIFF file, seek.
   - Windows Server zip and Client exe on a clean Windows 10/11.
   - Android APK on a device: connect by QR, background playback with the screen off,
     notification controls, Cast to a Chromecast.
   - Desktop client against a hub on another LAN machine over plain HTTP, to rule out
     mixed-content blocking (see [upgrading-from-legacy.md](upgrading-from-legacy.md#known-issue-desktop-apps-and-plain-http-hubs)).
   - Web client from another LAN machine at `http://<lan-ip>:7420` (not a secure context:
     `crypto.randomUUID` and other HTTPS-only APIs are missing): play a track and start a
     Studio download.
   - `docker compose up -d --build`, health check green.
6. Verify the release signing key (`apksigner verify --print-certs`) is the same as the
   previous release.
7. Tag the release, create the GitHub release, and upload the files from `release/*/`
   together with each `SHA256SUMS`.
8. Update the download links on [re-kord.com](https://re-kord.com).

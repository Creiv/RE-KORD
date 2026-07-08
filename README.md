<p align="center">
  <img src="public/REKORDlogo.png" alt="RE-KORD" width="128" />
</p>

<p align="center">
  <a href="https://re-kord.com"><strong>re-kord.com</strong></a>
  &nbsp;·&nbsp;
  <a href="https://www.reddit.com/r/RE_KORD/"><strong>r/RE_KORD</strong></a>
</p>

<h1 align="center">RE-KORD 5.0</h1>

<p align="center">
  <strong>Your music. Your server. Your rules.</strong><br />
  A self-hosted music hub that turns a folder of audio files into a complete
  listening, curation, and play experience — on your disk, on your network,
  under your control.
</p>

<p align="center"><em>UI in English and Italian · exact semver in <code>package.json</code></em></p>

---

## What is RE-KORD

RE-KORD is **not a cloud service** — it's a home for your audio. Point it at a
folder and it becomes your personal music server: a fast library with rich
metadata, a serious player with visualizers and synced lyrics, studio tools to
grow and maintain your collection, and even a rhythm game generated from your
own tracks. Everything stays on your machine; every device on your network can
join in.

One install gives you the **server + web app**. Around it: a **desktop app**
(Server or thin Client), a **Docker image**, an installable **PWA**, and — since
4.0 — a native **Android client**.

## Highlights

🎧 **Listen like you mean it**
Persistent player with queue, smart shuffle, repeat and crossfade; synced
**LRC lyrics**; 8 audio-reactive **visualizers** (bars, waves, DiscoWall,
karaoke…); **sleep timer** with 30s fade-out; **Cast to Google Home**
(Chrome + Android APK); OS media integration (lock screen, headphone and car
controls, Android Auto-friendly).

🗂️ **A library that stays healthy**
Browse by artist, genre, or **mood**; instant search; quality alerts for
missing covers and metadata; per-track and per-album metadata editors;
multi-source artwork and trivia lookup; bulk scans and title cleanup. The
library index and album/track metadata live in a local **SQLite** database
(`rekord.db`) with cached artwork thumbnails and filesystem watching.

🛠️ **Studio built in**
Discover and download new music (bundled `yt-dlp`), enrich metadata from
MusicBrainz/iTunes and friends, manage covers, curate a per-profile catalog —
all from the same UI, with the library re-indexed automatically.

🎮 **Plectr**
A rhythm game charted on the fly from *your* tracks: three difficulties,
holds and swipes, per-track records, and live sync with whatever is playing.

📊 **Know your habits**
Play counts, top artists/albums/genres, favorites, listening streaks — plus an
achievements system with XP, levels, and 60+ badges.

🎨 **Make it yours**
18 theme presets plus a fully custom theme (colors or background image),
a unified **Pro Workspace** layout (icon rail, flat surfaces, organized
canvas), **glass surfaces with adjustable opacity**, and **shareable themes**:
export your look as a file, import it on any other server or profile.

🌐 **Anywhere you are**
LAN access out of the box, one-click **Cloudflare tunnel** with QR code for
remote listening, multiple local profiles, full **backup/restore**, and a
self-updating client model: update the server once, every client follows.

## New in 5.0

Major stability and quality release: safer runtime, better test coverage, clearer
architecture, and improved operability — without changing what RE-KORD does for
your music.

- 🏗️ **Structural refactor** — Studio split into lazy panels (`StudioView`:
  Catalog, Download, Enrichment, Maintenance, Album editor); API client split by
  domain; Library and Settings as section shells; player logic extracted into
  `src/player/` modules.
- 🛡️ **Reliability** — graceful shutdown (drain writes, close HTTP/DB/watchers);
  optimistic **user-state revision** with conflict detection (HTTP 409); SQLite
  WAL mode; in-process **job queue** with `/api/jobs` status API.
- 🔍 **Observability** — structured logging (Pino) with request IDs;
  **Diagnostics** panel in Settings (`/api/diagnostics`: version, uptime, DB
  health, recent errors, job list).
- 🧪 **Quality gates** — GitHub Actions CI (lint, typecheck, 367+ unit tests,
  integration tests, Playwright E2E); version sync script across package,
  Android, Docker.
- 📴 **Offline PWA** — service worker caches the app shell and static assets;
  offline banner in the UI (API and media stay network-only).
- 🏷️ **Naming cleanup** — one-shot migration of legacy `kord-*` / `wpp-*`
  localStorage keys to `rekord-*` on first launch.
- 📖 **Docs** — [CHANGELOG.md](CHANGELOG.md) and [upgrade guide](docs/UPGRADE-5.0.md).

See [docs/FEATURES.md](docs/FEATURES.md) for the full feature map.

## Since 4.4

- 🖼️ **Instant covers** — real 128/256px thumbnails generated server-side with
  the bundled ffmpeg (no extra dependencies): album grids and cards load
  kilobytes instead of megabytes, with automatic backfill for existing
  libraries at startup.

## Since 4.3

- 🌌 **Sonic Nebula** — explore your library as an interactive galaxy: every
  track is a star positioned by BPM (horizontal) and energy (vertical), with
  colored nebulae for mood clusters; pan, zoom, fullscreen; click to play,
  Shift+click for local radio; new **Nebula** tab in Library plus a dashboard
  card with live mini-preview.
- 📻 **Smart Radio on Dashboard** — quick-listen grid built from recent plays
  and favorites (one track per album, up to 19 tiles + Random); start smart
  radio from any tile or jump to Studio.
- 📲 **APK background resilience** — when the Android client returns from
  background, automatic server health probe and state refresh; unreachable-server
  gate with manual retry; reconnect on visibility, online, and Capacitor
  `appStateChange`.

## Since 4.2

- 📂 **Adaptive library scan** — detects how your music folder is organized
  (`artist/album/track`, loose tracks per artist, flat files, or ID3 tags) and
  indexes accordingly; layout config in `.kord/library-layout.json`; structure
  probe when setting `MUSIC_ROOT`.
- 🧭 **Real vs logical paths** — loose tracks keep the on-disk path (`file_path`)
  separate from the library path (`rel_path`); albums store `folder_rel_path`
  for the actual folder; incremental scans diff against a `files` table.
- 🔄 **Loose-track migration** — schema v6 aligns legacy `Tracce` → `Tracks`
  paths in SQLite; client state migrates old loose paths in queue, favorites,
  and recent plays.
- 💿 **Discogs integration** — optional personal token (Settings or
  `REKORD_DISCOGS_TOKEN`); release search with scored candidates and a picker
  when several matches exist; album enrichment (label, country, genres, format,
  catalog no., community stats, lowest price); tracklist applied to files
  (track/disc numbers, duration); automatic fallback to MusicBrainz / TheAudioDB
  / iTunes when Discogs is unavailable.

## Since 4.1

- 🗄️ **SQLite library core** — `MUSIC_ROOT/.kord/rekord.db` is the source of
  truth for the library index, album/track metadata, and artwork thumbnails.
  One-shot bootstrap from the legacy JSON cache or a full filesystem scan on
  first run.
- 🖼️ **Artwork cache** — cover images copied into `.kord/artwork/` and served
  from `/api/library/artwork/:id`; falls back to `/api/cover` on disk when needed.
- 🧹 **Library metadata cleanup** — Studio → Tools migrates useful fields from
  legacy JSON sidecars into the DB, removes per-track sidecars, and compacts
  album files (trivia/`infoItems` stay on disk).
- 📂 **Track order by filename** — album track lists follow download/filename
  order; tag-based track numbers are no longer used for sorting.
- 🔁 **Watcher + epochs** — filesystem changes trigger rescans; clients poll
  `/api/library/changes` for index updates. Paginated library APIs are ready
  for large collections.
- 🔊 **Cast to Google Home** — stream to Chromecast/speakers from Chrome on
  LAN or the Android APK. Lossless formats the speaker can't decode (FLAC,
  OGG, WAV…) are transcoded on the fly via bundled **ffmpeg**.
- ⏱️ **Sleep timer** — fade out over 30 seconds then stop; presets or a
  custom duration (1 min – 12 h) from the Listen view.
- 📲 **ExoPlayer on Android** — optional native playback in the APK
  (Settings); disables crossfade, falls back to WebView audio on error.
  Foreground **MediaService** keeps playback alive in the background.
- 🎮 **Plectr on low-end devices** — lighter canvas backdrop, smoother song
  clock sync, less stutter while charts generate in a Web Worker.
- 📡 **Large FLAC over tunnel** — robust HTTP **Range** streaming for big
  lossless files through the Cloudflare tunnel (seek-friendly).
- 🖥️ **Pro Workspace UI** — redesigned shell: 56px icon rail, flat card
  surfaces, content canvas with max-width — the old Classic/Modern style
  toggle is gone; one consistent layout for everyone.

## Since 4.0

- 📱 **Android client (APK)** — connects to your server like the desktop
  client, with **QR pairing** straight from Settings → Network: scan, pick a
  profile, play. Native playback widget and media controls, portrait-locked,
  hardware back navigation.
- 🎨 **Theme sharing** — one-click theme export (colors, glass, background
  image) into a portable file anyone can import.
- 🪟 **Adjustable glass** — a transparency slider for glass surfaces, with
  text contrast that adapts automatically.
- 📐 **Mobile, polished** — every page reviewed and tightened for phones:
  full-height layout on every device, stacked toolbars, denser dashboards,
  instant cover placeholders.
- 🖥️ **Cross-platform packaging fixes** — proper app icon on Windows builds
  made from Linux, one-command Android packaging.

## Get RE-KORD

| Flavor | What it is | How |
| --- | --- | --- |
| **Server** (desktop) | Full app: server + UI + bundled yt-dlp/cloudflared | Downloads on [re-kord.com](https://re-kord.com) |
| **Client** (desktop) | Thin UI that connects to an existing server | Downloads on [re-kord.com](https://re-kord.com) |
| **Android client** | Native APK, QR pairing, media widget | `npm run pack:android:client` → `release/` |
| **Docker** | Single container: server + built UI | See below |
| **PWA** | Install the web app from any browser on your network | Open the server URL → install |

### Docker quick start

```bash
cp .env.docker.example .env       # set REKORD_MUSIC_HOST to your music folder
npm run docker:build && npm run docker:up
# → http://localhost:3001
```

Bind mounts: `REKORD_MUSIC_HOST → /music` (library) and
`REKORD_CONFIG_HOST → /config` (accounts, settings, cookies). Useful knobs:
`REKORD_PORT`, `REKORD_LISTEN_HOST=127.0.0.1` (loopback only), `MUSIC_ROOT`
(lock the library path).

### From source

```bash
npm install
npm run dev          # browser: Vite :5173 + API :3001
npm run dev:app      # Electron desktop + server

npm test && npm run lint && npm run build

# optional quality gates
npm run test:integration   # API integration (supertest)
npm run test:e2e           # Playwright (needs build + server)
npm run check:version      # package.json vs Gradle vs Docker
```

On a fresh **Ubuntu/Debian** machine, if `npm run dev` fails on `better-sqlite3`,
install build tools then rebuild the native module:

```bash
sudo apt update && sudo apt install -y build-essential python3
npm run rebuild:native:dev
```

If the **AppImage** opens but shows “cannot reach the server”, check
`~/.config/rekord/rekord-server.log`. A common cause on external drives is
**EACCES** (library folder not writable): RE-KORD needs to create `MUSIC_ROOT/.kord/`.
Fix permissions, e.g. `sudo chown -R $USER:$USER /path/to/music`, then restart.

Library root: `MUSIC_ROOT` env or in-app Settings. Per-profile state and the
library database live in `MUSIC_ROOT/.kord/` (`rekord.db` plus account data) and
survive reinstalls. Upgrading from 4.x? See [docs/UPGRADE-5.0.md](docs/UPGRADE-5.0.md).
After upgrading from 4.0, run **Library metadata cleanup**
once in Studio → Maintenance to migrate legacy JSON sidecars.

### Packaging 5.0

```bash
npm run pack:linux:server -- 5.0.0   # → release/RE-KORD-Server-5.0.0-linux-x86_64.AppImage
npm run pack:win:server  -- 5.0.0    # Windows server (NSIS on Windows hosts, .7z from Linux)
npm run pack:linux:client -- 5.0.0   # thin desktop client
npm run pack:win:client  -- 5.0.0
npm run pack:android:client -- 5.0.0 # → release/RE-KORD-Client-5.0.0-android.apk
npm run sync:version                 # propagate version from package.json
```

Server packs bundle **yt-dlp** and **cloudflared** for the target OS. Windows
builds made from Linux get the correct app icon automatically. On Linux
without `libfuse2`, run AppImages via `./scripts/run-linux-appimage.sh`.

## Tech, in one line

React 19 + Vite on the front, Express + **SQLite** (`better-sqlite3`) on the
back, Electron for desktop, Capacitor for Android, Docker for servers — a single
codebase, local-first storage, no telemetry.

## Disclaimer

RE-KORD and its creators **are not responsible** for what users download,
import, or manage. Each user is **solely responsible** for copyright and local
law compliance. Use only content you have the rights or permission to use.

---

<p align="center"><em>RE-KORD 5.0 by Creiv — local music, serious tools, play on the beat.</em></p>

<p align="center">
  <img src="public/REKORDlogo.png" alt="RE-KORD" width="128" />
</p>

<p align="center">
  <a href="https://re-kord.com"><strong>re-kord.com</strong></a>
  &nbsp;·&nbsp;
  <a href="https://www.reddit.com/r/RE_KORD/"><strong>r/RE_KORD</strong></a>
</p>

<h1 align="center">RE-KORD 4.0</h1>

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
(Server or thin Client), a **Docker image**, an installable **PWA**, and — new
in 4.0 — a native **Android client**.

## Highlights

🎧 **Listen like you mean it**
Persistent player with queue, smart shuffle, repeat and crossfade; synced
**LRC lyrics**; 8 audio-reactive **visualizers** (bars, waves, DiscoWall,
karaoke…); OS media integration (lock screen, headphone and car controls,
Android Auto-friendly).

🗂️ **A library that stays healthy**
Browse by artist, genre, or **mood**; instant search; quality alerts for
missing covers and metadata; per-track and per-album metadata editors;
multi-source artwork and trivia lookup; bulk scans and title cleanup.

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
classic/modern UI styles, **glass surfaces with adjustable opacity**, and
**shareable themes**: export your look as a file, import it on any other
server or profile.

🌐 **Anywhere you are**
LAN access out of the box, one-click **Cloudflare tunnel** with QR code for
remote listening, multiple local profiles, full **backup/restore**, and a
self-updating client model: update the server once, every client follows.

## New in 4.0

- 📱 **Android client (APK)** — connects to your server like the desktop
  client, with **QR pairing** straight from Settings → Network: scan, pick a
  profile, play. Native playback widget and media controls, portrait-locked,
  hardware back navigation.
- 🎨 **Theme sharing** — one-click theme export (colors, style, glass,
  background image) into a portable file anyone can import.
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
```

Library root: `MUSIC_ROOT` env or in-app Settings. Per-profile state lives in
`MUSIC_ROOT/.kord/` and survives reinstalls.

### Packaging 4.0

```bash
npm run pack:linux:server -- 4.0.0   # → release/RE-KORD-Server-4.0.0-linux-x86_64.AppImage
npm run pack:win:server  -- 4.0.0    # Windows server (NSIS on Windows hosts, .7z from Linux)
npm run pack:linux:client -- 4.0.0   # thin desktop client
npm run pack:win:client  -- 4.0.0
npm run pack:android:client -- 4.0.0 # → release/RE-KORD-Client-4.0.0-android.apk
```

Server packs bundle **yt-dlp** and **cloudflared** for the target OS. Windows
builds made from Linux get the correct app icon automatically. On Linux
without `libfuse2`, run AppImages via `./scripts/run-linux-appimage.sh`.

## Tech, in one line

React 19 + Vite on the front, Express on the back, Electron for desktop,
Capacitor for Android, Docker for servers — a single codebase, no external
database, no telemetry.

## Disclaimer

RE-KORD and its creators **are not responsible** for what users download,
import, or manage. Each user is **solely responsible** for copyright and local
law compliance. Use only content you have the rights or permission to use.

---

<p align="center"><em>RE-KORD 4.0 by Creiv — local music, serious tools, play on the beat.</em></p>

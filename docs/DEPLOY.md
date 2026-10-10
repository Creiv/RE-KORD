# Deploying the RE-KORD hub

Reference for running the hub as a service: configuration, systemd, Docker, the desktop
server flavor and reverse proxies. For step-by-step installation per platform, start with
[install.md](install.md).

Every deployment exposes the web client at `http://<host>:7420/` and the admin panel at
`/admin`. Configuration is the same everywhere: `rekord-server --help` lists every flag
with its environment variable.

## Configuration

### Command-line flags

| Flag | Environment | Default | Meaning |
|---|---|---|---|
| `--bind` | `REKORD_BIND` | `0.0.0.0:7420` | Listen address. `127.0.0.1:7420` keeps the hub on this machine. |
| `--data-dir` | `REKORD_DATA_DIR` | see below | Database, settings, accounts, caches |
| `--music-root` | `REKORD_MUSIC_ROOT` | unset | Library root. Can also be set from `/admin`. |
| `--client-ui` | `REKORD_CLIENT_UI` | next to the binary | Built client, served at `/` |
| `--admin-ui` | `REKORD_ADMIN_UI` | next to the binary | Built admin panel, served at `/admin` |
| `--modules-manifest` | `REKORD_MODULES_MANIFEST` | `<data dir>/modules.manifest.toml` | Module manifest (see [MODULES.md](MODULES.md)) |
| `--prevent-sleep` | `REKORD_PREVENT_SLEEP` | admin panel setting (`off`) | Keep the computer from sleeping: `off`, `always`, `when-active`. Locks the mode in the admin panel. See [Keeping the computer awake](#keeping-the-computer-awake). |
| `--restore-zip <zip>` | `REKORD_RESTORE_ZIP` | | Restore a backup ZIP (v2 legacy or v3) before serving |
| `--restore-exit` | | | Exit after `--restore-zip` |
| `--legacy-import` (`--sync-legacy-meta`) | | | Merge data from a legacy `<music root>/.kord` folder before serving; prints the report |
| `--legacy-import-dry-run` | | | With `--legacy-import`: print what would be imported, write nothing, exit |
| `--legacy-import-force` | | | With `--legacy-import`: merge again accounts already imported from the same files |
| `--legacy-import-exit` (`--sync-legacy-exit`) | | | Exit after `--legacy-import` |

The default data directory is `RE-KORD` inside the platform's data folder:
`~/.local/share/RE-KORD` on Linux, `%APPDATA%\RE-KORD` on Windows,
`~/Library/Application Support/RE-KORD` on macOS.

`--client-ui` and `--admin-ui` fall back to `client-ui/` (or `web/`) and `admin-ui/` next
to the executable, then to `apps/client-ui/dist` and `apps/server-ui/dist` in the current
directory. When no client bundle is found, the admin panel also answers on `/`.

### Environment only

| Variable | Default | Meaning |
|---|---|---|
| `REKORD_ALLOW_REMOTE_ADMIN` | `0` | `1` allows library and machine operations from non-local clients (see [SECURITY.md](../SECURITY.md)) |
| `REKORD_ALLOWED_ORIGINS` | | Extra browser origins allowed by the origin policy, comma separated (see [API.md](API.md#cors)) |
| `REKORD_PUBLIC_URL` | | Public HTTPS URL when the hub is behind your own reverse proxy. Shown and encoded in the QR code instead of a Cloudflare tunnel URL. |
| `REKORD_WATCH_LIBRARY` | `1` | `0` disables the filesystem watcher (rescans then run only on demand) |
| `ENABLE_YTDLP` | `1` | `0` disables Studio downloads |
| `YTDLP_PATH` | | yt-dlp executable |
| `REKORD_FFMPEG` | | ffmpeg executable (`FFMPEG_PATH` and `REKORD_FFMPEG_BIN` are also accepted) |
| `REKORD_CLOUDFLARED_BIN` | | cloudflared executable |
| `REKORD_TOOLS_DIR` | | Extra folder searched for the three tools |
| `REKORD_YTDLP_COOKIES` | | YouTube cookies file for yt-dlp; locks the setting in the admin panel |
| `REKORD_YTDLP_JS_RUNTIME` | auto | JavaScript runtime passed to yt-dlp (`deno:<path>`, `node:<path>`, or `none`) |
| `REKORD_DISCOGS_TOKEN` | | Discogs personal token; locks the setting in the admin panel |
| `LASTFM_API_KEY` | | Adds Last.fm biographies to curiosità searches |
| `THEAUDIODB_API_KEY` | public test key | TheAudioDB key |
| `REKORD_SKIP_LEGACY_IMPORT` | | `1` disables the automatic one-time import of a legacy `.kord` folder |
| `REKORD_SKIP_LEGACY_CONFIG_IMPORT` | | `1` disables the one-time import of legacy credentials (Discogs token, YouTube cookies) |
| `RUST_LOG` | `info,tower_http=info` | Log filter |

### External tools

| Tool | Used for | Required |
|---|---|---|
| ffmpeg | Cast transcodes, FLAC copies of WMA/AIFF/ALAC, durations of WMA/WebM, previews | Recommended |
| yt-dlp | Studio downloads and Discover previews | Optional |
| cloudflared | The remote-access tunnel | Optional |

The Server packages and the Docker image include all three, downloaded from the official
releases at pinned versions and checked against `scripts/third-party.sha256`. Each tool is
looked up in the configured path, the bundled copies and `PATH`; when several exist the
newest version wins. The admin panel's *Diagnostics* page and `GET /api/v1/diagnostics`
show which copy is in use. The details are in [API.md](API.md#tools-yt-dlp-ffmpeg-cloudflared).

yt-dlp can be updated without reinstalling (client: *Settings › System › Update yt-dlp*,
or `POST /api/v1/tools/ytdlp/update`): the hub downloads the latest official release,
verifies its checksum and installs it in `<data dir>/tools/`.

## Linux, systemd

```bash
tar -xzf RE-KORD-Server-5.1.0-linux-x64-headless.tar.gz
cd RE-KORD-Server-5.1.0-linux-x64-headless
sudo ./systemd/install.sh            # /opt/rekord, data in /var/lib/rekord, user "rekord"
sudoedit /etc/default/rekord-server  # REKORD_MUSIC_ROOT, REKORD_BIND, ...
sudo systemctl restart rekord-server
journalctl -u rekord-server -f
```

To build the package yourself: `pnpm pack:linux:server` writes it to `release/linux/`.

`install.sh` creates the `rekord` system user, copies the program to `/opt/rekord`
(`PREFIX` overrides it), installs `rekord-server.service` and, the first time only,
`/etc/default/rekord-server` (`DATA` overrides `/var/lib/rekord`). Running it again from a
newer package stops the service, replaces the program files and starts it again; data and
`/etc/default/rekord-server` are kept.

The unit is hardened (`ProtectSystem=strict`, `ProtectHome=read-only`, `NoNewPrivileges`,
`PrivateTmp`, `PrivateDevices`, kernel protections) and may only write `/var/lib/rekord`.

- **Add your music folder to `ReadWritePaths=`** (`sudo systemctl edit rekord-server`) if
  you use Studio, cover downloads or deletions.
- For a library under `/home`, also set `ProtectHome=false`.
- The service stops with `SIGTERM` and closes the database cleanly (timeout 20 s).
- To let the service keep the computer awake, install the polkit rule:
  `sudo cp systemd/50-rekord-power.rules /etc/polkit-1/rules.d/` (see
  [Keeping the computer awake](#keeping-the-computer-awake)).

Manual installation without the script: the steps are in the header of
`scripts/linux/rekord-server.service`.

## Docker

```bash
curl -O https://raw.githubusercontent.com/Creiv/RE-KORD/main/docker-compose.yml
REKORD_MUSIC_HOST=/path/to/Music docker compose up -d
docker compose logs -f
```

Compose pulls `ghcr.io/creiv/re-kord:latest`, published for amd64 and arm64 by the
*Build Docker Image* workflow (`.github/workflows/docker.yml`) on every release tag (`v*`),
or by hand from the Actions tab. Tags: `latest`, the version (`5.1.0`) and the release tag
(`v5.1`); pin one in the compose file to stay on a release. Update with
`docker compose pull && docker compose up -d`. To build locally instead, uncomment `build:`
in `docker-compose.yml` and add `--build`.

The multi-stage `Dockerfile` builds the UIs with pnpm and `rekord-server` in release mode,
fetches yt-dlp and cloudflared at pinned versions with checksum verification, and runs on
`debian:bookworm-slim` with ffmpeg and tini. The image runs as a non-root user (uid
10001), declares the volumes `/data` and `/music`, and has a `HEALTHCHECK` on
`/api/v1/health`. The build arguments `YTDLP_VERSION` and `CLOUDFLARED_VERSION` override
the pinned versions. `amd64` and `arm64` are supported.

`docker-compose.yml` settings: `REKORD_PORT`, `REKORD_DATA_HOST`, `REKORD_MUSIC_HOST`,
`REKORD_ALLOW_REMOTE_ADMIN` and `TZ`, read from the environment or from a `.env` file. Other
variables (`REKORD_ALLOWED_ORIGINS`, `REKORD_PUBLIC_URL`, `REKORD_YTDLP_COOKIES`, ...) are
listed, commented out, in the compose file.

Sleep prevention is not available inside a container (no systemd-logind); run the hub
directly on the host if the machine must stay awake.

Inside a container no request is local, so machine operations need either
`docker exec rekord curl -X POST http://127.0.0.1:7420/api/v1/library/scan`, or
`REKORD_ALLOW_REMOTE_ADMIN=1` on a trusted network.

## Windows and macOS (portable hub)

- **Windows**: `RE-KORD-Server-<v>-windows-x64.zip` (`pnpm pack:win:server`) is a folder
  with `RE-KORD Server.exe`, the UIs and the tools. No installer: extract and run. Allow the
  firewall prompt for private networks so phones can reach port 7420.
- **macOS** (experimental, build it on a Mac): `pnpm pack:macos` produces
  `rekord-server-<v>-macos-<arch>.tar.gz` (start it with `run.sh`) and a client `.dmg`.
  Data goes to `~/Library/Application Support/RE-KORD`. `bash scripts/pack-macos.sh --help`
  lists the options.

## Desktop server flavor

**RE-KORD Server** is the desktop client with the hub embedded (cargo feature `hub` of
`rekord-client`), the successor of the legacy Electron "Server" app:

```bash
pnpm build:client:server-flavor     # tauri build --features hub --config src-tauri/tauri.hub.conf.json
pnpm dev:client:server-flavor
```

- Separate identifier (`app.rekord.server`) and product name: it installs next to the
  plain client.
- At start-up it runs `rekord_core::run_hub` on its own thread and runtime. On exit it
  asks the hub to shut down gracefully (up to 8 s).
- Configuration: `hub.json` in the app's data folder (`~/.local/share/app.rekord.server/`
  on Linux, `%APPDATA%\app.rekord.server\` on Windows), written on first start:
  `{ "enabled": true, "bind": "0.0.0.0:7420", "dataDir": null }`. Hub data defaults to
  the `hub/` folder next to it. Environment variables win over the file:
  `REKORD_EMBEDDED_HUB=0` (disable the hub), `REKORD_BIND`, `REKORD_DATA_DIR`.
- The admin panel and the web client are bundled as resources and served on `/admin` and
  `/`, so phones and browsers on the LAN can use the hub without installing anything.
- The bundled `bin/` tools are picked up automatically unless `YTDLP_PATH`,
  `REKORD_CLOUDFLARED_BIN` or `REKORD_FFMPEG` are already set.
- If port 7420 is taken (a standalone hub is already running), the embedded hub logs the
  error and the window connects to the existing hub.
- Sleep prevention is set in the admin panel; `REKORD_PREVENT_SLEEP` works here too.
- Desktop only: the feature and its dependencies do not exist on Android.

## Keeping the computer awake

A hub on a PC that suspends (or idles into sleep) is unreachable until someone wakes it.
The admin panel's **Network › Power › "Prevent sleep"** (`GET/PUT /api/v1/system/power`)
blocks **system sleep** only; the display may still turn off and lock.

| Mode | When the lock is held |
|---|---|
| `off` (default) | Never. No process, timer or task runs. |
| `always` | While the hub serves. |
| `when-active` (`whenActive` in the API) | While a stream (media, transcode, podcast, preview) is sent, a scan / job / download runs, or requests arrive through the Cloudflare tunnel, plus a grace period after the last activity (10 min by default, 1–120). |

For a headless hub, `--prevent-sleep <mode>` or `REKORD_PREVENT_SLEEP=<mode>` sets the
mode at start-up and locks it in the admin panel (the grace period and the lid option stay
editable there). Changes from the panel apply at once and are saved in `settings.json`.

How it is done:

- **Linux**: a systemd-logind block inhibitor (`systemd-inhibit --what=sleep:idle`, shown by
  `systemd-inhibit --list` as "RE-KORD"). The helper reads a pipe from the hub, so it ends
  with the hub, also when the hub is killed. In a GNOME session the hub also takes GNOME's
  suspend inhibitor (`gnome-session-inhibit --inhibit suspend`), because GNOME's automatic
  suspend only looks at its own inhibitors. Without systemd (other init systems, Docker
  containers) the panel reports "not available".
  - **Lid** (optional, `keepAwakeLidClosed`): a second inhibitor, `handle-lid-switch`, so
    closing a laptop lid does not suspend it. A closed laptop in a bag can overheat. If
    polkit refuses it, sleep stays blocked and the panel shows the refusal.
  - **System service**: a service has no login session, and logind's default policy
    refuses its sleep inhibitor. Install `scripts/linux/50-rekord-power.rules` (in the
    headless package: `systemd/50-rekord-power.rules`) into `/etc/polkit-1/rules.d/`; it
    allows the inhibitors for the user `rekord` only. Without it the panel shows "the
    system refused the lock (polkit)".
- **Windows**: `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)` on a dedicated
  thread (`powercfg /requests` lists it under SYSTEM). It prevents idle sleep; closing the
  lid or choosing Sleep still follows the power plan.
- **macOS** (experimental): `caffeinate -i -w <hub pid>`.

## Reverse proxy and HTTPS

Any reverse proxy works. Requirements:

- Pass `Range` headers through and do not buffer streaming responses (audio, NDJSON
  download progress).
- Allow large uploads: backup restores can be up to 512 MiB.
- If the public origin differs from the `Host` the hub sees, add it to
  `REKORD_ALLOWED_ORIGINS`. Set `REKORD_PUBLIC_URL` so the client shows and encodes that
  URL.
- Requests carrying `X-Forwarded-For` and similar headers are never local, so machine
  operations through the proxy need `REKORD_ALLOW_REMOTE_ADMIN=1`.
- Do not strip the CORS headers: the desktop and Android apps call the hub from another
  origin.

Over HTTPS the web client can be installed as a PWA, and the Google Cast web sender
works in Chrome.

Example for Caddy:

```
music.example.org {
    reverse_proxy 127.0.0.1:7420 {
        flush_interval -1
    }
    request_body {
        max_size 512MB
    }
}
```

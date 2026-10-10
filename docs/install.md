# Installing RE-KORD

RE-KORD has two parts:

- **The hub** keeps the library index, accounts and personal data, streams the audio and
  serves the web client. Exactly one hub runs per library, on the machine that can see the
  music folder.
- **Clients** connect to a hub: the desktop app, the Android app, or any browser.

Each desktop download comes in two flavors:

| Flavor | Contains | Use it on |
|---|---|---|
| **RE-KORD Server** | The client window plus an embedded hub, with yt-dlp, cloudflared and ffmpeg bundled | The computer that holds your music |
| **RE-KORD Client** | The client window only | Every other computer |

The Server flavor is a complete RE-KORD on its own: the window is a client, and the hub it
starts is reachable from your phone and other computers at `http://<this-computer>:7420`.
For a machine without a desktop (NAS, home server, VPS), use the
[headless Linux package](#linux-headless-hub-with-systemd) or [Docker](#docker).

Downloads: [GitHub Releases](https://github.com/Creiv/RE-KORD/releases) and
[re-kord.com](https://re-kord.com). Every release has a `SHA256SUMS` file; check your
download with `sha256sum -c SHA256SUMS --ignore-missing`.

- [Linux](#linux)
- [Windows](#windows)
- [Android](#android)
- [Docker](#docker)
- [Network and firewall](#network-and-firewall)
- [Where data lives](#where-data-lives)
- [Uninstalling](#uninstalling)

## Linux

All Linux packages are x86-64.

**glibc 2.39 or newer is required** for the AppImage and `.deb` packages: Ubuntu 24.04+,
Linux Mint 22+, Debian 13+, Fedora 40+, or any distribution of the same generation. On
older systems, use the [headless hub](#linux-headless-hub-with-systemd) or
[Docker](#docker), and open the web client in a browser.

### AppImage

```bash
chmod +x RE-KORD-Server-5.1.0-linux-x64.AppImage
./RE-KORD-Server-5.1.0-linux-x64.AppImage
```

The same steps apply to `RE-KORD-Client-5.1.0-linux-x64.AppImage`. The AppImage bundles
WebKitGTK's GStreamer plugins, so audio works without extra packages. If it does not start
and the error mentions FUSE, install FUSE 2 (`sudo apt install libfuse2t64` on Ubuntu
24.04) or run it with `--appimage-extract-and-run`.

### Debian / Ubuntu package

```bash
sudo apt install ./RE-KORD-Server-5.1.0-linux-x64.deb   # package "re-kord-server"
sudo apt install ./RE-KORD-Client-5.1.0-linux-x64.deb   # package "re-kord"
```

The packages pull in WebKitGTK 4.1 and the GStreamer plugins (`base`, `good`, `libav`) that
audio playback needs. Both flavors can be installed side by side. They appear in the
application menu as **RE-KORD Server** and **RE-KORD**.

### Linux headless hub (with systemd)

`RE-KORD-Server-5.1.0-linux-x64-headless.tar.gz` is the hub without a window: the
`rekord-server` binary, the web client, the admin panel and the bundled tools in `bin/`.

Try it in place:

```bash
tar -xzf RE-KORD-Server-5.1.0-linux-x64-headless.tar.gz
cd RE-KORD-Server-5.1.0-linux-x64-headless
./run.sh                                  # http://<this-machine>:7420, admin at /admin
REKORD_BIND=127.0.0.1:7420 ./run.sh       # this machine only
./rekord-server --help                    # every option and environment variable
```

Install it as a service (dedicated `rekord` user, starts at boot, data in
`/var/lib/rekord`):

```bash
sudo ./systemd/install.sh
sudoedit /etc/default/rekord-server       # set REKORD_MUSIC_ROOT, REKORD_BIND, ...
sudo systemctl restart rekord-server
journalctl -u rekord-server -f
```

`install.sh` creates the `rekord` system user, copies the program to `/opt/rekord`,
installs `rekord-server.service` and, the first time only, `/etc/default/rekord-server`.
Running it again from a newer package upgrades in place and keeps your data and
configuration. `PREFIX=/srv/rekord sudo -E ./systemd/install.sh` installs elsewhere.

The unit is hardened (`ProtectSystem=strict`, `ProtectHome=read-only`, `NoNewPrivileges`,
private `/tmp`) and may only write `/var/lib/rekord`. Two things to adjust for most
libraries:

- **Give the hub access to the music folder.** The `rekord` user must be able to read it.
  If you use Studio (downloads, covers, metadata, deletions), add the folder to
  `ReadWritePaths=` with `sudo systemctl edit rekord-server`:

  ```ini
  [Service]
  ReadWritePaths=/srv/music
  ```

- **A library under `/home`** also needs `ProtectHome=false` in the same override.

The full list of settings is in [DEPLOY.md](DEPLOY.md).

## Windows

Windows 10 or 11, x64. Neither download has an installer: they are portable.

### RE-KORD Client

`RE-KORD-Client-5.1.0-windows-x64.exe` is a single executable. Put it anywhere and
double-click it.

### RE-KORD Server

`RE-KORD-Server-5.1.0-windows-x64.zip` contains a `RE-KORD Server` folder:

```
RE-KORD Server\
  RE-KORD Server.exe
  admin-ui\  client-ui\  bin\     (yt-dlp, cloudflared, ffmpeg)
  README.txt
```

Extract the folder anywhere (for example `C:\Program Files\RE-KORD Server` or your Desktop)
and start `RE-KORD Server.exe`. Keep the executable and the three folders together; you
can move the whole folder at any time.

### Notes for Windows

- **WebView2.** The apps use the Microsoft Edge WebView2 runtime. It is preinstalled and
  kept up to date on current Windows 10 and 11. If the window stays blank or the app
  reports that WebView2 is missing, install the *Evergreen* runtime from
  [Microsoft](https://developer.microsoft.com/microsoft-edge/webview2/).
- **SmartScreen.** The executables are not code-signed. On first start Windows may show
  "Windows protected your PC": choose *More info → Run anyway*.
- **Firewall.** On the first start of RE-KORD Server, Windows asks whether to allow network
  access. Allow it for **private networks**, otherwise phones and other computers cannot
  reach port 7420.

## Android

`RE-KORD-Client-5.1.0-android-arm64.apk`, for Android 8.0 or newer on 64-bit ARM (every
current phone and most tablets and TV boxes).

1. Copy the APK to the phone, or download it there.
2. Open it. Android asks you to allow installs from that source (*Install unknown apps*):
   allow it for the browser or file manager you are using.
3. Start RE-KORD, then type the hub address or scan its QR code (see
   [Quick start](../README.md#quick-start)).

The Android app is a client only. It needs a hub on your network, or a hub reachable
through the remote-access tunnel.

> **Coming from the legacy Android app?** The legacy APK was signed with a different key,
> so Android refuses to update it. Uninstall the old RE-KORD first, then install the new
> APK. Nothing important is lost: favorites, playlists and settings live on the hub. See
> [Upgrading from legacy RE-KORD](upgrading-from-legacy.md#android).

## Docker

A ready-made image for amd64 and arm64 is published on the GitHub Container Registry at
every release: `ghcr.io/creiv/re-kord` (tags `latest`, the version such as `5.1.0`, and the
release tag such as `v5.1`). The `docker-compose.yml` uses it, so that file is all you need:

```bash
mkdir rekord && cd rekord
curl -O https://raw.githubusercontent.com/Creiv/RE-KORD/main/docker-compose.yml
REKORD_MUSIC_HOST=/path/to/Music docker compose up -d
```

To update: `docker compose pull && docker compose up -d`. To build the image yourself from a
checkout instead, uncomment `build:` in `docker-compose.yml` and run
`docker compose up -d --build`.

Then open `http://<host>:7420` (admin panel at `/admin`).

| Setting | Default | Meaning |
|---|---|---|
| `REKORD_PORT` | `7420` | Host port |
| `REKORD_DATA_HOST` | `./docker-data/data` | Host folder for `/data` (database, settings, accounts) |
| `REKORD_MUSIC_HOST` | `./docker-data/music` | Host folder for `/music` (the library) |
| `REKORD_ALLOW_REMOTE_ADMIN` | `0` | `1` allows machine operations from other devices; see below |
| `TZ` | `Europe/Rome` | Time zone |

The variables can go in a `.env` file next to `docker-compose.yml`.

- The container runs as uid **10001**. Make the host folders writable for it
  (`sudo chown -R 10001:10001 docker-data`), or set `user: "<uid>:<gid>"` in the compose
  file.
- The image includes ffmpeg, yt-dlp and cloudflared, and has a health check on
  `/api/v1/health`.
- **Machine operations** (choosing the library path, scans, restores, the tunnel) are only
  accepted from the hub machine itself, and inside a container no request is local. Either
  run them from inside the container:

  ```bash
  docker exec rekord curl -X POST http://127.0.0.1:7420/api/v1/library/scan
  ```

  or set `REKORD_ALLOW_REMOTE_ADMIN=1` on a network you trust, and use the admin panel as
  usual. See [SECURITY.md](../SECURITY.md#machine-operations).

## Network and firewall

The hub listens on **TCP port 7420** on all interfaces (`0.0.0.0:7420`), so every device
on your LAN can reach it. The client and the admin panel are served from the same port.

| What | Address |
|---|---|
| Web client | `http://<hub-ip>:7420/` |
| Admin panel | `http://<hub-ip>:7420/admin` |
| Health check | `http://<hub-ip>:7420/api/v1/health` |

Open the port for your local network if a firewall is active:

```bash
sudo ufw allow from 192.168.0.0/16 to any port 7420 proto tcp            # Ubuntu (ufw)
sudo firewall-cmd --permanent --add-port=7420/tcp && sudo firewall-cmd --reload   # Fedora
```

To keep the hub private to one machine, bind it to loopback with
`REKORD_BIND=127.0.0.1:7420`. For listening away from home, use the built-in Cloudflare
tunnel instead of forwarding the port on your router; see the
[user guide](user-guide.md#remote-access).

The browser client can be installed as an app (PWA) only over HTTPS or on `localhost`. On
`http://<lan-ip>:7420` it works the same but cannot be installed.

## Where data lives

Your music files are never moved. The hub keeps its own data in a separate folder:

| Install | Hub data folder |
|---|---|
| RE-KORD Server app, Linux | `~/.local/share/app.rekord.server/hub` |
| RE-KORD Server app, Windows | `%APPDATA%\app.rekord.server\hub` |
| `rekord-server` / `run.sh`, Linux | `~/.local/share/RE-KORD` |
| `rekord-server`, Windows | `%APPDATA%\RE-KORD` |
| systemd service | `/var/lib/rekord` |
| Docker | the `/data` volume |

`REKORD_DATA_DIR` (or `--data-dir`) overrides it. The RE-KORD Server app reads its settings
from `hub.json` in the folder above `hub` (`enabled`, `bind`, `dataDir`); see
[DEPLOY.md](DEPLOY.md#desktop-server-flavor).

The library also has a small `.kord` folder of its own (layout and metadata files that
travel with the music).

## Uninstalling

- **AppImage / Windows**: delete the file or folder.
- **`.deb`**: `sudo apt remove re-kord-server` or `sudo apt remove re-kord`.
- **systemd**: `sudo systemctl disable --now rekord-server`, then remove `/opt/rekord`,
  `/etc/systemd/system/rekord-server.service` and `/etc/default/rekord-server`.
- **Docker**: `docker compose down`.

Removing the program leaves the hub data folder in place. Make a backup from the admin
panel before deleting it.

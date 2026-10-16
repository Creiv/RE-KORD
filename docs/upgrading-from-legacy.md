# Upgrading from legacy RE-KORD

RE-KORD 5 (version 5.0 and later) replaces the **legacy RE-KORD**: the React / Node / Electron /
Capacitor app, released up to 4.4 and a final version also numbered 5.0. Both carry the
number 5.0, so this guide says "legacy" for the old app and "RE-KORD 5" for the new one.
The legacy source is kept in the repository at the tag `legacy-5.0`.

Your music files are not touched. Your personal data (favorites, playlists, moods, tracks
blocked from shuffle, play counts, settings, accounts, Plectr records, curated metadata) is
carried over **automatically** the first time RE-KORD 5 scans the same music folder, also
into accounts you already use in RE-KORD 5. A backup is still
the safest way to move, and it is required when the new hub runs on another machine.

Read the whole page once before you start.

## What changes

| | Legacy | RE-KORD 5 |
|---|---|---|
| Hub port | `3001` | **`7420`** |
| Hub program | Node server inside the Electron "Server" app, or `node server/index.mjs` | `rekord-server` (one binary), or the **RE-KORD Server** desktop app with the hub embedded |
| Hub data | Electron `userData` and `REKORD_USER_CONFIG_DIR` (`music-root.config.json`), plus `<music>/.kord` | A data folder of its own: `rekord.db`, `settings.json`, `accounts/` (see below) |
| Hub settings | Inside the app | Admin panel at `http://<hub>:7420/admin` |
| Web client | Served by the hub | Still served by the hub at `/`; installable as a PWA over HTTPS or on `localhost` |
| Desktop client | Electron, loaded the UI from the hub | Tauri; **the UI is bundled in the app** and updates with the app |
| Android | Capacitor APK, debug-signed | Tauri APK, new signing key: **uninstall the old app first** |
| Docker | `/config` and `/music`, port 3001 | `/data` and `/music`, port 7420 |
| Languages | Italian, English | Italian, English, German |

### Where RE-KORD 5 keeps its data

| Install | Data folder |
|---|---|
| RE-KORD Server app, Linux | `~/.local/share/app.rekord.server/hub` |
| RE-KORD Server app, Windows | `%APPDATA%\app.rekord.server\hub` |
| `rekord-server`, Linux | `~/.local/share/RE-KORD` |
| `rekord-server`, Windows | `%APPDATA%\RE-KORD` (the folder the legacy desktop app used; RE-KORD 5 adds its own files next to the old ones and leaves `music-root.config.json` alone) |
| `rekord-server`, macOS | `~/Library/Application Support/RE-KORD` |
| systemd service | `/var/lib/rekord` |
| Docker | the `/data` volume |

## 1. Before you start

With legacy RE-KORD still running:

1. **Download a backup** from the legacy settings (backup section). You get a ZIP
   (`kordBackup: 2`) with configuration, accounts, favorites, playlists, moods and the
   `.kord` database. Keep it somewhere safe.
2. **Note the music folder path** (legacy *Settings › Library*).
3. **Stop the legacy app**: quit the Server app, `docker compose down`, or stop the Node
   process, so port 3001 and the `.kord` database are free.

## 2. Install the RE-KORD 5 hub

Pick one (details in [install.md](install.md)):

- **Desktop computer that holds the music**: the **RE-KORD Server** app (AppImage, `.deb`
  or Windows zip). The hub starts with the window.
- **Linux server**: the headless package, `RE-KORD-Server-5.2.0-linux-x64-headless.tar.gz`,
  then `sudo ./systemd/install.sh`.
- **Docker**: see [Docker](#docker) below.
- **From source**: see [development.md](development.md).

Then open `http://<hub>:7420/admin`, go to **Library › Music folder**, enter the same path
the legacy app used and choose **Save path**. On a headless hub you can instead pass
`--music-root /path/to/Music` or set `REKORD_MUSIC_ROOT`.

## 3. Bring your data over

### Automatic: the legacy import

Legacy RE-KORD kept your personal data next to the music, in `<music>/.kord`:

| File | Contents |
|---|---|
| `global_info/accounts.json` | the accounts (`id`, `name`) |
| `<account>_info/user-state.json` | favorites, playlists, moods (`trackMoods`), tracks and albums blocked from shuffle (`shuffleExcludedTrackRelPaths`, `shuffleExcludedAlbumIds`), play counts, recent tracks, queue, settings, Plectr records |
| `<account>_info/library-selection.json`, `theme-bg.*` | library selection, theme background |
| `rekord.db` | curated library metadata |

The Electron data folder (`~/.config/rekord` on Linux, `%APPDATA%\RE-KORD` on Windows)
only holds machine settings (`music-root.config.json`) and the browser storage of the old
window; achievements and XP are computed from play counts, favorites, playlists, moods and
Plectr records, so they come back with them.

When the music folder contains a legacy `.kord` folder, the first scan imports it:

- curated metadata: titles, full dates, genres, track and disc numbers, hand-edited
  fields, added and updated times;
- the accounts: each legacy account goes to the RE-KORD 5 account with the same id, then
  the same name (`default` always to `default`); the others are created with their legacy
  id and name. Folders of accounts deleted in the legacy app are skipped;
- per account: favorites, playlists (in their legacy order), moods, blocked tracks and
  albums, play counts, recent tracks, settings, library selection, theme background and
  Plectr records.

It is a **merge**, also for accounts you have already used in RE-KORD 5: favorites,
playlists, moods and blocked tracks are added next to yours; a play count keeps the higher
value; settings, a theme background or a library selection you already have are kept (the
language too); nothing is removed. Tracks are matched by their path in the music folder
(also across a different letter case, accented letters stored differently, and the
`Tracce` → `Tracks` rename). Paths whose file is no longer there are kept, link up again
if the file comes back, and are listed in the result.

At start-up the hub also looks for the legacy machine settings (`music-root.config.json` in
the Electron data folders or `REKORD_USER_CONFIG_DIR`) and copies, once, the Discogs token,
the YouTube cookies and the Cloudflare login state, but only where RE-KORD 5 has none yet.

The outcome is recorded in `<data dir>/legacy-import.json`, with a digest of each account's
legacy files and the report of the last run. Later scans and restarts do not import again,
and a manual import leaves alone the accounts whose legacy files did not change, so
anything you delete in RE-KORD 5 stays deleted. To skip the automatic import, start the hub
with `REKORD_SKIP_LEGACY_IMPORT=1` (and `REKORD_SKIP_LEGACY_CONFIG_IMPORT=1` for the
credentials).

> **Upgraded with an early 5.0 build?** Its automatic import skipped every account already
> used in RE-KORD 5 (the Default account always), so favorites, blocked tracks, moods and
> playlists were missing. RE-KORD 5 recognises the old `legacy-import.json` and runs the
> import once more at the next start (after the library scan), for those accounts only. You
> can also run it right away with the button below.

### From the backup ZIP

Use this when the new hub runs on another machine, or to restore accounts and settings
exactly as they were. Restoring is safe to repeat.

- **Admin panel**: **Backup › Restore from ZIP file…**, then pick the legacy ZIP.
  Legacy (v2) backups are recognised automatically.
- **Client**: *Settings › System › Backup › Restore…*
- **Command line** (headless hub, while it is stopped):

  ```bash
  rekord-server --restore-zip ~/rekord-backup-legacy.zip --restore-exit
  ```

Audio files are not in the ZIP: the music folder must already exist at the path recorded in
the backup. Accounts are matched **by display name** (case-insensitive): an existing hub
account with the same name keeps its id and receives the backup's data; other accounts are
added. The restore schedules a library scan on its own.

### Manual import from `.kord`

To run the import now, see what it would add, or merge again after copying more data from
the old machine:

- **Admin panel** (`http://<hub>:7420/admin`, on the hub computer): **Backup › Import from
  legacy RE-KORD**. **Import from legacy RE-KORD** runs it and shows the result per category
  and per account (with the paths not found in the library); **Preview (changes nothing)**
  shows the same counts without writing anything. **Library › Maintenance** has the same
  button.
- **Client**, one legacy account into the current one: *Settings › System › Backup ›
  Import from legacy .kord folder…*
- **Command line** (while the hub is stopped):

  ```bash
  # preview: prints the report as JSON, writes nothing
  rekord-server --music-root /path/to/Music --legacy-import --legacy-import-dry-run
  # import, then exit (add --legacy-import-force to merge again accounts
  # already imported from the same files, bringing back what you removed)
  rekord-server --music-root /path/to/Music --legacy-import --legacy-import-exit
  ```

  `--sync-legacy-meta` / `--sync-legacy-exit` still work as aliases.
- **API**: `GET /api/v1/legacy-import` (status and last report),
  `POST /api/v1/legacy-import[?dryRun=true][&force=true]`.

Legacy metadata only fills empty fields (placeholder genres such as `Music` or `Unknown`
are replaced by the richer legacy value) and values you typed in RE-KORD 5 are never
overwritten, so running it after you have started using RE-KORD 5 loses nothing. Each run
is logged (counts per category, paths not found) and appears in the activity log.

## 4. Reconnect your devices

### Browsers

Open `http://<hub>:7420/`. Bookmarks on port `3001` must be updated.

### Desktop

Uninstall the legacy Electron client and install **RE-KORD Client** (or **RE-KORD
Server** on the machine with the music). The app finds a hub on the same machine by itself;
otherwise type the hub address or use the address shown in the admin panel under
**Network › Local network access**.

Desktop and Android apps now carry their own UI. When the hub is newer, they show an
**Update available** banner, and **Update this app** when the hub requires a newer client.
Updates are published on [GitHub Releases](https://github.com/Creiv/RE-KORD/releases) and
[re-kord.com](https://re-kord.com).

### Android

The legacy APK was signed with a debug key and the new one with the release key. Android
refuses to update an app across signing keys (`INSTALL_FAILED_UPDATE_INCOMPATIBLE`, or just
"App not installed").

1. **Uninstall the legacy RE-KORD** from the launcher (or `adb uninstall app.rekord.client`).
2. Install `RE-KORD-Client-5.2.0-android-arm64.apk`.
3. Enter the hub address, or scan the QR code from the admin panel (**Network › Local
   network access › QR**), then pick your account.

Nothing important is lost: favorites, playlists and preferences live on the hub. Google Cast
works from the Android app as before.

## Docker

```yaml
# legacy                                # RE-KORD 5 (docker-compose.yml)
ports: ["3001:3001"]                    ports: ["7420:7420"]
volumes:                                volumes:
  - ./docker-data/config:/config          - ./docker-data/data:/data
  - ./docker-data/music:/music            - ./docker-data/music:/music
```

- The image runs as uid **10001**: `sudo chown -R 10001:10001 docker-data`, or set `user:`
  in the compose file.
- The legacy `/config` volume is **not** read. If `/music/.kord` is in the music volume,
  the automatic import runs on the first scan. Otherwise restore the backup ZIP: copy it
  into the data volume, then

  ```bash
  docker compose run --rm rekord --restore-zip /data/backup.zip --restore-exit
  ```

- Environment variables were renamed:

  | Legacy | RE-KORD 5 |
  |---|---|
  | `PORT`, `REKORD_LISTEN_HOST` | `REKORD_BIND` (for example `0.0.0.0:7420`) |
  | `REKORD_USER_CONFIG_DIR` | `REKORD_DATA_DIR` |
  | `MUSIC_ROOT`, `REKORD_DOCKER_MUSIC_DIR` | `REKORD_MUSIC_ROOT` |
  | `REKORD_CONFIG_HOST` (compose) | `REKORD_DATA_HOST` |

- Machine operations (scans, library path, restore, tunnel) are only accepted from the hub
  machine, and inside a container no request is local. Use
  `docker exec rekord curl -X POST http://127.0.0.1:7420/api/v1/library/scan`, or set
  `REKORD_ALLOW_REMOTE_ADMIN=1` on a trusted network. See
  [SECURITY.md](../SECURITY.md#machine-operations).

## Security changes you may notice

- **Cross-origin calls are restricted.** The API no longer answers `*`: only the hub's own
  pages, the desktop and Android apps, the development servers and the origins listed in
  `REKORD_ALLOWED_ORIGINS` may call it from a browser. A custom page or a reverse proxy on
  another origin must be listed there.
- **Machine operations need the hub computer.** Choosing the library path, scans,
  restores, credentials, the tunnel and backup downloads require the Default account on the
  hub computer, or the remote-admin switch (**Network › Machine operations**). Studio
  changes (downloads, metadata, covers) are allowed from the hub computer or with the same
  switch. Personal data (favorites, playlists, moods) works from every device as before.

See [SECURITY.md](../SECURITY.md) for the full model.

## Known issue: desktop apps and plain-HTTP hubs

The desktop app's UI runs from a secure origin (`tauri://localhost` on Linux,
`http://tauri.localhost` on Windows) and talks to a hub on `http://192.168.x.x:7420`.
WebView2 (Windows) and the Android WebView allow this. WebKitGTK (Linux) may treat
`tauri://localhost` as a secure context and block or upgrade plain-HTTP requests (mixed
content), depending on its version.

If the desktop app cannot load the library, covers or audio from a hub on another machine:

- reach the hub through HTTPS (the remote-access tunnel or your own reverse proxy), or
- use the web client in a browser on that machine.

A hub on the same machine (`http://127.0.0.1:7420`) is never affected, because loopback is
always trusted.

Test procedure for maintainers, on each desktop platform before a release:

1. Start a hub on another machine of the LAN (`REKORD_BIND=0.0.0.0:7420`).
2. Start the desktop app, type `http://<lan-ip>:7420`, pick an account.
3. Check that the library loads, album covers show, an MP3 and a FLAC play and seek, and
   *Settings › System › Backup › Download backup* saves a file.
4. Open the devtools (debug build, or right click › Inspect) and look for
   `Mixed Content`, `blocked` or `CORS` messages.
5. Repeat with the hub on the same machine (`http://127.0.0.1:7420`) and through an HTTPS
   tunnel URL.

## Rolling back

RE-KORD 5 never modifies `music-root.config.json`, and the legacy import (automatic,
admin panel or `--legacy-import`) only reads `.kord`. Restoring a legacy ZIP, however, writes the backup's
`kord-db/` into `<music>/.kord` (the same data the legacy app had when you exported it):
copy `<music>/.kord` aside first if you want an exact way back.

To go back: stop the RE-KORD 5 hub, start the legacy app again on port 3001, and reinstall
the legacy clients (on Android, uninstall RE-KORD 5 first: the signing key changes again).

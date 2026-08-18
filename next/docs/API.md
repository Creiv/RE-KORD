# RE-KORD API (`/api/v1`)

Base URL default: `http://127.0.0.1:7420` (il processo ascolta su `0.0.0.0:7420` per LAN / tunnel)

Envelope (JSON):

```json
{ "ok": true, "data": {} }
{ "ok": false, "error": "message" }
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/health` | Service health |
| GET | `/api/v1/library` | List tracks (`limit`, `offset`) |
| GET | `/api/v1/library/stats` | Counts + last scan + optional `disk_total_bytes` / `disk_available_bytes` for the music_root volume |
| GET | `/api/v1/library/search?q=` | Text tracks (`limit`, default 100, max 500; the client asks for 500) |
| GET | `/api/v1/library/albums` | List albums |
| GET | `/api/v1/library/albums/{id}` | Album by id |
| GET | `/api/v1/library/albums/{id}/tracks` | Album tracks |
| GET | `/api/v1/library/artists` | List artists |
| GET | `/api/v1/library/artists/{id}` | Artist by id |
| GET | `/api/v1/library/artists/{id}/albums` | Albums of artist |
| GET | `/api/v1/library/tracks/{id}` | Track by id |
| GET/PUT | `/api/v1/library/path` | Music root path |
| POST | `/api/v1/library/scan?mode=incremental\|full` | Scan library (default incremental: upsert by path, skip unchanged size+mtime, prune missing files/albums/artists; `full` rebuilds) (then fill-empty meta from `.kord/rekord.db` + sidecars; fill missing personal moods). Genre fill treats ID3 stubs (`Music`, `Unknown`, 1-char) as empty and prefers richer legacy genres. |
| POST | `/api/v1/library/sync-legacy-meta` | One-shot: fill studio meta from sidecars + `music_root/.kord/rekord.db` (genre: overwrite stubs / prefer richer legacy); replace personal moods/excludes/settings/playCounts/recent, favorites, playlists, library selection + accounts registry from `.kord` |
| GET | `/api/v1/library/tracks-page` | Paginated personal library (`limit`, `offset`) → `{ items, total, revision }` |
| GET | `/api/v1/library/artists-page` | Paginated artists (`limit`, `offset`) → `{ items, total }` |
| GET | `/api/v1/library/changes?revision=` | Delta since a revision: `{ revision, updated, removed, full }` (`full: true` → page again) |
| POST | `/api/v1/library/probe` | Analyse folder structure and suggest a layout |
| GET/PUT | `/api/v1/library/layout` | Read / write `music_root/.kord/library-layout.json` |
| GET/PUT | `/api/v1/library/watch` | Filesystem watcher status / enable-disable (debounced incremental scan) |
| POST | `/api/v1/library/thumbnails` | Start the cover thumbnail backfill as a job |
| GET/DELETE | `/api/v1/jobs` | Background jobs (scan, thumbnails, restore, sync-legacy) with progress / drop finished entries |
| POST | `/api/v1/jobs/{id}/cancel` | Cancel a cancellable job |
| GET/DELETE | `/api/v1/diagnostics/errors` | Recent WARN/ERROR ring buffer (`limit`) / clear it |
| GET | `/api/v1/network/public-ip` | Public IP (best effort, `null` when offline) |
| GET/PUT | `/api/v1/system/machine-access` | Machine-operation rights; `PUT { "enabled" }` toggles remote admin (local only) |
| GET/POST | `/api/v1/favorites` | List / add favorite (`{ "track_id" }`) — per account |
| DELETE | `/api/v1/favorites/{id}` | Remove favorite — per account |
| GET/POST | `/api/v1/playlists` | List / create (`{ "name" }`) — per account |
| GET/PUT/DELETE | `/api/v1/playlists/{id}` | Tracks / rename / delete — per account |
| POST | `/api/v1/playlists/{id}/tracks` | Add track (`{ "track_id" }`), appended last |
| PUT | `/api/v1/playlists/{id}/tracks` | Reorder (`{ "trackIds": [...] }`); 409 unless the ids are exactly the current ones |
| DELETE | `/api/v1/playlists/{id}/tracks?track_id=` | Remove track |
| GET/PATCH | `/api/v1/my-library-selection` | Per-account library selection |
| GET | `/api/v1/catalog` | Global FS catalog (unfiltered) |
| GET/POST | `/api/v1/accounts` | List / create local accounts (alias `/api/accounts`) |
| PUT/DELETE | `/api/v1/accounts/{id}` | Rename / delete (default `default` locked) |
| GET | `/api/v1/accounts/{id}/export` | Export profile ZIP (selection + favorites + playlists) |
| GET | `/api/v1/modules` | Optional module registry |
| GET | `/api/v1/covers/album/{id}` | Album cover image (folder cover.jpg…). `?size=128\|256` serves a cached thumbnail |
| GET | `/api/v1/covers/artist/{id}` | Artist cover (first album with cover), same `?size=` |
| GET | `/api/v1/backup/kord-data` | Download hub backup ZIP (`kordBackup: 3`) |
| POST | `/api/v1/backup/kord-restore` | Restore ZIP (`multipart` field `file`; v2/v3; body limit 512 MiB) |
| GET/POST/DELETE | `/api/v1/config` (+ youtube-cookies, discogs-token) | Hub settings / Studio integrations |
| GET/POST | `/api/v1/fs/list`, `mkdir`, `search-dirs` | Local folders under music_root |
| POST | `/api/v1/fs/delete-audio-relpaths` | Delete audio files (`{ "relPaths": [...] }`) → `{ deleted, skipped, affectedAlbums }`. Only plain audio files inside the library; a path that resolves elsewhere (`..`, symlink) or is already gone lands in `skipped` |
| POST | `/api/v1/fs/delete-album-folder` | Delete an album folder whole (`{ "albumPath" }`, at least `Artist/Album` deep and holding audio) → `{ deleted, deletedFolder, affectedAlbums }` |
| POST | `/api/v1/download` | yt-dlp NDJSON stream (`downloadId`, `url`, `outputDir`) |
| POST | `/api/v1/download-cancel`, `download-flat-count` | Cancel / playlist count |
| POST | `/api/v1/youtube-explore-search`, `youtube-releases-list` | YT Music explore / releases |
| GET | `/api/v1/catalog-web-discover` | New releases (Innertube) |
| GET | `/api/v1/catalog-web-tracks` | Track list of a release page (`url`): Innertube browse, yt-dlp flat playlist as fallback |
| GET | `/api/v1/catalog-web-preview` | Resolve a ~30s audition for a watch `url` → `{ playUrl }` (token valid 90s; 403 with `ENABLE_YTDLP=0`) |
| GET | `/api/v1/catalog-web-preview/stream` | Proxy the audition audio for a token (`t`); honours `Range`, else serves the first `REKORD_PREVIEW_INITIAL_RANGE_BYTES` (default 512 KiB); 410 once expired |
| GET/POST | `/api/v1/artwork/search`, `apply`, `upload` | Cover search / save |
| POST | `/api/v1/album-info/*`, `track-info/*`, `track-info/prune-orphans`, `studio/sanitize-track-titles`, `track-lyrics/fetch`, `discogs/*` | Metadata / prune / sanitize titles / LRCLIB / Discogs |
| GET/POST | `/api/v1/entity-info`, `search`, `save` | Curiosità read / Wikipedia search / persist |
| GET | `/media/{rel_path}` | Audio stream (HTTP Range) |
| GET/PUT/PATCH | `/api/v1/user-state` | Per-account prefs (playCounts, recent, moods, excludes) + `revision` (409 on conflict) |
| GET/POST/DELETE | `/api/v1/user-state/custom-theme-bg` | Serve / upload (`multipart` field `file`) / clear custom theme background (JPEG/PNG/WebP/GIF, max 32 MiB) |
| GET | `/api/v1/diagnostics` | Version, uptime, DB counts, scanning, jobs, watcher, recent errors, ffmpeg/yt-dlp/cloudflared versions, disk space, library layout |
| GET | `/api/v1/activity-log` | Activity JSONL entries (`ts`, `kind`, `message`, optional `accountId` / `accountName`). Query: `day=YYYY-MM-DD` (Default only, local calendar day), `since` (RFC3339), `scope=all\|system\|user` + `filterAccountId` (Default only; ignored for others → `scope=all`), `limit` (max 2000). Non-default callers are always clamped to the last 24h server-side (`canSelectDay: false`). Response includes `window`, `scope`, `canSelectDay`. |
| GET | `/api/v1/remote-access` | LAN URL, tunnel status, Cloudflare login flag, `cloudflaredAvailable` |
| POST | `/api/v1/remote-access/start` | Start temporary cloudflared quick tunnel (or use `REKORD_PUBLIC_URL`) |
| POST | `/api/v1/remote-access/stop` | Stop tunnel / clear public URL |
| POST | `/api/v1/remote-access/login` | Mark Cloudflare login + return dashboard URL |
| POST | `/api/v1/remote-access/logout` | Logout flag + stop tunnel |
| GET | `/api/v1/backup/theme-export` | Shareable theme ZIP (`rekord-theme/`) for the current account |

Track/Album JSON may include `genre`, `release_date`, `lyrics` (tracks) and `genre`/`label`/`expected_track_count` (albums) from tags or Studio meta. Albums may also expose read-only Discogs fields when present: `discogs_release_id`, `discogs_uri`, and `discogs_extra` (`formatSummary`, `catalogNo`, `discogsUri`, `masterId` — camelCase, legacy parity).

Account resolution: query `accountId`, or headers `X-KORD-Account-Id` / `X-REKORD-Account-Id`, else default account `default` (“Locale”).

Every response carries `x-request-id` (echoed from the request when provided) to correlate client actions with hub logs.

**Machine operations.** Endpoints that write to the host rather than to personal data require the **default** account *and* a local client: `PUT …/library/path`, `POST …/library/scan|thumbnails|sync-legacy-meta`, `PUT …/library/layout|watch`, `POST …/backup/kord-restore` (full restores; theme packages stay personal), Studio integrations (`POST/DELETE …/config/youtube-cookies`, `PUT/DELETE …/config/discogs-token`), deletions from disk (`POST …/fs/delete-audio-relpaths|delete-album-folder`) and remote access (`POST …/remote-access/start|stop|login|logout`). Non-default accounts and remote clients receive `403`.

A request counts as local when the peer address is loopback, `Host` is `localhost`/`127.0.0.1`/`::1`, and no proxy headers (`cf-connecting-ip`, `cf-ray`, `x-forwarded-for`, `x-forwarded-host`, `x-real-ip`) are present — so a Cloudflare tunnel is remote even though `cloudflared` connects from `127.0.0.1`. `PUT /api/v1/system/machine-access { "enabled": true }`, callable only from the hub machine, lifts the local requirement for the default account. `GET /api/v1/system/machine-access`, `GET /api/v1/config` and `GET /api/v1/remote-access` expose `machineAccess` (`isDefaultAccount`, `local`, `allowRemoteAdmin`, `canManageMachine`) so clients can render those sections read-only instead of failing on submit; `GET /api/v1/config` also reports `youtubeCookiesWritable` / `discogsWritable` as `false` when the caller cannot manage the machine.

Library scan is **folder-first**: `Music/Artist/Album/track`. Tags are used only for title/duration/track number.

### Backup / restore

- **v3 (next):** ZIP includes `config/manifest.json` (`kordBackup: 3`), `config/settings.json`, `config/accounts.json`, `hub/accounts/{id}/favorites.json|playlists.json|library-selection.json|user-state.json` (+ optional `theme-bg.jpg`), library sidecars under `libraries/shared/`, and `kord-db/` (mirror of `music_root/.kord`). Also `config/youtube-cookies.txt` / activity when present.
- **v2 (legacy):** ZIP from the React hub. Restore reads `config/music-root.config.json` + `config/manifest.json`, extracts `kord-db/` → `music_root/.kord`, imports registry from `kord-db/global_info/accounts.json` (or manifest `accounts`), and for each `{id}_info/user-state.json` migrates favorites/playlists into SQLite **and** full prefs into `{data_dir}/accounts/{id}_info/user-state.json` (playCounts, recent, moods, excludes, settings, optional `legacyQueue`). After the library scan, album/track studio metadata is merged from restored sidecars (`kord-albuminfo.json` / `kord-trackinfo.json`) and from `music_root/.kord/rekord.db` into the next hub DB (fill-empty). Audio files are **not** in the ZIP — `libraryRoot` must already exist on disk.
- **Account overwrite-by-name:** before writing personal data, restore matches backup accounts to existing hub accounts with the same display name (case-insensitive). Matching accounts keep the hub id and have favorites/playlists/selection/user-state/theme overwritten; unmatched backup accounts are added with their backup id. `default` always maps to `default`.
- **Theme package:** ZIP with `rekord-theme/rekord-theme.json` (`kind: "rekord-theme"`) + optional background image. `POST …/kord-restore` detects it and applies only theme settings (preset/custom, glass, background) to the current account — no user data. `GET …/theme-export` builds the same format.
- CLI: `rekord-server --restore-zip /path/to.zip [--restore-exit]` restores without HTTP multipart.
- CLI: `rekord-server --sync-legacy-meta [--sync-legacy-exit]` merges studio metadata + full personal data (moods, excludes, settings, favorites, playlists, selection, accounts) from `music_root/.kord` into the hub (same as `POST /api/v1/library/sync-legacy-meta`).

The **server** serves the built **client SPA** from `--client-ui` / `REKORD_CLIENT_UI` at `/`, so LAN and Cloudflare tunnel URLs are same-origin for UI + API, and the **admin panel** from `--admin-ui` / `REKORD_ADMIN_UI` at `/admin` (also on `/` when no client bundle is present). Native shells may still bundle the UI and point `Server URL` at the hub.

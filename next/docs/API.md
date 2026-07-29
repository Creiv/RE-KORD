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
| GET | `/api/v1/library/search?q=` | Text tracks |
| GET | `/api/v1/library/albums` | List albums |
| GET | `/api/v1/library/albums/{id}` | Album by id |
| GET | `/api/v1/library/albums/{id}/tracks` | Album tracks |
| GET | `/api/v1/library/artists` | List artists |
| GET | `/api/v1/library/artists/{id}` | Artist by id |
| GET | `/api/v1/library/artists/{id}/albums` | Albums of artist |
| GET | `/api/v1/library/tracks/{id}` | Track by id |
| GET/PUT | `/api/v1/library/path` | Music root path |
| POST | `/api/v1/library/scan` | Scan library |
| GET/POST | `/api/v1/favorites` | List / add favorite (`{ "track_id" }`) — per account |
| DELETE | `/api/v1/favorites/{id}` | Remove favorite — per account |
| GET/POST | `/api/v1/playlists` | List / create (`{ "name" }`) — per account |
| GET/PUT/DELETE | `/api/v1/playlists/{id}` | Tracks / rename / delete — per account |
| POST | `/api/v1/playlists/{id}/tracks` | Add track (`{ "track_id" }`) |
| DELETE | `/api/v1/playlists/{id}/tracks?track_id=` | Remove track |
| GET/PATCH | `/api/v1/my-library-selection` | Per-account library selection |
| GET | `/api/v1/catalog` | Global FS catalog (unfiltered) |
| GET/POST | `/api/v1/accounts` | List / create local accounts (alias `/api/accounts`) |
| PUT/DELETE | `/api/v1/accounts/{id}` | Rename / delete (default `default` locked) |
| GET | `/api/v1/accounts/{id}/export` | Export profile ZIP (selection + favorites + playlists) |
| GET | `/api/v1/modules` | Optional module registry |
| GET | `/api/v1/covers/album/{id}` | Album cover image (folder cover.jpg…) |
| GET | `/api/v1/covers/artist/{id}` | Artist cover (first album with cover) |
| GET | `/api/v1/backup/kord-data` | Download hub backup ZIP (`kordBackup: 3`) |
| POST | `/api/v1/backup/kord-restore` | Restore ZIP (`multipart` field `file`; v2/v3; body limit 512 MiB) |
| GET/POST/DELETE | `/api/v1/config` (+ youtube-cookies, discogs-token) | Hub settings / Studio integrations |
| GET/POST | `/api/v1/fs/list`, `mkdir`, `search-dirs` | Local folders under music_root |
| POST | `/api/v1/download` | yt-dlp NDJSON stream (`downloadId`, `url`, `outputDir`) |
| POST | `/api/v1/download-cancel`, `download-flat-count` | Cancel / playlist count |
| POST | `/api/v1/youtube-explore-search`, `youtube-releases-list` | YT Music explore / releases |
| GET | `/api/v1/catalog-web-discover` | New releases (Innertube) |
| GET/POST | `/api/v1/artwork/search`, `apply`, `upload` | Cover search / save |
| POST | `/api/v1/album-info/*`, `track-info/*`, `discogs/*` | Metadata fetch/apply |
| GET/POST | `/api/v1/entity-info`, `search`, `save` | Curiosità read / Wikipedia search / persist |
| GET | `/media/{rel_path}` | Audio stream (HTTP Range) |
| GET/PUT/PATCH | `/api/v1/user-state` | Per-account prefs (playCounts, recent, moods, excludes) + `revision` (409 on conflict) |
| GET/POST/DELETE | `/api/v1/user-state/custom-theme-bg` | Serve / upload (`multipart` field `file`) / clear custom theme background (JPEG/PNG/WebP/GIF, max 32 MiB) |
| GET | `/api/v1/diagnostics` | Version, uptime, DB counts, scanning |
| GET | `/api/v1/activity-log` | Recent JSONL activity entries |
| GET | `/api/v1/remote-access` | LAN URL, tunnel status, Cloudflare login flag, `cloudflaredAvailable` |
| POST | `/api/v1/remote-access/start` | Start temporary cloudflared quick tunnel (or use `REKORD_PUBLIC_URL`) |
| POST | `/api/v1/remote-access/stop` | Stop tunnel / clear public URL |
| POST | `/api/v1/remote-access/login` | Mark Cloudflare login + return dashboard URL |
| POST | `/api/v1/remote-access/logout` | Logout flag + stop tunnel |
| GET | `/api/v1/backup/theme-export` | Shareable theme ZIP (`rekord-theme/`) for the current account |

Track/Album JSON may include `genre`, `release_date`, `lyrics` (tracks) and `genre`/`label`/`expected_track_count` (albums) from tags or Studio meta.

Account resolution: query `accountId`, or headers `X-KORD-Account-Id` / `X-REKORD-Account-Id`, else default account `default` (“Locale”).

Library scan is **folder-first**: `Music/Artist/Album/track`. Tags are used only for title/duration/track number.

### Backup / restore

- **v3 (next):** ZIP includes `config/manifest.json` (`kordBackup: 3`), `config/settings.json`, `config/accounts.json`, `hub/accounts/{id}/favorites.json|playlists.json|library-selection.json|user-state.json` (+ optional `theme-bg.jpg`), library sidecars under `libraries/shared/`, and `kord-db/` (mirror of `music_root/.kord`). Also `config/youtube-cookies.txt` / activity when present.
- **v2 (legacy):** ZIP from the React hub. Restore reads `config/music-root.config.json` + `config/manifest.json`, extracts `kord-db/` → `music_root/.kord`, imports registry from `kord-db/global_info/accounts.json` (or manifest `accounts`), and for each `{id}_info/user-state.json` migrates favorites/playlists into SQLite **and** full prefs into `{data_dir}/accounts/{id}_info/user-state.json` (playCounts, recent, moods, excludes, settings, optional `legacyQueue`). Audio files are **not** in the ZIP — `libraryRoot` must already exist on disk.
- **Theme package:** ZIP with `rekord-theme/rekord-theme.json` (`kind: "rekord-theme"`) + optional background image. `POST …/kord-restore` detects it and applies only theme settings (preset/custom, glass, background) to the current account — no user data. `GET …/theme-export` builds the same format.
- CLI: `rekord-server --restore-zip /path/to.zip [--restore-exit]` restores without HTTP multipart.

The **server** serves the built **client SPA** from `--client-ui` / `REKORD_CLIENT_UI` (fallback: `--admin-ui`) at `/`, so LAN and Cloudflare tunnel URLs are same-origin for UI + API. Native shells may still bundle the UI and point `Server URL` at the hub.

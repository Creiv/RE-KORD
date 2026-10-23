# RE-KORD API (`/api/v1`)

Default base URL: `http://127.0.0.1:7420`. The hub listens on `0.0.0.0:7420`, so the same API is reachable on the LAN and through the remote-access tunnel.

Envelope (JSON):

```json
{ "ok": true, "data": {} }
{ "ok": false, "error": "snake_case_code", "message": "optional English detail" }
```

`error` is a stable code the client translates (see [Error codes](#error-codes)); `message`, when present, is an untranslated detail for logs and tooltips.

## Endpoints

**Deprecated aliases.** Every `/api/<path>` route without `v1` (`/api/health`,
`/api/accounts`, `/api/config`, `/api/download`, `/api/catalog…`, `/api/fs/…`,
`/api/artwork/…`, `/api/album-info/…`, `/api/track-info/…`, `/api/entity-info…`,
`/api/discogs/…`, `/api/backup/…`, `/api/network/public-ip`, …) is an alias of its
`/api/v1/<path>` twin kept for RE-KORD 4 clients. Aliases answer with `Deprecation: true`
and `Link: </api/v1/<path>>; rel="successor-version"`, the hub logs their first use, and
they are removed in 6.0. The RE-KORD 5 clients use `/api/v1` only.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/events` | Server-sent events (hub ≥ 5.3): `event: hello` first, then `jobs` (a job started, progressed, finished, was cancelled or cleared; at most one every 400 ms per client, the last one kept), `library` (`{ indexEpoch }` after a scan; `{ lagged: true }` when the client fell behind), `userState` (`{ accountId, revision }` after a save), `remoteAccess` (`{ status }`), `downloads`. Hints only: re-read the matching endpoint. Keep-alive comment every 25 s; never compressed; needs the access key as `?accessKey=` like media |
| GET | `/api/v1/health` | Service health → `{ ok, service: "RE-KORD", version, apiVersion: 1, minClientVersion: "5.0.0", transcode, modules, scanning, accessKey }` (see [Versioning](#versioning-and-client-compatibility); minimal body without the [access key](#access-key)) |
| GET | `/api/v1/library` | List tracks (`limit`, `offset`) |
| GET | `/api/v1/library/stats` | Counts for the requesting account's library selection (`track_count`, `album_count`, `artist_count`, `albums_without_cover`, `albums_without_meta`, `tracks_without_meta`, `loose_album_count`, `genre_count`), `catalog_track_count` (whole catalog), `index_epoch` (bumped by every scan / folder rescan), last scan, optional `disk_total_bytes` / `disk_available_bytes` |
| GET | `/api/v1/library/search?q=` | Full-text track search (FTS over title, artist, album, genre; accent-insensitive; every word is a prefix; file paths and track-number prefixes never match). `limit` default 100, max 500. `scope=all` → `{ tracks, albums, artists }`: albums / artists matching by name (album title, folder, artist) or by genre of the album or its tracks. Without `scope` the bare track list (compat) |
| GET | `/api/v1/library/genres` | Canonical genres of the account's library → `[{ key, label, track_count, album_count, artist_count }]`, most common first |
| GET | `/api/v1/library/albums` | List albums |
| GET | `/api/v1/library/albums/{id}` | Album by id |
| GET | `/api/v1/library/albums/{id}/tracks` | Album tracks |
| GET | `/api/v1/library/artists` | List artists |
| GET | `/api/v1/library/artists/{id}` | Artist by id |
| GET | `/api/v1/library/artists/{id}/albums` | Albums of artist |
| GET | `/api/v1/library/tracks/{id}` | Track by id |
| GET/PUT | `/api/v1/library/path` | Music root path |
| POST | `/api/v1/library/scan?mode=incremental\|full` | Scan library (default incremental: upsert by path, skip unchanged size+mtime, prune missing files/albums/artists; `full` re-reads every tag). Curated values (see below) are never replaced by tags. After the scan: the one-time legacy import when pending (see [Legacy import](#legacy-import)), else sidecar values for fields nobody curated yet. Personal data is never re-imported by scans. Report includes `indexEpoch` |
| GET | `/api/v1/legacy-import` | Legacy import status: `kordFound`, `pending`, `optedOut`, `importedAt`, `lastReport` (machine operation) |
| POST | `/api/v1/legacy-import` | Run the legacy import (`?dryRun=true` previews, `?force=true` re-merges accounts already imported from unchanged files); returns `LegacyImportReport` (totals and per-account counts, unmatched paths). `/api/v1/library/sync-legacy-meta` is an alias |
| POST | `/api/v1/library/sync-legacy-meta` | Alias of `POST /api/v1/legacy-import`. Explicit merge: curated metadata from `music_root/.kord/rekord.db` (wins over tags, never over what a person typed in RE-KORD 5) then sidecars; merge personal moods/excludes/settings/playCounts/recent, Plectr records, favorites, playlists (matched by legacy playlist id), library selection + accounts registry from `.kord` into what the hub already has (nothing on the hub is deleted) |
| GET | `/api/v1/library/tracks-page` | Paginated personal library (`limit`, `offset`) → `{ items, total, revision }` |
| GET | `/api/v1/library/artists-page` | Paginated artists (`limit`, `offset`) → `{ items, total }` |
| GET | `/api/v1/library/changes?revision=` | Delta since a revision: `{ revision, updated, removed, full }` (`full: true` → page again) |
| POST | `/api/v1/library/probe` | Analyse folder structure and suggest a layout (machine operation) |
| GET/PUT | `/api/v1/library/layout` | Read / write `music_root/.kord/library-layout.json` |
| GET/PUT | `/api/v1/library/watch` | Filesystem watcher status / enable-disable (debounced incremental scan) |
| POST | `/api/v1/library/thumbnails` | Start the cover thumbnail backfill as a job |
| GET/PUT | `/api/v1/library/embedded` | Embedded tags and covers → `{ enabled, priority: "studio"\|"embedded", pendingTracks, pendingAlbums, running, overrideStudio }`. PUT `{ enabled?, priority? }` (machine operation) saves `settings.json` → `embedded_metadata` and, when something changed, re-reads the library in the background (job `embeddedTags`). 400 `invalid_embedded_priority`, 500 `settings_save_failed` |
| POST | `/api/v1/library/embedded/reread` | "Re-read embedded metadata" (machine operation): every track's tags and every album without a folder cover are read again by the `embeddedTags` job. Values from the tags are refreshed, curated ones kept. Body `{ overrideStudio?: true }` also replaces typed values, only with the `embedded` priority (`overrideStudio` in the answer says whether it applies). Returns the status above |
| GET/DELETE | `/api/v1/jobs` | Background jobs (scan, thumbnails, embeddedTags, restore, sync-legacy) with progress / drop finished entries |
| GET | `/api/v1/jobs/{id}` | One job → `{ "ok": true, "data": Job }`, 404 when unknown |
| POST | `/api/v1/jobs/{id}/cancel` | Cancel a cancellable job |
| GET/DELETE | `/api/v1/diagnostics/errors` | Recent WARN/ERROR ring buffer (`limit`) / clear it |
| GET | `/api/v1/network/public-ip` | Public IP (best effort, `null` when offline) |
| GET/PUT | `/api/v1/system/machine-access` | Machine-operation rights; `PUT { "enabled" }` toggles remote admin (local only) |
| GET/PUT/DELETE | `/api/v1/system/access-key` | The hub's [access key](#access-key): `GET` → `{ enabled, source: "off"\|"env"\|"settings", lockedByEnv }` (no digest, never the key). `PUT { "key" }` sets or replaces it (same rules as `REKORD_ACCESS_KEY`: 400 `access_key_weak`, message without the value) and `DELETE` removes it; both are machine operations, 409 `access_key_from_env` while the variable is set. Takes effect at once; only the SHA-256 digest is saved (`settings.json` → `access_key_sha256`) |
| GET/PUT | `/api/v1/system/power` | Sleep prevention setting and live status; `PUT` is a machine operation — see [Sleep prevention](#sleep-prevention) |
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
| GET | `/api/v1/modules` | Optional module registry (manifest modules plus `podcasts`, enabled from the admin panel) |
| GET | `/api/v1/podcasts`, `/podcasts/sources/{id}`, `/podcasts/play/{id}/{key}`, `/podcasts/art/{id}/{key}` | Podcasts & news (optional module, 404 `podcasts_disabled` while off) — see [Podcasts & news](#podcasts--news-optional-module) |
| GET/PUT/POST/DELETE | `/api/v1/podcasts/admin…` | Podcasts & news settings and sources (writes: machine operation) |
| GET | `/api/v1/covers/album/{id}` | Album cover image (folder cover.jpg…, else the legacy `.kord/artwork` registry, else the picture embedded in its files, stored in `<data_dir>/covers/embedded`). `?size=128\|256` serves a cached thumbnail; `?v=<cover_version>` is ignored server-side (cache busting) and makes the response `immutable` for a year, otherwise `max-age=300`. `ETag` + `If-None-Match` → 304. Missing cover → 404 with `Cache-Control: public, max-age=3600` |
| GET | `/api/v1/covers/artist/{id}` | Artist cover (first album with cover), same `?size=` |
| GET | `/api/v1/backup/kord-data` | Download hub backup ZIP (`kordBackup: 3`) |
| POST | `/api/v1/backup/kord-restore` | Restore ZIP (`multipart` field `file`; v2/v3; body limit 512 MiB) |
| GET/POST/DELETE | `/api/v1/config` (+ youtube-cookies, discogs-token) | Hub settings / Studio integrations |
| GET/POST | `/api/v1/fs/list`, `mkdir`, `search-dirs` | Local folders under music_root |
| POST | `/api/v1/fs/delete-audio-relpaths` | Delete audio files (`{ "relPaths": [...] }`) → `{ deleted, skipped, affectedAlbums }`. Only plain audio files inside the library; a path that resolves elsewhere (`..`, symlink) or is already gone lands in `skipped` |
| POST | `/api/v1/fs/delete-album-folder` | Delete an album folder whole (`{ "albumPath" }`, at least `Artist/Album` deep and holding audio) → `{ deleted, deletedFolder, affectedAlbums }` |
| POST | `/api/v1/download` | yt-dlp NDJSON stream (`downloadId`, `url`, `downloadKind`, `outputDir`, `background`) — see [Downloads](#downloads) |
| GET | `/api/v1/download/active` | Running and recently finished downloads (`progress`, `logTail`, `canCancel`, `done`); `?downloadId=…&stream=1` re-attaches an NDJSON stream |
| POST | `/api/v1/download-cancel` | Cancel (`{ downloadId }`) → `{ found, status }` |
| POST | `/api/v1/download-flat-count` | Playlist size → `{ count, known }`; `count: null, known: false` (plus `error`) when yt-dlp cannot tell — never 0 |
| POST | `/api/v1/tools/ytdlp/update` | Install the latest official yt-dlp (machine operation) — see [Tools](#tools-yt-dlp-ffmpeg-cloudflared) |
| POST | `/api/v1/youtube-explore-search`, `youtube-releases-list` | YT Music explore / releases |
| GET | `/api/v1/catalog-web-discover` | New releases not in the library (Innertube): random 36 albums + 36 singles; `hl` / `gl` (or `locale`, else `Accept-Language`, else `it`/`IT`). Singles are recovered from the albums feed (`Single • …` items) when the singles feed fails (`singlesRecovered: true`). Feed failures are listed in `errors: [{ feed, code, message }]`; `error` is set only when a section could not be filled. "Already in library" = exact accent/case-insensitive artist + album match |
| GET | `/api/v1/catalog-web-tracks` | Track list of a release page (`url`): Innertube browse, yt-dlp flat playlist as fallback |
| GET | `/api/v1/catalog-web-preview` | Resolve a ~30s audio-only audition for a watch `url` → `{ playUrl, expiresInSecs }` (token valid **300 s**; 403 `ytdlp_disabled` with `ENABLE_YTDLP=0`; 422 `no_audio_format` / `video_unavailable` / `preview_resolve_failed`, 503 `ytdlp_not_found`, 504 `preview_timeout`) |
| GET | `/api/v1/catalog-web-preview/stream` | Proxy the audition audio for a token (`t`); honours `Range`, else serves the first `REKORD_PREVIEW_INITIAL_RANGE_BYTES` (default 512 KiB). Upstream failures never pass through as empty bodies: 410 `preview_expired` (unknown / expired token, dead upstream URL), 502 `preview_upstream_forbidden` (upstream 403), 502 `preview_upstream_error`, 429 `upstream_rate_limited` |
| GET/POST | `/api/v1/artwork/search`, `apply`, `upload` | Cover search → `{ results, errors }` (`errors`: sources that failed, results partial) / apply / upload → `{ saved, albumPath, coverRelPath, coverVersion }` |
| POST | `/api/v1/album-info/fetch` | `{ albumPath \| albumId, artist?, album?, overwriteTitle? }` (`overwriteTitle`: replace the album name with the fetched title, never over a name a person typed) |
| POST | `/api/v1/album-info/*`, `track-info/*`, `track-info/prune-orphans`, `studio/sanitize-track-titles`, `track-lyrics/fetch`, `discogs/*` | Metadata / prune / sanitize titles / LRCLIB / Discogs |
| GET/POST | `/api/v1/entity-info`, `search`, `save` | Curiosità read / multi-source search (`{ artist, album?, lang?, folderArtist?, folderAlbum? }` → `{ candidates, errors, page, lang }`, saved ones flagged) / persist (`add`, `removeIds`, `edit`, `imageUrl`) |
| POST | `/api/v1/entity-info/batch-targets` | Targets of a curiosità batch: `{ artist, scope: "artist" \| "albums", albums? }` → `{ targets: [{ key: "artist" \| "Artist/Album", album, label }] }` |
| POST | `/api/v1/entity-info/batch-search` | Search every target (nothing written): `{ artist, scope, albums?, lang?, stream? }` → `{ rows: [{ key, album, label, candidates, errors, saved, error? }] }`; `stream: true` → NDJSON `{type:"progress",done,total,key}` lines then `{type:"done", ok, data: { rows } \| error, message}` |
| POST | `/api/v1/entity-info/batch-save` | Save reviewed items (library write): `{ artist, rows: [{ album?, add, removeIds, edit: [{ id, text?, title? }], imageUrl? }] }` → `{ results: [{ key, album, saved, duplicates, total, image?, error? }] }` |
| POST | `/api/v1/entity-info/batch-auto` (alias `batch`) | Search and save every new candidate (library write); same body / streaming as `batch-search` → `{ results }` |
| GET/HEAD | `/media/{rel_path}`, `/api/v1/media/{rel_path}` | Audio stream: HTTP Range, `If-Range`, `ETag` / `Last-Modified` → 304, 416 with `Content-Range: bytes */len`. `.m4a` is `audio/mp4`; `Cache-Control: private, max-age=31536000` |
| GET/HEAD | `/api/v1/transcode/{rel_path}?format=mp3\|aac` | On-the-fly transcode for cast receivers (see below) |
| GET/PUT/PATCH | `/api/v1/user-state` | Per-account prefs (playCounts, recent, moods, excludes) + `revision`. PUT/PATCH accept `expectedRevision`; on mismatch → 409 `{ "ok": false, "error": "revision_conflict", "current": <state> }` |
| GET/POST/DELETE | `/api/v1/user-state/custom-theme-bg` | Serve / upload (`multipart` field `file`) / clear custom theme background (JPEG/PNG/WebP/GIF, max 32 MiB) |
| GET | `/api/v1/diagnostics` | Version, uptime, DB counts, scanning, jobs, watcher, recent errors, disk space, library layout, and `binaries.{ytdlp,ffmpeg,ffprobe,cloudflared}`: `{ available, path, source, version, candidates[] }` (+ `releaseDate`, `ageDays`, `stale` — older than 60 days — for yt-dlp). Versions are cached 10 min (`versionCacheTtlSecs`) |
| GET | `/api/v1/activity-log` | Activity JSONL entries (`ts`, `kind`, `message`, optional `accountId` / `accountName`). Query: `day=YYYY-MM-DD` (Default only, local calendar day), `since` (RFC3339), `scope=all\|system\|user` + `filterAccountId` (Default only; ignored for others → `scope=all`), `limit` (max 2000). Non-default callers are always clamped to the last 24h server-side (`canSelectDay: false`). Response includes `window`, `scope`, `canSelectDay`. |
| GET | `/api/v1/remote-access` | LAN URL, tunnel status (`stopped` / `starting` / `running` / `error`), `publicUrl`, `error` (English detail) and `errorCode` (`cloudflared_not_found`, `tunnel_start_timeout`, `tunnel_exited_early`, `tunnel_exited`, `tunnel_failed`), Cloudflare login flag, `cloudflaredAvailable` (cached, never runs a subprocess; LAN addresses cached 10 s) |
| POST | `/api/v1/remote-access/start` | Start temporary cloudflared quick tunnel (or use `REKORD_PUBLIC_URL`) |
| POST | `/api/v1/remote-access/stop` | Stop tunnel / clear public URL |
| POST | `/api/v1/remote-access/login` | Mark Cloudflare login + return dashboard URL |
| POST | `/api/v1/remote-access/logout` | Logout flag + stop tunnel |
| GET | `/api/v1/backup/theme-export` | Shareable theme ZIP (`rekord-theme/`) for the current account |

Track/Album JSON may include `genre`, `release_date`, `lyrics` (tracks) and `genre`/`label`/`expected_track_count` (albums) from tags or Studio meta.

**Display model** (all additive, existing fields keep their names):

- Tracks (`/library`, `tracks-page`, `search`, `changes`, album / playlist / favorite tracks, `tracks/{id}`): `title` is the display title (tag title; when missing or just the file name, the file name cleaned like legacy `sanitizeLocalTrackTitleDisplay`: no `01 - ` prefix, no `[…]` / `(Official Video)` / `(Remaster)` cruft; musical versions such as `(Remix)`, `(Live)`, `(Acoustic)`, `(feat. …)` stay). `track_number` falls back to the file name (`07 - x`, `1-07 x`). New: `file_name`, `disc_number`, `genres` (array of canonical labels: `genre` split on `;` `/` `,` `|`, numeric / stub tokens dropped, one label per case/space/hyphen-insensitive key, e.g. `["Hip Hop", "Pop Rap"]`), `has_cover` / `cover_version` (of the album; skip cover requests when `has_cover` is false, append `?v=cover_version`), `added_at`, `updated_at` (RFC3339), `user_edited` (a person edited it), `curated_fields` (fields whose curated value wins over tags: `title`, `release_date`, `genre`, `track_number`, `disc_number`, `lyrics`). 5.1: `embedded_fields` (values taken from the file's tags: the fields above plus `bpm`, `album`, `artist`, `album_artist`, `track_total`, `disc_total`, `musicbrainz`), `track_artist` (artist tag; `artist_name` stays the library artist), `album_artist`, `track_total`, `disc_total`, `musicbrainz: { recording_id, release_id, artist_id, release_group_id }` (only the ids present; omitted when none). See [supported-formats.md](supported-formats.md#tags).
- Albums (5.1): `cover_source` (`folder`, `legacy`, `embedded`; omitted without a cover), `album_artist` (the tracks' album-artist tag), `musicbrainz_release_id`, `embedded_fields` (`genre` / `release_date` derived from the tracks' tags, `album_artist`, `musicbrainz`).
- Albums: `name` is the display title (curated title, else the most common album tag, else the folder name; full-width `？` `：` → `?` `:`, `Album - ` prefix dropped). New: `folder_name` (on disk), `genres`, `cover_version`, `added_at`, `updated_at` (title / dates / genre / cover / track list changed: order "recently updated" by it), `user_edited`, `curated_fields`.
- Dates are stored as precise as the source: `YYYY-MM-DD`, `YYYY-MM` or `YYYY` (`YYYYMMDD` and timestamps are normalised). A curated date (sidecar, legacy, Studio) wins over tag dates (e.g. yt-dlp upload dates); a bare curated year never replaces a full tag date of the same year.
- Curated values: sidecars (`kord-albuminfo.json` / `kord-trackinfo.json`), the legacy library DB, Studio saves and metadata fetches. Rescans never replace them with tag values; values a person typed (`user_edited`) are not replaced by fetches or imports either.

### Legacy import

On the first scan of a library that has a legacy `.kord` folder (and on the first start of a hub that already indexed one) the hub imports it: curated metadata (titles, full dates, genres, track/disc numbers, `user_edited`, added/updated times), the accounts registry (same id, then same name; others created with legacy id and name; `default` stays "Default"), and per account settings, favorites, playlists (keyed by legacy playlist id, legacy order), library selections, play counts, recents, moods, blocked tracks and albums, theme backgrounds and Plectr records (`plectrBests` → `settings.plectr`). Accounts already used on the new hub are merged, never overwritten (hub settings, selection, theme and language win; play counts keep the max). Folders of accounts missing from the legacy registry are skipped. The outcome is recorded in `<data_dir>/legacy-import.json` (version 2: per-account digest of the legacy files, last report); afterwards scans and restarts never import again, and manual runs skip accounts whose legacy files are unchanged, so data cleared after the import stays cleared. A version-1 marker (early 5.0 builds, which skipped accounts in use) triggers one more automatic run. `REKORD_SKIP_LEGACY_IMPORT=1` disables it; `POST /legacy-import` stays available.

Responses with JSON / JS / CSS / HTML / SVG bodies over 1 KiB are compressed (br / gzip per `Accept-Encoding`); media and images never are. Served UIs: hashed `/assets/*` get `Cache-Control: public, max-age=31536000, immutable`, `index.html` (SPA fallbacks) and `sw.js` get `no-cache`. Albums may also expose read-only Discogs fields when present: `discogs_release_id`, `discogs_uri`, and `discogs_extra` (`formatSummary`, `catalogNo`, `discogsUri`, `masterId` — camelCase, legacy parity).

Account resolution: query `accountId`, or headers `X-KORD-Account-Id` / `X-REKORD-Account-Id`, else default account `default` (named “Default”, as in legacy; a name the user chose is never rewritten).

Account registry writes are serialised and atomic (concurrent creates never lose entries). Deleting an account removes `accounts/<id>/`, `accounts/<id>_info/` (user-state, theme background) and its favorites / playlists rows. Errors: `account_not_found` (404), `cannot_delete_default_account`, `last_account` (403), `invalid_account_id`, `account_create_failed`, `account_update_failed`, `account_delete_failed`.

Every response carries `x-request-id` (echoed from the request when provided) to correlate client actions with hub logs.

**Account ids** match `[A-Za-z0-9_-]{1,64}`. An unknown id gets 404 `account_not_found` (it no longer falls back to Default).

### Podcasts & news (optional module)

Off by default (`settings.json` → `podcasts.enabled`). While it is off, the client endpoints below answer **404 `podcasts_disabled`** and the hub does no work for the module; `/health` → `modules` lists `podcasts` only when it is on. There is no background polling: a source is fetched when a client asks for it, and its latest episodes (metadata only, never audio) are cached in SQLite (`podcast_sources`, schema v6) for `cacheTtlMinutes` (default 30, 5–1440).

Client endpoints (any account):

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/podcasts` | Every source with its latest episodes → `{ sources: [Source], cacheTtlMinutes }`. Stale sources are fetched now (at most 4 at once, conditional `If-None-Match` / `If-Modified-Since` for feeds); the answer waits at most 25 s, slower fetches land in the cache for the next call. `?refresh=1` forces a fetch unless the last one is under 30 s old. A failed fetch keeps the previous episodes and sets `error` (code); automatic retries wait 60 s |
| GET | `/api/v1/podcasts/sources/{id}` | One source, same rules (`?refresh=1`) |
| GET/HEAD | `/api/v1/podcasts/play/{id}/{key}` | Proxied audio of an episode (`key` from the list) or of a live source (`key` = `live`). `Range` / `If-Range` pass through (206 / 416 with the upstream `Content-Range`), the body is streamed, `Cache-Control: no-store`. Only episodes of configured sources are reachable (no URL parameter exists); an episode stays playable for 6 h after a refresh dropped it. Every redirect hop is checked against the SSRF guard. Limits: 8 streams at once (503 `podcast_proxy_busy`), 45 s without data, 4 h per response (8 h for live), pace capped at 2 MiB/s after a 4 MiB burst. yt-dlp sources resolve the audio URL on play (cached 20 min) |
| GET | `/api/v1/podcasts/art/{id}/{key}` | Artwork as a 400 px JPEG thumbnail (`key` = `_` for the source), made once and kept in `<data>/cache/podcast-art` (300 files at most); `Cache-Control: public, max-age=86400`; 404 when there is none |

`Source`: `{ id, name, kind: "rss"|"rtl"|"ytdlp"|"live", live, episodeCount, hasArt, fetchedAt, error, episodes: [{ key, title, publishedAt, durationSecs, hasArt, mime, live }] }`. Upstream URLs are never sent to clients.

Admin endpoints (reads open, writes are **machine operations**):

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/podcasts/admin` | `{ enabled, cacheTtlMinutes, ytdlpEnabled, limits: { maxSources: 50, maxEpisodes: 20, defaultEpisodes: 3, minTtlMinutes, maxTtlMinutes }, sources: [Source + url, nameCustom, position, errorAt, createdAt] }` (no fetch) |
| PUT | `/api/v1/podcasts/admin/settings` | `{ enabled?, cacheTtlMinutes? }` → admin payload |
| POST | `/api/v1/podcasts/admin/test` | `{ url, episodeCount? }` → `{ kind, live, title, hasArt, episodes }`: detection preview, nothing saved |
| POST | `/api/v1/podcasts/admin/sources` | `{ url, name?, episodeCount? }` → the saved source (detected like `test`; the name follows the feed title unless given) |
| PUT | `/api/v1/podcasts/admin/sources/{id}` | `{ name?, episodeCount?, url? }`; an empty `name` goes back to the feed title, a new `url` is detected again, a new `episodeCount` invalidates the cache |
| DELETE | `/api/v1/podcasts/admin/sources/{id}` | Remove a source |
| PUT | `/api/v1/podcasts/admin/order` | `{ ids: [...] }` → admin payload (unlisted sources keep their order after) |

Detection of a URL, in order: a play.rtl.it programme archive (`/archivio/<b>/podcast/info/<slug>/`, read through RTL's public JSON API; its RSS feed is the fallback); an audio response (live stream; `icy-name` names it); an `.m3u` / `.pls` playlist (first playable stream; HLS `.m3u8` → 422 `podcast_hls_unsupported`); an RSS / Atom feed; an HTML page: its `<link rel="alternate" type="application/rss+xml|atom+xml">` feeds, then known patterns (Apple Podcasts → iTunes lookup, Spreaker, WordPress `/feed/`); finally yt-dlp `--flat-playlist -J --playlist-end N` (unless `ENABLE_YTDLP=0`). Nothing found → 422 `podcast_unsupported_url`. Requests use timeouts (20 s), size caps (feeds 8 MiB), the `RE-KORD/<version> (podcasts)` User-Agent and refuse private, loopback, link-local and CGNAT addresses (`url_not_allowed`), DNS answers included.

### Library and machine operations

Two levels (parity legacy `requestAccess.mjs`, where a loopback request could run every server mutation):

**Library operations** — writes to the library from Studio. **Any account** may run them from the hub machine (local request); a remote client needs `allow_remote_admin` (any account).

- files on disk: `POST …/fs/mkdir`, `POST …/fs/delete-audio-relpaths|delete-album-folder`
- Studio: `POST …/download`, `…/download-cancel`, `GET …/download/active`, artwork `apply` / `upload`, album/track info fetch and save, `track-info/prune-orphans`, `track-lyrics/fetch`, `studio/sanitize-track-titles`, Discogs apply, `entity-info/save|batch-save|batch-auto|batch`
- account create / rename / delete

**Machine operations** — act on the host itself. They require the **Default** account *and* a local client (or `allow_remote_admin`).

- library: `PUT …/library/path`, `POST …/library/scan|thumbnails|sync-legacy-meta|embedded/reread`, `PUT …/library/layout|watch|embedded`
- integrations: `POST/DELETE …/config/youtube-cookies`, `PUT/DELETE …/config/discogs-token`
- podcasts: `PUT …/podcasts/admin/settings|order|sources/{id}`, `POST …/podcasts/admin/test|sources`, `DELETE …/podcasts/admin/sources/{id}`
- tools: `POST …/tools/ytdlp/update`
- backup: `GET …/backup/kord-data` (download) and `POST …/backup/kord-restore` (full restore; a non-admin may only restore a **theme package** up to 32 MiB)
- jobs and diagnostics: job cancel / clear, `DELETE …/diagnostics/errors`
- remote access: `POST …/remote-access/start|stop|login|logout`, `PUT …/system/machine-access`, `PUT`/`DELETE …/system/access-key`
- sleep prevention: `PUT …/system/power`

Refusals are `403` with `error: "forbidden_remote"` (not on the hub machine and remote admin off) or `error: "forbidden_default_account"` (machine operation from another account).

A request counts as local when the peer address is loopback, `Host` is `localhost`/`127.0.0.1`/`::1`, no proxy headers (`cf-connecting-ip`, `cf-ray`, `x-forwarded-for`, `x-forwarded-host`, `x-real-ip`) are present and its `Origin`, if any, is allowed (see CORS) — so a Cloudflare tunnel is remote even though `cloudflared` connects from `127.0.0.1`, and a foreign web page open on the hub machine is never local. `PUT /api/v1/system/machine-access { "enabled": true }` (or `REKORD_ALLOW_REMOTE_ADMIN=1`), callable only from the hub machine, lifts the local requirement. `GET /api/v1/system/machine-access`, `GET /api/v1/config` and `GET /api/v1/remote-access` expose `machineAccess` so clients can gate controls instead of failing on submit:

```json
{ "isDefaultAccount": false, "local": true, "allowRemoteAdmin": false,
  "canManageLibrary": true, "canManageMachine": false,
  "libraryDeniedReason": null, "machineDeniedReason": "forbidden_default_account" }
```

`GET /api/v1/config` also reports `youtubeCookiesWritable` / `discogsWritable` as `false` when the caller cannot manage the machine.

In **Docker** every request reaches the hub from the Docker network, never from loopback: run machine operations with `docker exec rekord curl -X POST http://127.0.0.1:7420/…`, or set `REKORD_ALLOW_REMOTE_ADMIN=1` on a trusted network. The desktop **server flavor** (hub embedded in the Tauri app) is local: its window talks to `127.0.0.1:7420` from an allowed origin.

### Sleep prevention

"Prevent the computer from sleeping" (`settings.json` → `power`). Only system sleep is
blocked; the display may still turn off and lock.

`GET /api/v1/system/power` (open, no side effects):

```json
{ "preventSleep": "whenActive", "graceMinutes": 10, "keepAwakeLidClosed": false,
  "lockedByEnv": false, "platform": "linux",
  "limits": { "minGraceMinutes": 1, "maxGraceMinutes": 120, "defaultGraceMinutes": 10 },
  "status": {
    "inhibiting": true, "reason": "active", "since": "2026-10-08T12:03:00Z",
    "lastActivity": "2026-10-08T12:10:41Z", "lastActivityKind": "stream",
    "activeStreams": 0, "activeJobs": 0, "releaseAt": "2026-10-08T12:20:41Z",
    "method": "systemd-inhibit + gnome-session-inhibit", "supported": true,
    "lidSupported": true, "lidInhibited": false,
    "errorCode": null, "error": null, "lidErrorCode": null, "lidError": null },
  "machineAccess": { … } }
```

- `preventSleep`: `off` (default, nothing runs), `always` (while the hub serves), or
  `whenActive`: while a media / transcode / podcast / preview stream is being sent, a scan,
  job or download runs, or requests arrive through the Cloudflare tunnel (status probes such
  as `/health` excluded), plus `graceMinutes` after the last activity.
- `status.reason`: `always` / `active` while `inhibiting`. `releaseAt`: when the grace
  period ends (`whenActive`, nothing running). `lastActivityKind`: `stream`, `job` or
  `remote`.
- `status.method`: `systemd-inhibit` (Linux, systemd-logind inhibitor `sleep:idle`, plus
  `handle-lid-switch` with `keepAwakeLidClosed`; plus `gnome-session-inhibit` in a GNOME
  session), `SetThreadExecutionState` (Windows), `caffeinate` (macOS).
- `status.errorCode`: `power_unsupported` (no systemd, a container, another OS),
  `power_refused` (polkit), `power_failed`; `error` is the platform's English detail. After
  a failure the lock is retried on the next settings change, or on activity 10 minutes later.
  `lidErrorCode` reports a refused lid lock while sleep itself is blocked.
- `lockedByEnv`: `REKORD_PREVENT_SLEEP` / `--prevent-sleep` sets the mode.

`PUT /api/v1/system/power` (machine operation) `{ preventSleep?, graceMinutes?,
keepAwakeLidClosed? }` saves and applies at once (no restart) and answers with the `GET`
payload. `graceMinutes` is clamped to 1–120; `preventSleep` also accepts `when-active`.
Errors: 400 `invalid_prevent_sleep`, 409 `power_locked_by_env` (changing a mode locked by
the environment; the other fields stay writable), 500 `settings_save_failed`.

Taking and releasing the lock is logged at info level, once per transition, and in the
activity log (`power.inhibited` `{ reason }`, `power.released`, `power.failed` `{ code }`;
settings changes as `power.settings` `{ mode, graceMinutes, lid }`).

### Access key

When the hub has an access key (set in the admin panel or with `REKORD_ACCESS_KEY`, see
[SECURITY.md](../SECURITY.md#optional-access-key)),
every request to `/api`, `/api/*` (legacy aliases without `v1` included) and `/media/*` must
present the key:

- header `X-Rekord-Access-Key: <key>` for API calls (allowed by CORS like any other request
  header);
- query parameter `accessKey=<key>` for URLs that cannot carry headers: `/media/*`,
  `/api/v1/transcode/*`, covers, podcast art and play URLs, preview streams, downloads, Cast.

The header wins when both are present. The hub removes the key from the header and the query
string before routing, so handlers, redirects and logs never see it. Public without the key:
the static UI (`/`, `/assets/*`, `/admin` page shell, `sw.js`, manifest) and CORS preflights.
Local requests are not exempt.

`GET /api/v1/health` (and `/api/health`) answers:

| Request | Status | Body |
|---|---|---|
| no key, hub has one | 200 | `{ ok, service: "RE-KORD", apiVersion, minClientVersion, accessKey: "required" }` (no `version`, `modules`, `transcode`, `scanning`) |
| right key | 200 | full body + `accessKey: "ok"` |
| hub without a key | 200 | full body + `accessKey: "off"` |
| wrong key | 401 | `access_key_invalid` — this is how clients validate a key |

Refusals use the usual envelope (`{ ok: false, data: null, error, message }`), with
`Cache-Control: no-store` and no `WWW-Authenticate` (browsers must not show a login dialog):

- `401 access_key_required` — no key presented;
- `401 access_key_invalid` — wrong key;
- `429 access_key_rate_limited` + `Retry-After` (seconds) — a wrong key from a source that
  sent five distinct wrong keys within 60 s; for the next 60 s its wrong keys get this
  answer. The right key is never refused, lock or not. The source is the peer address
  (IPv6 by `/64`); `X-Forwarded-For` and `CF-Connecting-IP` are not used.

At startup the hub also refuses weak keys (fewer than 10 different characters, or a short
block repeated) and recommends `openssl rand -hex 32`; the value is never printed.

```bash
K=$(cat /path/to/key)
curl -H "X-Rekord-Access-Key: $K" http://127.0.0.1:7420/api/v1/library/albums
curl -H 'Range: bytes=0-99' "http://127.0.0.1:7420/media/Artist/Album/01.flac?accessKey=$K"
```

### CORS

The hub listens on the LAN and on loopback, so any web page open on a machine of the network could otherwise script it. Allowed browser origins:

- the same origin (`Origin` host equals `Host` / `X-Forwarded-Host`): the hub-served SPA and admin panel, also through the Cloudflare tunnel;
- the Tauri shells: `tauri://localhost` (macOS, Linux), `http://tauri.localhost` (Windows, Android), `https://tauri.localhost`;
- the Vite dev servers: `http://localhost:7421|7422`, `http://127.0.0.1:7421|7422`;
- anything listed in `REKORD_ALLOWED_ORIGINS` (comma separated, e.g. `https://music.example.org`).

A foreign origin gets `403 cross_origin_forbidden` on mutating methods and no `Access-Control-Allow-Origin` on reads (requests without `Origin` — curl, the native media service fetching artwork — are unaffected). Every response also carries `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` and a restrictive `Permissions-Policy`.

**Body limits:** 2 MiB by default; restore 512 MiB, theme background 33 MiB, artwork upload 16 MiB, YouTube cookies 3 MiB.

### Versioning and client compatibility

`GET /api/v1/health` declares:

- `version` — the hub version (workspace version, e.g. `5.2.0`);
- `apiVersion` — the `/api/v1` contract revision (`api::API_VERSION`, currently `1`); it only grows on a breaking change;
- `minClientVersion` — the oldest client the hub accepts (`api::MIN_CLIENT_VERSION`);
- `transcode` — whether `/api/v1/transcode` is usable (ffmpeg found).

Native clients (Tauri desktop / Android) bundle the UI, so they no longer update with the hub. The client (`src/lib/platform/compat.ts`) compares those fields with its own version and shows a banner: blocking warning when it is below `minClientVersion` or `apiVersion` is newer than it knows, a dismissible notice when the hub is ahead (or behind) by a minor/major version. The browser client served by the hub only offers a reload when the page it runs is older than the hub (stale cache / service worker).

### Transcode

`GET /api/v1/transcode/{relPath}?format=mp3|aac|flac[&bitrate=64..320]` — on-the-fly transcode for cast receivers (Chromecast / Google Home) that can't decode FLAC/OGG/Opus/WAV, and cached FLAC copies for players that can't decode WMA/AIFF/ALAC.

- `relPath`: same library-relative path as `/api/v1/media/{relPath}`, same validation (no `..`, reserved or hidden segments, must resolve inside the music root).
- `format`: `mp3` (default, 320 kbps, `audio/mpeg`) or `aac` (256 kbps ADTS, `audio/aac`) for live streams; `flac` for a lossless copy (see below).
- Response: 200 chunked stream of ffmpeg stdout; no `Content-Length`, `Accept-Ranges: none`, `Cache-Control: no-store`. `HEAD` returns the headers only. ffmpeg is killed when the client disconnects.
- Errors: 404 track not found / invalid path; 400 `unsupported_format`; 503 `ffmpeg_unavailable` (ffmpeg not installed); 503 `transcode_busy` (4 transcodes already running).
- Check `GET /api/v1/health` → `"transcode": true` before offering it.

ffmpeg is located like the other tools (see below).

### Tools (yt-dlp, ffmpeg, cloudflared)

Each tool is looked up in these places, in order; when several exist the **newest `--version` wins** (ties go to the earlier one):

1. yt-dlp only: config `ytdlp_path` (settings), `YTDLP_PATH`; then the copy installed by the update below, `<data_dir>/tools/yt-dlp`
2. ffmpeg: `REKORD_FFMPEG`, `FFMPEG_PATH`, `REKORD_FFMPEG_BIN`; ffprobe: `REKORD_FFPROBE`, `FFPROBE_PATH`; cloudflared: `REKORD_CLOUDFLARED_BIN`
3. bundled: `<exe dir>/`, `<exe dir>/bin/`, `<exe dir>/../resources/bin/`, `<exe dir>/resources/bin/`, `<exe dir>/../Resources/bin/` (macOS), `REKORD_TOOLS_DIR`; in debug builds `release/bin/<platform>/` of the repository
4. `PATH`

Probes run off the async workers and are cached for 10 minutes (an update invalidates the cache). `GET /api/v1/diagnostics` shows the choice and every candidate.

yt-dlp's JavaScript runtime (YouTube refuses yt-dlp without one) is chosen in priority order, not by version: `REKORD_YTDLP_JS_RUNTIME` (`<name>:<path>`, an absolute path, a name on `PATH`, or `none`); the bundled `qjs` (`REKORD_YTDLP_JS_BIN`, then `qjs`/`deno` in the bundled folders above and next to `YTDLP_PATH`); then `deno`, `node`, `bun` on `PATH`; then `~/.deno/bin/deno`, `~/.bun/bin/bun`, nvm's newest node (`$NVM_DIR` or `~/.nvm`), `/usr/local/bin`, `/opt/homebrew/bin` (Windows: `%USERPROFILE%\.deno\bin`, `%USERPROFILE%\.bun\bin`, `%ProgramFiles%\nodejs`); finally any other `qjs`. Candidates from `PATH` and those folders must answer `--version` and meet the minimum (Deno 2.3, Bun 1.2.11, Node.js 22.23.4 / 24.22.1 / 26.12.1: the October 2026 security releases, odd majors skipped). Every yt-dlp run (downloads, `-J` probes, catalog preview, podcast pages) gets `--js-runtimes <name>:<abs path>`. Diagnostics report it as `binaries.jsRuntime` and `GET /api/v1/download-preset` as `jsRuntime`: `{ available, name, version, path, source: env|bundled|path|common, disabled }`.

`POST /api/v1/tools/ytdlp/update` (`{ "force"?: bool }`, machine operation) downloads the latest official release asset for the platform (`yt-dlp_linux`, `yt-dlp_linux_aarch64`, `yt-dlp.exe`, `yt-dlp_macos`) from GitHub (`REKORD_YTDLP_RELEASE_API` overrides the release JSON URL), verifies it against the release's `SHA2-256SUMS`, checks that it runs, and installs it atomically (temp file + rename, `chmod 755`) as `<data_dir>/tools/yt-dlp`. Response: `{ updated, upToDate, latestVersion, previousVersion, version, source, asset }` — when the yt-dlp in use is already the latest, nothing is downloaded (`upToDate: true`) unless `force`. Errors: 409 `ytdlp_update_in_progress`, 501 `ytdlp_platform_unsupported`, 502 `ytdlp_release_lookup_failed` / `ytdlp_asset_missing` / `ytdlp_download_failed` / `ytdlp_checksum_missing` / `ytdlp_checksum_mismatch`, 500 `ytdlp_install_failed`.

### Downloads

`POST /api/v1/download` `{ url, downloadId (UUID), downloadKind?, outputDir?, background? }` (library operation) answers with an NDJSON stream:

- `started` `{ downloadId, background, ytdlp: { version, source }, ffmpeg, jsRuntime }`
- `progress` `{ progress: { current, total } }` ("Downloading item N of M")
- `item` `{ item: { id, index, title, status: pending|downloaded|skipped|failed, format?, reason?, code?, files? } }` as each item changes
- `log` `{ stream, line }` (yt-dlp output without per-percent progress lines), `keepalive` every 5 s
- `indexing` (success only) while the output folder is re-indexed
- `items` (legacy) then `done`:

```json
{ "type": "done", "downloadId": "…", "ok": true, "partial": true, "cancelled": false,
  "cancelReason": null, "error": null, "code": 1,
  "summary": { "downloaded": 11, "skipped": 0, "failed": 1, "total": 12 },
  "downloadedItems": ["Artist/Album/01 - Title.m4a"],
  "skippedItems": [{ "label": "…", "reason": "already downloaded" }],
  "failedItems": [{ "id": "dQw4w9WgXcQ", "index": 7, "title": "…", "label": "…", "reason": "Requested format is not available…", "code": "no_audio_format" }],
  "items": [], "formats": ["140"], "progress": { "current": 12, "total": 12 },
  "stdout": "…", "stderr": "…", "logTruncated": false, "stdoutTotalChars": 0, "stderrTotalChars": 0,
  "command": "yt-dlp -f … (no absolute paths, no URL)", "outputDir": "Artist/Album",
  "rescanned": true, "rescanError": null, "indexEpoch": 42 }
```

- Items are attributed from the whole output stream (the `[rekord-item]` marker printed by yt-dlp before format selection, `Downloading item N of M`, `[youtube] <id>:` lines), not from the truncated preview.
- Formats are audio only (`bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio`): an item without an audio-only format fails with `no_audio_format`. yt-dlp gets `--ffmpeg-location` (resolved ffmpeg) and `--js-runtimes <name>:<abs>` when a JavaScript runtime is found (see [Tools](#tools-yt-dlp-ffmpeg-cloudflared)).
- `ok`: something was written or already present (or a clean exit without failures). Only then the **output folder** is re-indexed (whole library when `outputDir` is empty) *before* `done`, so `indexEpoch` (same counter as `/library/stats` → `index_epoch`) already covers the new files. After a failure or a cancel nothing is rescanned.
- `done.error` when not ok: `cancelled`, `client_disconnected`, `ytdlp_not_found`, `ytdlp_spawn_failed`, `ytdlp_failed`, or the common item code (`no_audio_format`, `video_unavailable`, …).
- When every stream attached to a download is gone (tab closed, fetch aborted), yt-dlp is stopped (`cancelReason: "client_disconnected"`), unless the download was started with `background: true`.
- `GET /api/v1/download/active` lists this hub's running and finished (kept 15 min) downloads: `{ downloadId, kind, outputDir, accountId, background, status: running|indexing|done|failed|cancelled, startedAt, finishedAt, progress, counts, items, logTail (last 80 lines), canCancel, attachedStreams, cancelReason, done }`. `?downloadId=…` returns one; with `&stream=1` the response is an NDJSON stream starting with `{ type: "snapshot", download: {…} }` followed by live events up to `done` (immediately when already finished) — a client returning to the pane re-attaches this way (or polls).
- Start errors: 403 `ytdlp_disabled`, 400 `url_not_allowed` / `invalid_download_id` / `invalid_output_dir` / `music_root_not_set`, 409 `download_id_active`.

Library scan is **folder-first**: `Music/Artist/Album/track` (other layouts are detected, see [supported-formats.md](supported-formats.md#library-layout)). Embedded tags supply title, artist, album artist, album name, genres, dates, track/disc numbers and totals, BPM, lyrics and MusicBrainz ids; curated values win over them (see [supported-formats.md](supported-formats.md#precedence) for the priority setting).

### Backup / restore

- **v3 (RE-KORD 5):** ZIP includes `config/manifest.json` (`kordBackup: 3`), `config/settings.json`, `config/accounts.json`, `hub/accounts/{id}/favorites.json|playlists.json|library-selection.json|user-state.json` (+ optional `theme-bg.jpg`), library sidecars under `libraries/shared/`, and `kord-db/` (mirror of `music_root/.kord`). Also `config/youtube-cookies.txt` / activity when present.
- **v2 (legacy):** ZIP from the React hub. Restore reads `config/music-root.config.json` + `config/manifest.json`, extracts `kord-db/` → `music_root/.kord`, imports registry from `kord-db/global_info/accounts.json` (or manifest `accounts`), and for each `{id}_info/user-state.json` migrates favorites/playlists into SQLite **and** full prefs into `{data_dir}/accounts/{id}_info/user-state.json` (playCounts, recent, moods, excludes, settings, optional `legacyQueue`). After the library scan, album/track studio metadata is merged from restored sidecars (`kord-albuminfo.json` / `kord-trackinfo.json`) and from `music_root/.kord/rekord.db` into the hub DB (fill-empty). Audio files are **not** in the ZIP — `libraryRoot` must already exist on disk.
- **Account overwrite-by-name:** before writing personal data, restore matches backup accounts to existing hub accounts with the same display name (case-insensitive). Matching accounts keep the hub id and have favorites/playlists/selection/user-state/theme overwritten; unmatched backup accounts are added with their backup id. `default` always maps to `default`.
- **Theme package:** ZIP with `rekord-theme/rekord-theme.json` (`kind: "rekord-theme"`) + optional background image. `POST …/kord-restore` detects it and applies only theme settings (preset/custom, glass, background) to the current account — no user data. `GET …/theme-export` builds the same format.
- CLI: `rekord-server --restore-zip /path/to.zip [--restore-exit]` restores without HTTP multipart.
- CLI: `rekord-server --legacy-import [--legacy-import-dry-run] [--legacy-import-force] [--legacy-import-exit]` (aliases `--sync-legacy-meta`, `--sync-legacy-exit`) runs the same import as `POST /api/v1/legacy-import` and prints the report as JSON.

The **server** serves the built **client SPA** from `--client-ui` / `REKORD_CLIENT_UI` at `/`, so LAN and Cloudflare tunnel URLs are same-origin for UI + API, and the **admin panel** from `--admin-ui` / `REKORD_ADMIN_UI` at `/admin` (also on `/` when no client bundle is present). Native shells may still bundle the UI and point `Server URL` at the hub.

### Error codes

Studio, downloads, tools and permissions answer `{ ok: false, error: "<code>", message? }`:

- permissions: `forbidden_remote`, `forbidden_default_account`, `cross_origin_forbidden`, `invalid_account_id`, `account_not_found`
- access key: `access_key_required` (401), `access_key_invalid` (401), `access_key_rate_limited` (429, `Retry-After`), `access_key_weak` (400, setting a key from the panel), `access_key_from_env` (409, the variable locks the panel)
- generic (5.3): `internal_error` (500, `message` carries the detail), `not_found` (404), `invalid_request` (400). Before 5.3 these answers carried free text in `error`
- library: `album_not_found`, `artist_not_found`, `track_not_found`, `music_root_not_directory`, `scan_in_progress` (409), `entity_info_not_found`
- playlists: `playlist_not_found`, `name_required`, `playlist_tracks_mismatch` (409, reorder with ids that are not the current ones)
- backup and themes: `not_a_zip`, `not_a_theme_archive`, `invalid_theme`, `restore_invalid`, `file_too_large` (413)
- config: `music_root_not_set`, `file_required`, `file_too_large`, `upload_failed`, `cookies_invalid`, `cookies_locked_by_env`, `discogs_token_invalid`, `discogs_token_locked_by_env`
- files: `invalid_path`, `fs_list_failed`, `fs_search_failed`, `mkdir_failed`, `rel_paths_required`, `delete_failed`, `delete_album_failed`
- downloads: `ytdlp_disabled`, `url_not_allowed`, `invalid_download_id`, `invalid_output_dir`, `download_id_active`, `download_not_found`, `download_id_required`, `flat_count_failed`, `ytdlp_not_found`, `ytdlp_timeout`, `ytdlp_failed`, `ytdlp_spawn_failed`, `download_failed`, `cancelled`, `client_disconnected`
- per-item (`failedItems[].code`, preview): `no_audio_format`, `video_unavailable`, `private_video`, `age_restricted`, `members_only`, `geo_blocked`, `sign_in_required`, `http_forbidden`, `postprocess_failed`, `network_error`, `unknown` (skipped: `already_downloaded`)
- YouTube / catalog: `query_too_short`, `youtube_search_failed`, `invalid_releases_url`, `youtube_releases_failed`, `invalid_catalog_url`, `no_tracks_found`, `track_list_failed`, `preview_resolve_failed`, `preview_timeout`, `preview_expired`, `preview_failed`, `preview_upstream_unreachable`, `preview_upstream_forbidden`, `preview_upstream_error`, `preview_range_invalid`, discover feeds `upstream_rejected` / `upstream_unavailable` / `upstream_timeout` / `upstream_failed`
- metadata (codes of `metadata::error::classify` pass through with their status: `album_not_found`, `no_match` (404, track fetch without a close match), `no_metadata_found`, `discogs_rate_limited`, `discogs_unauthorized`, `upstream_unavailable`, …), otherwise: `album_ref_required`, `invalid_album_path`, `track_ref_required`, `track_not_found`, `invalid_patch`, `db_error`, `artwork_search_failed`, `artwork_apply_failed`, `artwork_upload_failed`, `album_info_fetch_failed`, `album_info_save_failed`, `track_info_fetch_failed`, `track_info_save_failed`, `lyrics_missing_artist`, `lyrics_not_found`, `lyrics_fetch_failed`, `prune_failed`, `sanitize_failed`, `discogs_search_failed`, `discogs_apply_failed`, `entity_info_search_failed`, `entity_info_save_failed`, `entity_info_batch_failed`, `invalid_scope`, `upstream_rate_limited`, `upstream_timeout`
- remote access (`errorCode` of `GET /remote-access`): `cloudflared_not_found`, `tunnel_start_timeout`, `tunnel_exited_early`, `tunnel_exited`, `tunnel_failed`
- tools: `ytdlp_update_in_progress`, `ytdlp_platform_unsupported`, `ytdlp_release_lookup_failed`, `ytdlp_asset_missing`, `ytdlp_download_failed`, `ytdlp_checksum_missing`, `ytdlp_checksum_mismatch`, `ytdlp_install_failed`, `cloudflared_not_found`
- podcasts: `podcasts_disabled` (404), `podcast_invalid_url`, `url_not_allowed`, `invalid_episode_count` (400), `podcast_source_not_found`, `podcast_episode_not_found` (404), `podcast_unsupported_url`, `podcast_hls_unsupported`, `podcast_no_episodes` (422), `podcast_fetch_failed`, `podcast_http_error`, `podcast_too_large`, `podcast_parse_failed`, `podcast_resolve_failed` (502), `podcast_fetch_timeout` (504), `podcast_proxy_busy` (503), `podcast_limit_reached` (409), plus `ytdlp_disabled`, `ytdlp_not_found`, `ytdlp_timeout`, `ytdlp_failed`
- sleep prevention: `invalid_prevent_sleep` (400), `power_locked_by_env` (409), `settings_save_failed` (500); status `errorCode`: `power_unsupported`, `power_refused`, `power_failed`
- accounts: `account_create_failed`, `account_update_failed`, `account_delete_failed`, `cannot_delete_default_account`, `last_account`

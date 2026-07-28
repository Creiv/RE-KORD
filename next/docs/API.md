# RE-KORD API (`/api/v1`)

Base URL default: `http://127.0.0.1:7420`

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
| GET | `/api/v1/library/stats` | Counts + last scan |
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
| POST | `/api/v1/backup/kord-restore` | Restore ZIP (`multipart` field `file`; v2/v3) |
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

Account resolution: query `accountId`, or headers `X-KORD-Account-Id` / `X-REKORD-Account-Id`, else default account `default` (“Locale”).

Library scan is **folder-first**: `Music/Artist/Album/track`. Tags are used only for title/duration/track number.

The **server** does not serve the client SPA. Clients call this API with their own bundled UI.

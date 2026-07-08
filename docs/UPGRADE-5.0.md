# Upgrade to RE-KORD 5.0

## Automatic migrations

- Client localStorage keys `kord-*` and `wpp-*` migrate to `rekord-*` on first launch
- User state gains optimistic `revision` field; clients must send `expectedRevision` on PUT/PATCH settings
- SQLite uses WAL mode (automatic on DB open)
- Data directory remains `.kord/` (historical name, unchanged)

## Server

1. Stop the running server
2. Replace binary / pull image `rekord:5.0.0`
3. Start server — layout migrations run automatically

## Docker

```bash
docker compose pull
docker compose up -d
```

## Electron / AppImage

Install the new 5.0.0 artifact; user config in `music-root.config.json` is preserved.

## Android

Install APK 5.0.0; WebView navigation is restricted to loopback hosts by default.

## Deprecated (removed in 5.1)

- Environment variables `KORD_*` and `WPP_*` (still accepted with warning)
- Route alias `/api/backup/kord-restore`

## Verify after upgrade

- Open Settings → Diagnostics: version `5.0.0`, DB bootstrapped
- Play a track, create a playlist, confirm persistence after restart

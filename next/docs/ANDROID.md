# RE-KORD Android client

The Android app is the **client shell** (Tauri 2) bundling `client-ui` locally.
It does **not** load the server SPA in a WebView.

## Architecture

1. Run **rekord-server** on LAN (or tunnel via Settings → Rete / `REKORD_PUBLIC_URL`).
2. Install the RE-KORD client APK.
3. In **Server**, set the API base URL (e.g. `http://192.168.x.x:7420`) or scan the QR from the hub Settings → Network panel.
4. Browse library / favorites / playlists; audio streams from `/media`.

## Prerequisites

- Android SDK + NDK, JDK 17+
- Tauri 2 mobile prerequisites: https://v2.tauri.app/start/prerequisites/
- `minSdkVersion`: 26 (see `apps/client-shell/src-tauri/tauri.conf.json`)

## Init & build

```bash
cd next
pnpm install
pnpm --filter @rekord/client-ui build
./scripts/android-init.sh

# device / emulator
pnpm --filter @rekord/client-shell exec tauri android dev

# release
pnpm --filter @rekord/client-shell exec tauri android build
```

`android-init.sh` runs `tauri android init` only if `src-tauri/gen/android` is missing.

## MediaSession / background playback

The web client already wires `navigator.mediaSession` (metadata, play/pause, next/prev, seek). On Android Tauri:

1. Keep the WebView audio unlocked (`webview` media playback permissions after `tauri android init`).
2. Prefer a foreground service / Tauri plugin for true background audio when packaging release APKs — confirm plugin choice before adding native crates (e.g. community MediaSession plugins compatible with Tauri 2).
3. Pairing: use hub **Settings → Rete** LAN/public URL; no PWA install path.

Until a native plugin is approved, lock-screen controls rely on the Web Media Session API inside the shell.

## Notes

- Cleartext LAN HTTP may require Android network security config after init.
- Optional modules (Plectr, Nebula, DiscoWall) stay deferred.
- Cast on Android: not in this phase; Chrome Cast remains web/desktop.

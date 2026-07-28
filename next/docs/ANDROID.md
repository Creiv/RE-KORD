# RE-KORD Android client

The Android app is the **client shell** (Tauri 2) bundling `client-ui` locally.
It does **not** load the server SPA in a WebView.

## Architecture

1. Run **rekord-server** on LAN (or tunnel).
2. Install the RE-KORD client APK.
3. In **Server**, set the API base URL (e.g. `http://192.168.x.x:7420`).
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

## Notes

- Cleartext LAN HTTP may require Android network security config after init.
- Background playback / MediaSession enhancements: confirm before implementing.
- Optional modules stay disabled until explicitly approved.

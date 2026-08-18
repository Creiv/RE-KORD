# RE-KORD Android client

The Android app is the **client shell** (Tauri 2) bundling `client-ui` locally.
It does **not** load the server SPA in a WebView.

## Architecture

1. Run **rekord-server** on LAN (or tunnel via Settings → Rete / `REKORD_PUBLIC_URL`).
2. Install the RE-KORD client APK.
3. First launch asks for the hub: type `192.168.x.x` + port, or scan the QR shown by the
   hub panel (see below).
4. Pick an account, then browse library / favorites / playlists; audio streams from `/media`.

## First launch

`src/components/ConnectScreen.svelte`, gated by `src/lib/connect.svelte.ts`. Two steps —
address, then account — mirroring the old `electron/connect.html`.

The screen only appears when nobody answers. On startup the gate probes, in order, the
saved base URL (kept as is: an unreachable saved hub is the session's reconnect loop to
handle, with the UI up), the page origin, and `http://127.0.0.1:7420`. A browser served by
the hub therefore never sees it, and a desktop shell running next to its hub connects on
its own. Only the APK, where the origin is the app itself, lands on the form. `Settings →
Rete → Change hub` reopens it by hand, which is the way back when the hub's IP changes.

The probe is `GET /api/v1/health` followed by `GET /api/v1/accounts`, and it insists on
`service: "RE-KORD"`: a captive portal or another server on port 7420 answers 200 to
anything, and without that check the flow would close on an address that is not a hub.

Addresses are parsed in `src/lib/hubAddress.ts` (unit tests in `hubAddress.test.mjs`):
bare IP → `http` + port 7420, an `https` host keeps no port, any path in the QR is dropped
down to the origin.

## QR pairing

The hub draws the QR, the phone reads it.

- **Hub side**: `/admin` → *Accesso in rete locale* shows a QR of the LAN URL, and *Accesso
  da fuori casa* one of the tunnel URL while it runs. The client's Settings → Rete panel
  shows the same code (tunnel when up, LAN otherwise). Payload is the plain URL, no token.
- **Phone side**: `@tauri-apps/plugin-barcode-scanner` (`tauri-plugin-barcode-scanner` under
  `cfg(any(target_os = "android", target_os = "ios"))` in `src-tauri/Cargo.toml`, plugin
  registered under `#[cfg(mobile)]`, `barcode-scanner:default` in
  `capabilities/mobile.json`). The plugin's manifest merges `CAMERA` and `VIBRATE` into the
  APK; verify with `aapt2 dump badging`.

`src/lib/qrScan.ts` imports the plugin dynamically and hides the button unless
`checkPermissions()` answers, so the browser and the desktop shell never show a camera
button that cannot work. Camera permission is asked on tap, not at startup. Scanning runs
full screen (`windowed: false`): the windowed mode draws the camera behind the WebView and
would need the whole page transparent.

## Prerequisites

- Android SDK + NDK, JDK 17+
- Tauri 2 mobile prerequisites: https://v2.tauri.app/start/prerequisites/
- `minSdkVersion`: 26 (see `apps/client-shell/src-tauri/tauri.conf.json`)

`scripts/lib/android-env.sh` locates the SDK (`ANDROID_HOME`, `ANDROID_SDK_ROOT`,
`~/Android/Sdk`, `~/Library/Android/sdk`), picks the highest NDK under `$ANDROID_HOME/ndk`
unless `NDK_HOME` is set, checks `javac >= 17` and installs the missing Rust Android
targets. Every check fails with what to install, before Gradle starts.

## Build

```bash
cd next
pnpm android:build              # debug APK, arm64, signed with the debug key
pnpm android:build --install    # …and push it to the attached device via adb
pnpm android:apk                # release, one APK per ABI (needs a keystore)
pnpm android:dev                # tauri android dev on device / emulator
pnpm android:init               # toolchain check; regenerates gen/android if deleted
```

`./scripts/android-build.sh --help` lists the flags (`--release`, `--debug`, `--apk`,
`--aab`, `--split`, `--install`, `--targets aarch64,armv7,i686,x86_64`). Default is a
debug arm64 APK: arm64 is every phone in circulation, and each extra ABI is another
Rust compile. Artifacts land in
`apps/client-shell/src-tauri/gen/android/app/build/outputs/`.

## The native project is versioned

`apps/client-shell/src-tauri/gen/android` is **in git** (the `next/.gitignore` entry is
`gen/*` plus a `!gen/android/` exception — with a trailing slash git would not descend
into `gen/` and the exception would never be read). We patch that project, and
`tauri android init` rewrites it from scratch on every machine:

- **Cleartext HTTP in release builds** (`app/build.gradle.kts`). The hub answers at an
  address like `http://192.168.1.20:7420`; a private IP has no certificate to offer, and
  Android's default (`usesCleartextTraffic=false` outside debug) would leave the release
  APK unable to reach any hub.
- **Release signing** from `gen/android/keystore.properties`, absent from git. If the
  file is missing the release stays unsigned instead of failing the build.

The Tauri-generated pieces stay out of git thanks to the `.gitignore` files inside
`gen/android` (`jniLibs/**/*.so`, `assets/tauri.conf.json`, `tauri.build.gradle.kts`,
`tauri.settings.gradle`, `src/main/**/generated`, `build/`); the CLI rewrites them on
every build, so a fresh clone builds without running `android init`.

## Signing a release APK

One keystore, kept forever: updates only install over the same key.

```bash
cd next/apps/client-shell/src-tauri/gen/android
keytool -genkey -v -keystore rekord.jks -keyalg RSA -keysize 2048 -validity 10000 -alias rekord
cat > keystore.properties <<'PROPS'
storeFile=rekord.jks
storePassword=…
keyAlias=rekord
keyPassword=…
PROPS
```

`*.jks`, `*.keystore` and `keystore.properties` are ignored inside `gen/android`.

## MediaSession / background playback

The web client wires `navigator.mediaSession` in `src/lib/mediaSession.ts`: metadata with
three real artwork variants (`?size=128`, `?size=256`, original), `playbackState`,
`setPositionState`, and handlers for play/pause/stop, previous/next and seek
(absolute plus ±offset). Shuffle, repeat, favourite and shuffle-exclude are registered
under the non-standard action names some browsers ship, which no desktop browser
accepts today.

A native shell that owns the notification does not need the Media Session API: it
reaches the same bridge by dispatching a DOM event in the WebView.

```js
window.dispatchEvent(
  new CustomEvent("rekord:media-action", { detail: { action: "toggleshuffle" } }),
);
// actions: play, pause, stop, nexttrack, previoustrack, seekto (detail.value = seconds),
// seekby (detail.value = delta), toggleshuffle, togglerepeat, togglelike, dislike
```

### Background playback on Android

The Android WebView has no Media Session API — `navigator.mediaSession` is simply absent —
so on the phone that whole file would talk to nobody. The three setters therefore also push
the same state to the shell through `src/lib/nativeMedia.ts`, which looks for
`window.RekordMediaNative` and does nothing when it is not there (browser, desktop). The
snapshot (title, artist, album, artwork URL, playing, duration, position) is coalesced over
80 ms, because metadata, transport state and position arrive as three separate calls on
every track change.

The Kotlin side lives in `gen/android`, all of it in versioned files:

- `RekordMedia.kt` — the `@JavascriptInterface` object bound in `MainActivity.onWebViewCreate`,
  plus `RekordMediaBridge`, which sends commands back by dispatching `rekord:media-action`
  in the page. No new command channel: the notification speaks the same language as the
  lock screen on desktop. Each command resumes the WebView first, because a paused track in
  the background leaves it suspended and `play` would reach a sleeping player.
- `RekordMediaService.kt` — foreground service (`mediaPlayback`) holding a
  `MediaSessionCompat`. It has **no player**: the audio stays in the WebView. It exists for
  the two things a page cannot do, keep the process alive with the screen off and own a
  system media session, from which the notification, the lock-screen controls and the
  headset button come. Artwork is the cached 256 thumbnail, fetched on a worker thread and
  redrawn when it lands. Media3 is the modern replacement for `MediaSessionCompat` but wants
  a `Player` implementation, and here the player is an `<audio>` tag on the far side of a
  JavaScript bridge.
- `MainActivity.kt` — `WryActivity.onPause()` pauses the WebView, and a paused WebView
  stops the audio, so while a track is playing the WebView is resumed right after. The
  foreground service is what makes that safe: the process is not frozen.

Service lifecycle: it starts on the first track that plays (Android 12+ only allows a
foreground service to start from the foreground, which is where the first play happens), it
drops out of foreground on pause while keeping the notification, and it stops when the queue
empties, when the notification is dismissed or when the activity dies. That last one is not
a detail: the audio lives in the WebView, so closing the app from Recents ends playback and
the notification must go with it.

Permissions in the manifest: `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MEDIA_PLAYBACK`
(required as a permission from Android 14) and `POST_NOTIFICATIONS`, asked on the first
track rather than at startup — first there is something to show, then we ask to show it. If
it is refused the music still plays, without controls. `proguard-rekord.pro` keeps the
`@JavascriptInterface` methods: nothing in Java calls them, and R8 would drop them.

Pairing goes through the first-launch screen above; there is no PWA install path.

On device, still to be checked by hand (no emulator on the build machine):

```bash
adb shell dumpsys media_session | grep -A6 rekord     # sessione e stato
adb shell dumpsys activity services app.rekord.client # servizio in foreground
```

Play a track, lock the screen, wait a minute: the sound must not stop, and the notification
buttons must move the player. If the audio dies the moment the app goes to background, the
WebView resume in `MainActivity.onPause` is the place to look.

## Notes

- Verified locally: universal release APK 15 MB, the same size as before the scanner and the
  media notification: the scanner plugin reaches ML Kit through Play Services instead of
  bundling the model, and `androidx.media` is a handful of classes. The flip side is
  that scanning needs Play Services on the phone; without it the QR button fails and the
  address has to be typed, which the first-launch screen allows anyway. `R8` keeps the
  plugin: `app/tauri/barcodescanner/BarcodeScannerPlugin` and the ML Kit registrars are in
  `classes.dex` of the minified build.
- `app.rekord.client`, versionCode from `tauri.conf.json` (5.1.0 → 5001000), minSdk 26,
  targetSdk 36, `usesCleartextTraffic=true` in debug and release, signed release verified
  with `apksigner verify --print-certs`.
- The hub answers with `Access-Control-Allow-Origin: *` (`build_router` in
  `crates/core/src/lib.rs`), which is what lets the WebView call a different origin at all.
- Optional modules (Plectr, Nebula, DiscoWall) stay deferred.
- Cast on Android: not in this phase; Chrome Cast remains web/desktop.

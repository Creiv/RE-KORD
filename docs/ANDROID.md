# RE-KORD Android client

The Android app is the **client shell** (Tauri 2) bundling `client-ui` locally.
It does **not** load the server SPA in a WebView.

## Architecture

1. Run **rekord-server** on LAN (or through the tunnel: *Settings › Network › Remote access*, or `REKORD_PUBLIC_URL`).
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
its own. Only the APK, where the origin is the app itself, lands on the form. *Settings ›
Network › Change hub* reopens it by hand, which is the way back when the hub's IP changes.

The probe is `GET /api/v1/health` followed by `GET /api/v1/accounts`, and it insists on
`service: "RE-KORD"`: a captive portal or another server on port 7420 answers 200 to
anything, and without that check the flow would close on an address that is not a hub.

Addresses are parsed in `src/lib/hubAddress.ts` (unit tests in `hubAddress.test.mjs`):
bare IP → `http` + port 7420, an `https` host keeps no port, any path in the QR is dropped
down to the origin.

## QR pairing

The hub draws the QR, the phone reads it.

- **Hub side**: `/admin` › *Network › Local network access* shows a QR of the LAN URL, and
  *Access from outside* one of the tunnel URL while it runs. The client's *Settings › Network* panel
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
pnpm pack:android               # release/android/RE-KORD-Client-<v>-android-arm64.apk
                                # (optimized; your keystore if present, else the debug key)
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

`apps/client-shell/src-tauri/gen/android` is **in git** (the root `.gitignore` entry is
`gen/*` plus a `!gen/android/` exception — with a trailing slash git would not descend
into `gen/` and the exception would never be read). We patch that project, and
`tauri android init` rewrites it from scratch on every machine:

- **Cleartext HTTP in release builds** (`app/build.gradle.kts`). The hub answers at an
  address like `http://192.168.1.20:7420`; a private IP has no certificate to offer, and
  Android's default (`usesCleartextTraffic=false` outside debug) would leave the release
  APK unable to reach any hub.
- **Release signing** from `gen/android/keystore.properties`, absent from git. If the
  file is missing the release is signed with the SDK debug key: still optimized and
  installable (like the legacy APK), but not publishable, and moving to the real key later
  means uninstalling once.

The Tauri-generated pieces stay out of git thanks to the `.gitignore` files inside
`gen/android` (`jniLibs/**/*.so`, `assets/tauri.conf.json`, `tauri.build.gradle.kts`,
`tauri.settings.gradle`, `src/main/**/generated`, `build/`); the CLI rewrites them on
every build, so a fresh clone builds without running `android init`.

## Signing a release APK

One keystore, kept forever: updates only install over the same key.

```bash
cd apps/client-shell/src-tauri/gen/android
keytool -genkey -v -keystore rekord.jks -keyalg RSA -keysize 2048 -validity 10000 -alias rekord
cat > keystore.properties <<'PROPS'
storeFile=rekord.jks
storePassword=…
keyAlias=rekord
keyPassword=…
PROPS
```

`*.jks`, `*.keystore` and `keystore.properties` are ignored inside `gen/android`.

### Coming from the legacy APK: uninstall first

The legacy (Capacitor) APKs were distributed **signed with the debug key**. Android only
installs an update over an app signed with the *same* key, so the first RE-KORD 5 release APK
(signed with `rekord.jks`) is refused with `INSTALL_FAILED_UPDATE_INCOMPATIBLE` / "App not
installed". Uninstall the old RE-KORD first (`adb uninstall app.rekord.client`, or from the
launcher). Nothing is lost that matters: favourites, playlists and preferences live on the
hub; the phone only remembers the hub address and the chosen account, which the first
launch asks again (or reads from the QR). From then on keep the same keystore forever.

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
snapshot (title, artist, album, artwork URL, playing, duration, position, plus `wantsPlay`
and `pauseReason`, see [Screen off, network, car](#screen-off-network-car)) is coalesced
over 80 ms, because metadata, transport state and position arrive as three separate calls
on every track change.

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
  stops the audio, so the WebView is resumed right after while the page plays, means to
  play (a track loading when the screen is locked right after the tap) or while the
  service is still in the foreground after a pause (so an interruption can be resumed).
  The foreground service is what makes that safe: the process is not frozen.
- `RekordInterruption.kt` — `InterruptionPolicy`, the resume-after-another-app decision
  (plain Kotlin, JVM unit tests in `app/src/test`).
- `RekordRemotePlay.kt` — `RemotePlayRequest` (a play from the car waiting for the page),
  `ForegroundPolicy` (when to hold the foreground and the locks) and `NowPlayingStore`
  (the last track in the app's preferences). Plain Kotlin, `RemotePlayTest`.

Service lifecycle: it starts on the first track that plays or starts loading (Android 12+
only allows a foreground service to start from the foreground, which is where that tap
happens). It stays in the foreground while the page plays or means to play, and for
**10 minutes after a pause** (the same default as Media3's `MediaSessionService`), or as
long as an interruption may still be resumed; then it leaves the foreground and keeps the
notification. It stops when the queue empties, when the notification is dismissed or when
the activity dies. That last one is not a detail: the audio lives in the WebView, so
closing the app from Recents ends playback and the notification must go with it.
A play from the car or a headset is the other way in, see
[Play from the car with the app in the background](#play-from-the-car-with-the-app-in-the-background).

Permissions in the manifest: `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MEDIA_PLAYBACK`
(required as a permission from Android 14), `WAKE_LOCK`, `ACCESS_NETWORK_STATE` (normal
permissions, no prompt) and `POST_NOTIFICATIONS`, asked on the first track rather than at
startup — first there is something to show, then we ask to show it. If
it is refused the music still plays, without controls. `proguard-rekord.pro` keeps the
`@JavascriptInterface` methods: nothing in Java calls them, and R8 would drop them.

Pairing goes through the first-launch screen above; there is no PWA install path on the
APK (the PWA exists only for the browser client served by the hub).

### Back button

`MainActivity` sets `handleBackNavigation = false` (WryActivity's own handler finishes the
activity at the bottom of the history, killing the WebView and the music with it) and
installs its own `OnBackPressedCallback`:

1. if the WebView can go back, `goBack()` — the client pushes a history entry for every
   view change and every modal/sheet it opens, so Back closes the sheet, then returns to
   the previous view;
2. at the bottom of the history, `moveTaskToBack(true)`: the app goes to the background
   exactly like Home, the activity is **not** destroyed and playback continues (the
   foreground service keeps the process alive).

`onDestroy` therefore only runs when the activity really dies (removed from Recents, process
reclaimed); only then does it stop the media service — the WebView, and the audio in it, is
gone. Configuration changes do not destroy it (`configChanges` in the manifest).

### Orientation

Phones (`smallestScreenWidthDp < 600`) are locked to portrait, as in the legacy app; tablets and TVs
rotate freely. Decided in `MainActivity.applyOrientationPolicy()` before `super.onCreate`, so
there is no rotate-then-snap on startup.

### Audio focus, headphones, delivery of commands

Audio focus belongs to the WebView: Chromium requests it when the `<audio>` element starts
and pauses or resumes the element itself on losses (phone calls, other music apps), which the
player sees as ordinary `pause`/`play` events. `RekordMediaService` does **not** request focus:
a second requester inside the same app stole focus from the WebView and its loss handler
paused the track a moment after it started. The legacy app ignored focus changes for the same
reason.

| Event | Action |
|-------|--------|
| `ACTION_AUDIO_BECOMING_NOISY` (headphones unplugged, BT off) | `pause`, and no automatic resume afterwards (receiver registered while playing or while an interruption may resume) |
| service destroyed / stop | receiver removed |

#### Interruptions by other apps

What Chromium does on its own (`AudioFocusDelegate`): on `AUDIOFOCUS_LOSS_TRANSIENT`
(call, voice note, navigation prompt, a short video that asks for transient focus) it
suspends the element and resumes it on `AUDIOFOCUS_GAIN`; on `…_CAN_DUCK` it lowers the
volume; on `AUDIOFOCUS_LOSS` (another music app, most video players) it **abandons focus
and pauses**, and nothing ever resumes it. The page sees plain `pause` / `play` events,
without a user gesture.

The player labels every pause it asks for (`user`, `outage`, `error`, …); a `pause` event it
did not ask for is `external`, i.e. the engine reacting to a focus loss. That reason travels
in the snapshot (`pauseReason`). `RekordMediaService` then observes, without requesting
focus:

- other apps' playback through `AudioManager.registerAudioPlaybackCallback` (apps get the
  anonymized list of *active* players; while our page is paused, any active player that is
  not a key click or an accessibility hint is someone else);
- calls through the audio mode (`getMode() != MODE_NORMAL`), with
  `OnModeChangedListener` on Android 12+ and a 30 s poll while armed as a backstop.

`InterruptionPolicy` decides:

- armed only by an `external` pause of a track that was playing;
- once no other audio has played for 2.5 s and no call is up, it sends `play` (the delay
  lets Chromium resume a transient loss itself first; a `play` to a page that already
  plays does nothing). Re-sent after 10 s if the page did not react, at most three times;
- disarmed by a user pause from anywhere (app, notification, headset, car, which also
  turns an `external` pause into a `user` one), by "becoming noisy" (headphones or car
  disconnected: the music must not come back on the phone's speaker), and after **30
  minutes** of interruption.

Transitions are logged (`interruption: PLAYING -> INTERRUPTED`, `interruption over (audio
change): resuming`). Unit tests: `./gradlew :app:testUniversalDebugUnitTest` from
`gen/android` (`InterruptionPolicyTest`).

#### Screen off, network, car

With the screen off the page is hidden: Chromium throttles its timers to once a second (and
to once a minute after five silent minutes), the CPU sleeps as soon as no audio comes out
(between two tracks), and Wi-Fi drops into power save. What the app does about it:

- **Foreground across pauses.** Before 5.1 the service left the foreground at every pause.
  A call or another app pausing the track, then the track resuming from the background,
  meant `startForeground` from the background, which Android 12+ refuses with
  `ForegroundServiceStartNotAllowedException`: uncaught, it closed the app. Now the service
  stays in the foreground (see the lifecycle above), every `startForeground` is guarded
  (logged, the notification is still drawn), and a foreground service keeps network access
  and wake locks in Doze.
- **`wantsPlay`.** The page also reports when it means to play without sound yet: a track
  loading, a `play()` being retried, a stream reconnecting, the hub coming back. The
  service treats it like playing.
- **Locks.** While the page plays or means to play: a partial wake lock (10 min timeout,
  re-armed every 10 s) and a `WIFI_MODE_FULL_HIGH_PERF` Wi-Fi lock (`LOW_LATENCY` only
  applies with the screen on and the app in front). Released on pause, and after 10 minutes
  of wanting to play with nothing playing (hub gone for good). Not held while casting: no
  audio goes through the phone, and a session can last hours. `RekordCast` takes a 10 s
  wake lock instead on each event the page must answer (a player-state change such as
  the track finishing, session events, load results), not on the 1 Hz position ticks.
- **WebView back to sleep.** When the service leaves the foreground 10 minutes after a
  pause, or a Cast session ends with nothing playing, and the activity is not in front,
  the WebView is paused again (`RekordMediaBridge.sleepIfHidden`), as `WryActivity` would
  have done. Every command from the notification resumes it first.
- **A pause always wins.** Every pause (app, notification, headset, car, sleep timer)
  bumps a counter; a load, reconnect or `play()` retry started before it checks the
  counter after each wait and does not play. The player button pauses while a reconnect
  is loading (the deck is silent but the player still plays), and is a no-op while a
  tapped track is still loading to play.
- **Watchdog.** Every 10 s while the locks are held the service dispatches
  `rekord:playback-watchdog` in the page (`evaluateJavascript` is not throttled) and logs
  a page that says "playing" without a position update for 25 s. The event carries
  `otherAudio` (silent page, and a call or another app's audio): the page then holds its
  `play()` retries and reloads, which would take the audio focus back.
- **Stall watch in the page** (`src/lib/playbackWatch.ts`, driven by the heartbeat, a 5 s
  interval, `waiting` / `stalled`, `online` and network changes). Decisions come from the
  clock, so a late check still decides right: no progress for 12 s (2 s right after a
  network change) → reload the stream at the current position; deck paused while it should
  play → `play()` twice, then reload; `ended` with no advance after 4 s → next track;
  backoff 2–4–8–16–30 s; nothing played for 10 minutes → stop with the usual error toast.
  A reconnect resumes at the position of the first one even if the element already went
  back to 0 (`resumePoint()`), and keeps the intent to play if it fails because the hub is
  gone.
  A media network error with the hub reachable reconnects at the same position (three
  times per track and minute) instead of skipping the track as unreadable, and the hub is
  asked before a "format not supported" sends the track to the transcoder (a refused
  connection reports that error too); with the hub
  unreachable the existing outage path waits for it, and the heartbeat and network events
  probe the hub at once instead of waiting out a throttled backoff timer.
- **Track changes.** The next track is buffered on the idle deck 20 s before the end (fade
  + 15 s with crossfade), so the boundary needs no cold request; the advance on `ended` has
  no timer in between; a crossfade completes on the outgoing deck's `ended` even if its
  timers are frozen. A `play()` refused in the background is retried by the watch instead
  of leaving silence (in front, the error toast as before).
- **Network changes.** The service registers a default-network callback and passes changes
  to the page (`rekord:network`). `ACCESS_NETWORK_STATE` also lets the WebView watch the
  network itself: `online` / `offline` events, and sockets of a lost network are dropped
  instead of left hanging. A hub reached through its LAN address is not reachable over
  mobile data; for the car, pair the app with the tunnel address.
- **Bluetooth / car.** The car's buttons arrive as MediaSession callbacks (or, with the
  service gone, as a media button that restarts it) and go through `RekordMediaBridge`.
  A play is handled first by the service itself, see the next section.

#### Play from the car with the app in the background

GitHub issue #99: with the phone locked and the app in the background, the car's PLAY did
nothing until the phone was unlocked and the app opened. What happened in 5.1:

1. Ten minutes after a pause the service left the foreground and the WebView was paused.
   About a minute later Android stops a background service of an app that is not in front
   (background execution limits): session released, process cached and frozen.
2. The car's PLAY went to the last media button receiver (`MediaButtonReceiver`), which
   restarted the service. The new instance computed its pause grace from a zero timestamp,
   so the first render left the foreground right away and put the WebView back to sleep
   under the incoming command.
3. With the service still alive, `onPlay` only forwarded the command; the service went back
   to the foreground when the page reported that it meant to play. That came from the
   background, after the window in which Android allows it, and Android 12+ refused it
   (`foreground refused` in the log). Without the foreground the process stayed throttled,
   with the network restricted, while the screen was locked.
4. The command itself was dropped after 3 s (12 × 250 ms) if the page did not answer.
5. `onBind` returned null: no media browser service, so Android Auto, car head units that
   browse and the system's media controls could not find or resume the app.

What happens now (`RekordMediaService.requestPlay`):

- **Foreground first.** `onPlay`, `onPlayFromMediaId`, `onPlayFromSearch`, a media button
  in `onStartCommand` and the "open and resume" notification run inside the short window
  Android grants for a media button or a media controller command (about 10 s, the
  `MediaSessionService` temporary allowlist). The service enters the foreground there, with
  the current notification, and takes the CPU and Wi-Fi locks, **before** it talks to the
  page. A service only bound by a media browser first starts itself
  (`startForegroundService`, allowed in the same window). A media button also restarts the
  pause grace, so the render that follows does not leave the foreground.
- **The page takes over.** The request stays pending (`RemotePlayRequest`) until the page
  reports that it plays or means to play (loading, reconnecting); from there the usual
  rules hold the foreground and the locks. Until then the request counts as "wants to play"
  for the foreground, the locks, the heartbeat and `keepWebViewAwake` (MainActivity does not
  let the WebView sleep under it). A pause or stop from anywhere cancels it.
- **Delivery.** Every command now has a 15 s window (was 3 s), with the command wake lock
  held for the whole window and the WebView resumed before each attempt. A play gets 15 s
  when the page is up, 45 s when the WebView is new or missing (app starting, queue being
  restored). When the window ends with no answer the bridge reports it; with a page the
  service keeps the usual pause grace, without one it leaves the foreground at once.
- **Last track saved.** `NowPlayingStore` keeps title, artist, album, cover URL, duration
  and position in the app's private preferences (on track change, play/pause, and when the
  position moves by a minute, not on every tick). A service restarted with no page state
  rebuilds the session from it, paused, so the car shows the track and PLAY works. The
  page's own `stop` (queue emptied) forgets it; closing the app or dismissing the
  notification keeps it.
- **Media browser.** The service is a `MediaBrowserServiceCompat` (session token from the
  service, `android.media.browse.MediaBrowserService` intent filter, `exported="true"`,
  `MediaButtonReceiver` kept) and declares `res/xml/automotive_app_desc.xml` through the
  `com.google.android.gms.car.application` meta-data. `onGetRoot` lets in the app itself,
  callers the system trusts for media control (`isTrustedForMediaControl`: system UI,
  Bluetooth, enabled notification listeners), preinstalled apps, and a short list of known
  media browsers (`BrowserAccess`: Android Auto `com.google.android.projection.gearhead`, the
  Assistant, Wear OS, Automotive's media center); any other app is refused, since a
  connection hands out the session and the last track's title. The "open and resume" start
  action is honoured only right after the app asked for it (`ResumeTicket`). The
  root has one playable item, *Resume* (*Riprendi*, *Fortsetzen*) with the last track as
  subtitle; with `EXTRA_RECENT` (the system's media resumption) the item is the track
  itself. Playing it is a remote play as above. No queue is listed: the queue lives in the
  page.

**Limit: no page, no music.** The audio is an `<audio>` element in the WebView, and wry
creates that WebView inside `MainActivity`; there is no WebView without the activity. When
the activity is gone (app removed from Recents, process killed by the system) a car PLAY
restores the session and asks Android to start the activity in the background, and the
page then restores its queue and plays. Android 10+ blocks activity starts from the
background, and neither a foreground service nor a media button is an exemption
(only a visible window, a notification tap, `SYSTEM_ALERT_WINDOW`, and a few system cases;
full-screen intents need `USE_FULL_SCREEN_INTENT`, reserved to calls and alarms from
Android 14, and would light up the screen). So on most phones the start is blocked
(`Background activity launch blocked` under `ActivityTaskManager` in logcat). The
notification then says *Open RE-KORD to resume*, and tapping it opens the app and resumes
the track (no unlock needed for the notification itself, the app opens after it). Where
the start is allowed (Android 9 and older, "display over other apps" granted, some OEM
builds), the activity moves itself to the back as soon as its WebView exists, so it does
not cover what the user was doing.

Android Auto only lists apps installed from the Play Store unless *Unknown sources* is
enabled in Android Auto's developer settings.

Checked on an emulator (Android 15, x86_64 debug build with the pause grace shortened to
one minute, screen off, `dumpsys deviceidle force-idle`), PLAY sent with
`adb shell cmd media_session dispatch play` (the same path as a Bluetooth key):

- paused past the grace, out of the foreground, WebView paused: foreground and locks at
  once, the page plays 0.6 s later;
- service stopped by the system (`am make-uid-idle`), process alive: `MediaButtonReceiver`
  restarts it, playing 0.5 s later (5.1 left the foreground in the same millisecond it
  entered it and paused the WebView under the command; it only worked because the
  emulator's page answered within the window);
- process killed (`am kill`): 5.1 did nothing. Now the session comes back with the saved
  track and the activity is started; on the emulator Android allowed that start
  (`BAL_ALLOW_PERMISSION`, the key came from adb's shell) and the track played 1.9 s later
  with the launcher still in front;
- process killed, PLAY from the system's media controls (the resume player in Quick
  Settings, a media browser client): the activity start is blocked
  (`Background activity launch blocked`), the play gives up after 45 s and leaves the
  foreground; tapping the player opens the app, which plays the track;
- a phone call (`adb emu gsm call/accept/cancel`) still resumes after hang-up, and locks
  are released on pause.

Whether a real car's key lets the activity start after the process died depends on what
the Bluetooth stack passes along; it has to be checked on a phone. `adb shell input keyevent
KEYCODE_MEDIA_PLAY` does not reach the session while the emulator's screen is off (it does
with the screen on); use `cmd media_session dispatch` there.

Logs, all under one tag:

```bash
adb logcat -s RekordMedia
# service: in the foreground / out of the foreground / foreground refused
# locks: CPU and Wi-Fi held / released
# page: playing / waiting to play / paused (external)
# page: watch (heartbeat): no progress for 14s, reconnecting at 83s (attempt 1)
# network changed: now cellular
# play (media session): foreground and locks first, page has 15s to start
# play: the page took it over (loading) / play: cancelled by pause
# command play: page not ready (player not mounted yet), retrying
# media button with no page state: last track restored (Song)
# media browser: com.google.android.projection.gearhead connected
# interruption: PLAYING -> INTERRUPTED, interruption over (audio change): resuming
```

Lines starting with `page:` come from the player (`nativeLog` in `nativeMedia.ts`); only
transitions are logged, never the 5 s position refreshes.

All of these reach the player through the same `rekord:media-action` event as the
notification buttons. `RekordMediaBridge` delivers each command with a partial wake lock
(`WAKE_LOCK` permission) held for its whole window (15 s, 45 s for a play waiting on a page
that is still starting) and retries every 250 ms until the page answers:
the injected script returns `true` only when `window.__rekordNativeMediaReady` is set
(`nativeMedia.ts` raises it after the first state reaches the shell, i.e. the player is
mounted and listening). A newer command replaces a pending one. Same approach as the legacy
`MainActivity.java`.

### Files saved from the page

Backups, profile and theme exports are built in memory and "downloaded" through
`<a download href="blob:…">`, which the Android WebView ignores. `src/lib/platform/downloads.ts`
intercepts those clicks inside the shell and streams the bytes in base64 chunks (384 KiB) to
`RekordFiles.kt` (`window.RekordFilesNative`): on Android 10+ the file goes to **Download**
through `MediaStore` (no permission), on 8–9 to the app's private
`Android/data/app.rekord.client/files/Download`. A toast shows where it landed.

### Google Cast

The WebView has no Cast extension, so the web sender (`src/lib/cast/googleCast.ts`) stays
hidden in the app. The shell carries a native sender instead, ported from the legacy
`RekordCastManager`:

- `RekordCast.kt`: Google Cast SDK (`play-services-cast-framework` 22.0.0, the legacy app's version,
  plus `androidx.mediarouter` 1.6.0). `RekordCastOptionsProvider`, declared in the manifest
  with the `OPTIONS_PROVIDER_CLASS_NAME` meta-data and kept by `proguard-rekord.pro`, selects
  the **Default Media Receiver** and turns off the Cast SDK's own notification and
  MediaSession, so the same track never shows up in two notifications.
- `window.RekordCastNative` (`RekordCastJs`) has `getStatus()`, `requestSession()`
  (androidx `MediaRouteChooserDialog`), `endSession(stop)`, `load(json)` (URL, MIME,
  title/artist/album, cover, start position, autoplay), `play`, `pause`, `seek` and `stop`.
- Everything comes back as the DOM event `rekord:cast`, the same channel `RekordMediaBridge`
  uses for the notification:
  - `status`: cast state, device name, player state, idle reason, position, duration and
    content id, at about 1 Hz while playing;
  - `session`: `cancelled`, `startFailed` with an SDK code, or `unavailable`;
  - `result`: the outcome of a load, matched by id.
- `src/lib/cast/androidCast.ts` implements `CastBackend` over this bridge, and
  `androidCastStatus.ts` maps the raw SDK names to `CastStatus` (tested in
  `castAndroid.test.mjs`). When the bridge exists, `castController` picks this backend on its
  own. The Cast button, the player hand-off (`player.setRemoteOutput`) and queue advance
  on `FINISHED` are the same as on the web.
- **Media URLs**: same as on the web (`castMedia.ts`). In the app the hub is already a LAN
  address (`http://192.168.x.y:7420`), so the receiver uses it as is. Flac, ogg, opus and wav
  go through `/api/v1/transcode/…?format=mp3` when the hub's health reports `transcode`.
  Without the transcoder they are sent as they are, and the receiver may refuse them.
- **While casting**: local decks are paused (the player's remote output). The notification
  keeps mirroring the player, which now follows the receiver, so it shows the cast track,
  its play state and "On <device>". Its buttons, the headphone button and the lock screen
  control the Chromecast through the usual `rekord:media-action`.
  `RekordMediaService` drops the "becoming noisy" receiver: unplugged headphones must not
  pause the living-room speaker. It also switches the
  MediaSession to remote volume, so the volume keys move the Chromecast's volume with the
  screen off. With the app open, `MainActivity.dispatchKeyEvent` does the same. The WebView
  stays awake in the background for as long as a session is connected, because the page is
  what moves the queue forward when a track ends. The CPU is not held for the whole
  session: a 10 s wake lock covers each state change the page must answer (see
  [Screen off, network, car](#screen-off-network-car)).
- **Ending**: disconnecting from the button ends the session and stops the receiver. The
  player resumes locally at the last reported position. If the app is killed while
  casting, the receiver finishes the current track. The SDK resumes the saved session on
  the next launch, and the page then reloads the current track on it.

**Requirements**: Google Play Services on the phone (Cast framework), and the phone, the
Chromecast or Google Home and the hub on the **same LAN**. The hub address must be the
LAN IP, not `localhost`. Without Play Services, or with a version the SDK rejects, the init
reports `supported:false` and the Cast button never appears. Neither case is an error.

**Not verifiable without a device and a Chromecast**: discovery and the device picker, a
real session start, playback of `/media` and transcoded URLs on the receiver, cover art on
the TV or Nest Hub, the 1 Hz progress, queue advance on track end (also with the screen
off), volume keys, the notification while casting, cancel/start-failed toasts, session
resume after an app restart, and behaviour on devices without Play Services, such as
Huawei phones or AOSP TV boxes. Useful while testing:

```bash
adb logcat | grep -iE "RekordCast|CastContext|MediaRouter"
```

### Manifest notes

- `CAMERA` is merged from the barcode-scanner plugin and also declared explicitly; the
  plugin declares `android.hardware.camera.any` as **required**, which would hide the app on
  the Play Store for TVs and camera-less tablets. The manifest overrides it with
  `required="false"` (`tools:replace`), plus `android.hardware.camera` and
  `android.hardware.touchscreen` optional. Verify:
  `aapt2 dump badging app-universal-release.apk | grep feature`.
- `LEANBACK_LAUNCHER` now has an `android:banner` (`res/drawable-xhdpi/tv_banner.png`,
  320×180 dp), required for the Android TV launcher.
- `android:allowBackup="false"`: Android auto-backup would copy the WebView's localStorage
  (hub address, chosen account) to another phone where that hub may not exist. The data
  that matters lives on the hub, which has its own backup.

Checked on an emulator (Android 15, x86_64 debug build, hub on the host at
`10.0.2.2`, screen off and `dumpsys deviceidle force-idle`): eight track changes with
crossfade in deep Doze; Wi-Fi off (handover to mobile data) and all networks off for a
minute; a proxy in front of the hub that stops forwarding with the sockets open (stall →
reconnect at the same position once it forwards again) and one that refuses connections
(outage → resume); another app taking `AUDIOFOCUS_GAIN` for 15 s (paused, resumed 2.5 s
after it stopped), `GAIN_TRANSIENT` (Chromium resumes it), `…_MAY_DUCK` (no pause), an
emulated phone call (`adb emu gsm call/accept/cancel`: resumed after hang-up), and a media
key pause during an interruption (no resume).

Still to be checked on a phone: real Bluetooth / car head units (AVRCP buttons, "becoming
noisy" on disconnect, PLAY sent on connect), OEM battery savers that kill foreground
services anyway, real Wi-Fi power save and cell handovers, and a tunnel connection.

```bash
adb shell dumpsys media_session | grep -A6 RE-KORD    # session and state
adb shell dumpsys activity services app.rekord.client # service in the foreground
adb logcat -s RekordMedia                             # what the player and service did
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
- `app.rekord.client`, versionCode from the version Tauri reads from `Cargo.toml` (the
  workspace version; `tauri.conf.json` no longer carries one — 5.0.0 → 5000000), minSdk 26,
  targetSdk 36, `usesCleartextTraffic=true` in debug and release, signed release verified
  with `apksigner verify --print-certs`.
- The WebView's origin is `http://tauri.localhost` (Android) and the hub is another origin:
  the hub's CORS policy explicitly allows `tauri://localhost` and `http(s)://tauri.localhost`
  (see [API.md](API.md#cors)), which is what lets the APK call it at all. A reverse proxy in
  front of the hub must not strip those headers.
- Plectr, Sonic Nebula and DiscoWall are part of the client and work in the app.
- **Cast**: native Google Cast is back (it was in the legacy APK as `RekordCastManager`); see
  [Google Cast](#google-cast).

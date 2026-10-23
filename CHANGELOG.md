# Changelog

All notable changes to RE-KORD. Versions follow [semantic versioning](https://semver.org);
one version number covers the hub, the clients and the packages.

## Unreleased

### New

- **Optional access key** (by [@mrsalvaa](https://github.com/mrsalvaa), PR #102): one
  shared key in front of `/api` and `/media`, for hubs reached through a tunnel or a
  reverse proxy. Off unless set. Clients ask for it once per hub (key screen, QR with the
  key from the admin panel, *Settings › Network* to change or forget it); `<audio>`,
  covers, downloads and Cast carry it as a query parameter, the hub strips it before
  routing and never logs it. Wrong keys from one address are rate limited, the right key
  always gets in; weak keys are refused. See `SECURITY.md`.
- **Access key from the admin panel** (*Network › Access key*): generate, set, replace or
  remove the key without touching the environment; only its SHA-256 digest is saved in
  `settings.json`, it takes effect at once and survives restarts and backups.
  `REKORD_ACCESS_KEY`, when set, wins and locks the panel. `GET/PUT/DELETE
  /api/v1/system/access-key` (machine operation).

### Changed

- **yt-dlp's JavaScript engine: the bundled QuickJS comes first** (GitHub issue #103, the
  Node.js security releases of 21 October 2026). An installed Deno, Node.js or Bun is used
  only when there is no bundled runtime (source builds, `--no-tools` packages) or when
  `REKORD_YTDLP_JS_RUNTIME` names it, so YouTube downloads no longer depend on the patch
  level of a system Node. A system Node must now be at least 22.23.4, 24.22.1 or 26.12.1
  (end-of-life lines are skipped). The package builder image uses Node 22.23.4.

## 5.2.1 — 2026-10-17 (pre-release, clients only)

A preview of what is coming in 5.3, published as a GitHub pre-release with the Client
packages only (Linux, Windows, Android). There is no 5.2.1 hub, Server package or Docker
image: the clients work with a 5.2 hub as they are, and the hub's web page keeps the 5.2
interface until 5.3.

### New

- **Lyrics behind the fullscreen karaoke.** The strongest one or two words of the line being
  sung (fillers, backing vocals in brackets and helper verbs skipped, in Italian, English,
  Spanish and French) appear huge and faint behind the lyrics, lyric-video style, in one of
  five compositions: one giant outlined word, a slanted word in the theme colour, a vertical
  word along the edge, a word echoed three times, two words stacked. A repeated line always
  comes back with the same composition, so the chorus is recognisable; the title stands in
  before the first line. Each composition drifts slowly for as long as the line is sung and
  stops when paused. The lines above and below the sung one get a dark halo so they stay
  readable. **Sfondo**, top right in fullscreen karaoke, turns it off; the choice is saved
  per account and follows you on every device.

### Fixed

- **Fullscreen visualizers ran past the right edge on desktop** by the width of the side
  rail: anything on the right was cut off and the karaoke lyrics and the visualizers sat off
  the visible centre.

### Other

- The Docker image is built only for full releases, so pre-releases never move `:latest`.

## 5.2.0 — 2026-10-16

Fixes from GitHub issue #99 and working YouTube downloads: a bundled JavaScript engine for
yt-dlp, tags and covers written into downloaded files, a clearer Studio download flow,
the "To fix" quality list, podcast and Android playback fixes. Hubs and clients 5.0, 5.1
and 5.2 work together; nothing in the database needs migrating.

### New

- **Studio downloads get tags and a cover.** Downloaded files had no tags and no picture:
  the library knew artist, album and title only from the folders. The hub now writes title,
  main artist (not "Artist - Topic"), album and album artist (from the destination folder,
  not the playlist title "Album - …"), track number and total in release order, disc, release
  date and genre into every file the download saved, with the item's thumbnail as the cover,
  cropped to a centred square (16:9 video thumbnails) and kept at most 1200 px. Album
  downloads also save `cover.jpg` in an album folder that has none; an existing cover is never
  replaced. Video titles lose "(Official Video)", "[HD]" and a leading "Artist - ". Only the
  files of the run are written: files already in the folder are left alone (yt-dlp's own
  `--embed-metadata` would rewrite them too), and nothing but the audio and `cover.jpg` lands
  in the library. A WebM download has its Opus stream copied (no re-encode) into `.opus` so
  it can carry tags. Admin panel, *Library › Embedded metadata*: **"Incorpora tag e copertina
  nei file scaricati"** (on by default). The Studio log reports what was written.

- **"In libreria" badges in Studio** (issue #99): Esplora results, an artist's releases and
  Scopri tiles that match an album or track of the library (title and artist, ignoring
  accents, punctuation, "Deluxe", "Remastered", "- EP", "- Single", featuring) are marked,
  and the download confirmation offers **Skip** or **Download anyway**.
- **Cookie status** in Settings and in the admin panel's Integrations: file present and
  valid, last update, number of cookies and how many are for YouTube/Google.
- **"To fix" list from the quality alerts** (issue #99): the *Quality alerts* tile and the
  rows of *Library quality* on Home open a dialog with one tab per issue (albums without
  cover, albums without metadata, tracks without metadata, folders with loose tracks) and
  a button on each item: **Cover** and **Metadata** open Studio with that album already
  picked, **Edit** opens the track editor, **Open album** its page. Counts update as you
  fix things.

### Changed

- **Docker image on the GitHub Container Registry**: `ghcr.io/creiv/re-kord` (amd64 and
  arm64, tags `latest`, the version and the release tag) is built and published at every
  release tag (thanks to @303inmyheart for the workflow). `docker-compose.yml` now pulls it,
  so the compose file alone is enough; building locally is still possible.
- **Podcasts on Home no longer start by themselves** (issue #99). Tapping a show in the
  *Podcasts & news* card opens its page; if you left one of its episodes halfway, it asks
  *Continue "…"?* with **Continue** (from where you left it) and **Open the podcast**. Live
  stations still play at once, and the play buttons of episode rows still play.
- **"Show in Recent" removed** (issue #99): podcast listens no longer appear in *Recent*,
  and the podcasts "⋯" menu, which only held that switch, is gone (**Refresh** is always a
  button).

### Fixed

- **Singles downloaded into an album folder were all "01 - …".** A single now takes its own
  track number when the site gives one, otherwise the folder's next number after its last
  track (`05 - Title` next to `01`–`04`); existing files are still never overwritten.

- **YouTube downloads work out of the box again.** YouTube now refuses yt-dlp unless it can
  run JavaScript ("The page needs to be reloaded", or "Sign in to confirm you're not a bot"
  even with cookies). The server packages and the Docker image now bundle **QuickJS-ng**
  (`qjs`, MIT, about 2.5 MB) as yt-dlp's JavaScript runtime, and the hub passes it to every
  yt-dlp run (downloads, track counts, previews, podcast pages). A deno, node (22+) or bun
  already installed is preferred (about twice as fast), also found where a desktop app's
  PATH does not look (`~/.deno/bin`, `~/.bun/bin`, nvm's newest node,
  `/usr/local/bin`, `/opt/homebrew/bin`). The yt-dlp strip in Studio, *Settings › System*
  and the admin panel's *Diagnostics* show the runtime in use, or warn when there is none;
  the Studio sign-in hint says so too. `REKORD_YTDLP_JS_RUNTIME` still overrides the choice
  (`none` turns it off).
- **Studio downloads, found while testing with real cookies.** *Explore* search shows
  artists again (the top result and the Artists shelf were dropped, so *Releases* was out of
  reach from a search) and no longer lists podcast shows and episodes as albums and songs. A
  Scopri single sent to the Download tab before a folder was picked no longer has its link
  marked incompatible. With valid cookies and no JavaScript runtime, the failure now points
  at the runtime instead of asking to re-export the cookies, and *Open Settings* from the
  cookie hint lands on *Library › Integrations*, where the cookies are uploaded. A track
  count, preview or podcast lookup that is abandoned (dialog closed, timeout) now stops
  yt-dlp itself: the PyInstaller launcher was killed but yt-dlp went on as an orphan and
  could leave its copy of the cookies behind.
- **YouTube cookies are wiped, not just deleted.** *Remove cookies* (Settings and the admin
  panel), the per-run copies handed to yt-dlp, and the previous file replaced by an upload, a
  write-back or a backup restore are now overwritten with zeros and synced before they are
  unlinked, since they hold a live account session. Best effort: hard links and symlink
  targets are left alone, and a read-only location only gets the delete attempt.
- **Plurals in counted strings** (it/en/de): "1 album · 1 brani" under an artist, "Scaricare
  i brani…" when confirming a single track, "1 cookies", "1 rimossi" and similar now agree
  with the count, in the client and in the admin panel (`.one` / `.other` keys picked with
  `Intl.PluralRules`; the admin panel gets the same `tp()` helper as the client).
- **Studio mode switches**: the *Classico / Esplora* and *Locale / Web* labels are clickable
  (each picks its own mode) and keyboard accessible, not only the small switch between them.
- **Admin › Integrations no longer shows the Discogs token as configured on a fresh hub**:
  the hub reported Discogs as configured whether or not a token was set; now only a token
  from the environment or saved in the panel counts.
- **Android: play from the car or Bluetooth with the phone locked** (issue #99). A PLAY from
  the car, a headset or the lock screen now puts the media service in the foreground and
  takes the CPU and Wi-Fi locks at once, inside the window Android allows, and then hands
  the command to the player, which gets 15 s to answer (45 s while the app is starting)
  instead of 3 s. A service restarted by the car button no longer drops out of the
  foreground straight away, and the last track is kept so the car can resume it after the
  system stopped the service. If the app itself was closed, Android does not let it start
  from the background: the notification then offers *Open RE-KORD to resume*.
- **Android Auto and car head units**: the app is now a media browser service with a
  *Resume* item for the last track, and declares itself to Android Auto; the system's
  media controls can resume it too.
- **Podcasts: "Update failed (Source unreachable)" after a refresh** (issue #99). A feed
  answering "not modified" to the hub's conditional request (the usual answer when nothing
  new is out, as with Apple Podcasts shows) was taken for a failure, so the card showed the
  error while keeping the previous episodes. The hub now also retries a fetch hit by a
  network hiccup, a timeout or a brief server error (twice, within the time a list waits),
  finds the feed of an Apple Podcasts or Spreaker page from its address, and moves a source
  saved as a yt-dlp page (because Apple's lookup failed when it was added) to its feed as
  soon as that answers.
- **Studio › Download: confirm at once, visible loading** (issue #99). Downloading an album
  or playlist used to wait up to half a minute for yt-dlp to count its tracks, with no
  sign of life and a button that queued a new request at every click. The confirmation now
  opens immediately and the track count fills in when it arrives ("unknown" if it fails or
  takes too long); the button shows a spinner and refuses duplicates. Esplora searches,
  release lists and Scopri show spinners or placeholder rows, and errors appear next to
  the action (with a copy in the log) instead of at the bottom of the pane.
- **Scopri › Download** opens the same confirmation as the Download tab, on the folder
  picked there, instead of only filling in the link.
- **Download progress between the form and the log** (issue #99): the progress card no
  longer sits at the top of the pane; it follows the form, precedes the log and stays at
  the bottom of the screen while you scroll (mobile included).
- **YouTube cookies** (issue #99): yt-dlp rewrites the cookie file when it exits, so
  concurrent runs raced on it and a read-only file (Docker `:ro`, `REKORD_YTDLP_COOKIES`)
  failed. Each yt-dlp run now gets a private copy (mode 600, removed afterwards); only a
  successful download saves the refreshed cookies back into the uploaded file, never into
  one set by the environment. Podcast pages read through yt-dlp use the cookies too. An
  upload is validated before it replaces the current file (JSON exports and empty files
  get their own message) and is stored with mode 600. A download stopped by YouTube's
  sign-in or age check says so in the Download tab, with a hint and a link to Settings.
- **Track editor: genre list** (issue #99). The picker offered ten fixed genres instead of
  the library's, and genres were matched by spelling only: "R&B" and "Rhythm & Blues"
  became two chips (shown as "R&B · R&B"), "Hip-Hop" was offered for a track already
  tagged "Hip Hop" and then dropped silently on save, a pasted "Pop; Jazz" became one chip,
  and placeholders like "Unknown" or "8" were accepted. The editor now works like the album
  page: the library's genres (plus the starter list), one chip per genre whatever the
  spelling, a pasted list split on any separator, and a note when the genre is already
  there. Long lists no longer risk a duplicate-key error.
- **Playing row equalizer** (issue #99): the active track row animates again while music
  plays, like 5.0 legacy, and rests on the static equalizer glyph when paused. Only the
  first listing of the playing track moves (and the Smart Radio tile); on Linux it changes
  pose once per second together with the sidebar icon, so it costs no extra frames.
- **Quality alerts count the same everywhere** (issue #99): the hub and the client now share
  one definition of each issue, always restricted to the account's library selection. A
  track tagged only with a placeholder genre ("Unknown", "Music", "8") counts as without
  metadata; an album with a release date, label or country counts as having metadata.

### Known issues

- Android: a play sent from a car or a Bluetooth device after the app has been paused in the
  background for more than about 10 minutes may not start; open RE-KORD from the
  notification or the media player to resume. Plays within 10 minutes of a pause work with
  the screen locked.
- YouTube can refuse yt-dlp from some networks ("Sign in to confirm you're not a bot") even
  with a JavaScript engine; uploading cookies exported from a signed-in private window
  usually solves it.

## 5.1.0 — 2026-10-09

A feature and polish release on top of RE-KORD 5: podcasts and news, embedded tags and
covers for every format, keep-awake for the hub, reliable Android background playback,
native media controls on Linux and the fixes from GitHub issue #97. Hubs and clients 5.0
and 5.1 work together; the database migrates automatically (schema v7).

### New

- **Podcast e notizie** (optional module, off by default): news bulletins, podcasts and
  live radio in the normal player. Sources are set in the admin panel (*Podcasts &
  news*) with a **Test** preview: RSS / Atom feeds, pages that point to a feed (Apple
  Podcasts, WordPress, Spreaker), play.rtl.it programme archives such as RTL 102.5's
  *Giornale Orario*, pages yt-dlp can read, and MP3 / AAC streams (also from `.m3u` /
  `.pls`). HLS streams are not supported.
- Home card and a *Podcasts & news* section with the latest episodes per source
  (relative date, length, time left), resume where you stopped, "listened" marks synced
  per account (last 200 episodes), and an opt-in to show podcast listens in *Recent*.
- Episodes and radio play through a hub proxy (Range and seeking, visualizers keep
  working) restricted to the configured episodes, with the SSRF guard on every redirect.
  They never count as plays (statistics, achievements, history, Plectr), crossfade is off
  around them, live streams show **LIVE** and cannot be seeked.
- Lightweight by design: fetched only when a card or the section opens, cached (30 min by
  default, conditional requests), never polled; with the module off the hub does nothing
  and clients load none of its code.
- Database schema v6 (`podcast_sources`).
- **Prevent the computer from sleeping** (admin panel *Network › Power*), so a hub reached
  from the LAN, the tunnel or remote desktop does not doze off: **Never** (default),
  **Always**, or **Only when in use** (playback, transcodes, podcast streams, scans,
  downloads and jobs, tunnel traffic) plus a grace period (10 min, 1–120). Only system
  sleep is blocked; the screen still turns off. Linux uses a systemd-logind inhibitor
  (plus GNOME's session inhibitor on GNOME) that ends with the hub even after a crash,
  with an optional *keep awake with the lid closed*; Windows uses
  `SetThreadExecutionState`. Live status in the panel, applied without restart, saved in
  `settings.json` (and so in backups), `GET/PUT /api/v1/system/power`, and
  `--prevent-sleep off|always|when-active` / `REKORD_PREVENT_SLEEP` for headless hubs.
  Event driven: no polling, nothing runs while it is off.
- **Custom theme text color**: a *Text color* picker in the custom theme (main text; the
  secondary text colors follow it automatically). *Automatic* keeps the previous
  behavior. A warning appears when text on the sections falls below the WCAG AA contrast
  (4.5:1). Included in theme export / import; *Extract colors from image* now also picks a
  readable text color.
- **Desktop widths** (*Settings › Interface*, saved per device): *Content width* (default
  1360 px as before, *Full*, 1200 / 1440 / 1680 / 1920 px or a custom 960–2560 px slider
  with live preview; the header follows the content) and *Player bar width* (default as
  before, *Full*, *Match content*, presets or custom). The content and the bar stay
  centered; phones and narrow windows keep the adaptive layout.

- **Embedded metadata and covers for every format** (GitHub issue #97): tags stored in
  FLAC, Ogg Vorbis and Opus (Vorbis comments, also multi-value and `4/11` numbers), MP3
  (ID3v2, ID3v1, APE), M4A / AAC / ALAC (MP4 atoms), WAV (ID3v2, RIFF INFO), AIFF, and,
  through ffmpeg, WMA and WebM: title, artist, album artist, album, track / disc number
  and totals, date, genres, BPM, lyrics and MusicBrainz ids. Read on the first scan of a
  file and when it changes, filling only what Studio (or a sidecar, a fetch, the previous
  version) did not curate; typed values are never overwritten. Each value records where
  it came from (`embedded_fields` / `curated_fields` in the API).
- **Embedded covers**: albums without an image in their folder get the front cover stored
  in one of their files (else its first picture), scaled to 1500 px at most and kept in
  `<data dir>/covers/embedded/`, with the usual thumbnails and cache busting. Studio covers
  and folder images keep winning; the music folder is never written by a scan. Broken
  pictures are skipped (logged once per album).
- Admin panel **Library › Embedded metadata**: *Read embedded metadata and covers* (on by
  default) and the priority *Studio > embedded > file name* (default) or *Embedded >
  Studio* (filling only); **Maintenance › Re-read embedded metadata** (optionally also
  replacing values typed in Studio, with the embedded priority). `GET/PUT
  /api/v1/library/embedded`, `POST /api/v1/library/embedded/reread`.
- Libraries indexed by 5.0 are completed once by a background job (*Reading embedded
  metadata*: throttled, paused during scans, resumable, with progress in **Jobs**).
  Database schema v7.
- **Linux: native media controls (MPRIS).** GNOME's media widget, shell extensions and the
  media keys now see RE-KORD as `org.mpris.MediaPlayer2.rekord`, with title, artist,
  album, cover and Play / Pause / Next / Previous / Seek, in the client and the server
  app. Updates are sent only on changes; the player exists only while something is queued.
- **Instant playlist** (Home › *Playlist al volo*): a clearer builder with genre and mood
  chips (icon, name, live counts), a match mode shown only when it matters, a result bar
  with the number of tracks and their length, *Start playlist* and *Add to queue*, and the
  selection remembered per account.
- `pnpm dev:hub`: hub, client UI and admin panel together for development, without Tauri
  or the GTK development packages.

### Changed

- **Scans are lighter**: pictures stored in the files are no longer loaded for every file,
  only for a few tracks of an album that needs a cover.
- **Plectr has no track picker any more.** The game plays on the song in the player
  (playing or paused), chosen in the library like everywhere else. With nothing in the
  player the stage shows *"Start a song from the library to play"* with **Open the
  library** and **Shuffle play**; "Change song" is gone from the stage, the pause menu,
  the results and the side panel. Records stay (▶ plays that song).
- **Plectr on phones keeps the player bar** at the bottom, as in 5.0: the pads sit above
  it, higher and easier to reach, behind a guard strip. Presses that start on the lanes
  never reach the bar and a bar tap right after a pad press is ignored; pausing or
  skipping from the bar drives the game as before.
- The Plectr **"Cover" stage backdrop was removed**; saved settings move to the default,
  the visualizer (the light stage, automatic on WebKitGTK and weak devices, still turns
  it off).
- **Phones: tighter, consistent spacing** (issue #97). Below the desktop breakpoint the
  spacing scale is one notch smaller (page gutter 12px instead of 16px, 8px between cards,
  slimmer card, tile and track-row padding), so more of each screen is content: the album
  page puts the cover beside the title and actions as in 5.x (the first tracks are on the
  first screen), artist / album / genre tiles use a 56px cover, track rows are closer
  together, and the player bar shows the times beside the seek bar instead of on a line
  of their own (one row shorter). The bottom nav is 54px. Touch targets stay at least
  44px (dense chips and sort options get an invisible hit area instead of padding). The
  desktop layout is unchanged.
- **Linux desktop app is lighter during playback**: on WebKitGTK the timeline and the
  Studio icon now change once per second, so a playing track costs one frame per second
  (about half the CPU in Queue and Library, including GNOME Shell's share).
- **Genre aliases are merged**: "Drum & Bass" / "Drum and Bass", "R&B" / "Rhythm & Blues"
  and "Rock & Roll" spellings show as one genre in the library and the instant playlist.
- **No scrollbars on touch screens**: pages, sheets and lists still scroll (touch,
  momentum, jump-to-track) but no longer draw a scrollbar or reserve its gutter. With a
  mouse they are unchanged.

### Fixed

- **Android: background playback is reliable with the screen off, in the car and across
  network changes.** Tracks sometimes did not start, or stopped after a while:
  - the media service left the foreground at every pause, and a pause caused by a call or
    another app ended with Android 12+ refusing to bring it back (the app could close);
    it now stays in the foreground while playing, while a track loads or reconnects, and
    for 10 minutes after a pause;
  - CPU and Wi-Fi now stay awake while playing (the gap between two tracks let the phone
    sleep and Wi-Fi doze);
  - a stalled stream is reconnected at the same position (also right after a switch
    from Wi-Fi to mobile data), a network error no longer skips the track as unreadable,
    a `play()` refused in the background is retried, and the next track is buffered 20 s
    ahead;
  - a heartbeat from the service drives these checks while the page's timers are
    throttled;
  - the queue end now clears the notification's "playing" state.
- **Android: music resumes after an interruption.** Calls, voice notes and navigation
  prompts were already resumed by the WebView; now, when another app's music or video
  pauses RE-KORD, playback resumes once that audio stops (within 30 minutes, never after
  you paused it yourself or after headphones / the car disconnected). No second audio
  focus request: the service only watches other apps' playback and the call state.
- Android diagnostics: `adb logcat -s RekordMedia` shows state changes, stalls,
  reconnects, network changes and interruptions (quiet in normal playback).

- **FLACs showed no metadata** when their tags were not in the primary tag (for example an
  ID3v2 block in front of the FLAC stream, or numbers written as `4/11`), and only the first
  of several `GENRE` / `ARTIST` values was kept: every tag of a file is now read and
  merged, and a file whose pictures cannot be read still gets its tags.
- **"Extract colors from image" always failed in the desktop app** (and in any client not
  served by the hub itself): the image was fetched with browser credentials, which the
  hub's CORS answer does not allow, so the browser blocked it. It now goes through the
  normal hub connection; JPEG, PNG, WebP, large images and animated GIFs all work.
- **Long titles and artists stretched the desktop player bar**: they are now cut with "…"
  on one line (full text in the tooltip), like on phones. Same for artist · album in the
  Studio › Listen header, with tooltips on track rows and library tiles.
- The desktop header row now lines up exactly with the page content (it was offset by
  half a scrollbar).
- **Plectr could not be closed on phones**: ✕ during a run only paused the game and then
  ignored further taps. ✕, *Exit* in the pause menu and the results, and Back (first
  press pauses, second exits) now always leave Plectr and restore the app's bars.
- **Adding a genre to an album could crash the album page** (issue #97, phones and
  desktop alike; changing page brought it back): genres with two spellings of one name
  in the library, such as "Rhythm & Blues" next to "R&B" or "Drum & Bass" next to
  "Drum and Bass", put the same entry twice in *Aggiungi genere*, which the page cannot
  render. Aliases are now one chip and one menu entry, removing a genre removes its
  aliases too, and the menu closes as soon as a genre is picked (a second tap during the
  save could start a concurrent edit).
- **Web app (PWA): tracks were downloaded several times** while loading when the service
  worker was active (up to five times the file size in WebKit-based browsers): audio,
  transcode and podcast streams now bypass the service worker.
- The offline app fell back to Italian: English and German translations are now cached too.
- Saving metadata or a cover in Studio no longer triggers a full library re-index a few
  seconds later.
- Podcasts: hardened proxy (audio content types only, header timeouts, no system proxy),
  bounded feed and artwork parsing, a forced refresh honours the error backoff, and source
  addresses (which may contain tokens) are hidden from users who cannot manage the hub.
- A pause pressed while the player is reconnecting or loading always wins.
- Closing the admin panel during a scan no longer leaves the scan lock (and the keep-awake
  activity) held until restart.
- Studio › Listen no longer shows a doubled "· ·" separator.
- Cast: podcast episodes start at their resume point on the receiver.
- **Phones: the end of a page was hidden behind the bottom nav** when nothing was in the
  player; it now always clears the nav and the home indicator.

### Known issues

- Linux: while a track plays, GNOME may also list a second, bare "RE-KORD" media entry
  created by WebKitGTK itself, next to the full native one.
- Android background playback was verified on an emulator; real phones with aggressive
  battery savers, Bluetooth head units and car systems are still to be confirmed.

## 5.0.0 — RE-KORD 5

RE-KORD 5 is a ground-up rewrite. The legacy React / Node / Electron / Capacitor app is
replaced by a Rust hub, a Svelte client and Tauri 2 shells. Every feature of the legacy app
is carried over, your data is imported automatically, and a lot is new or fixed.

The legacy app, last released as 5.0, is preserved at the tag `legacy-5.0`. Read
[Upgrading from legacy RE-KORD](docs/upgrading-from-legacy.md) before you switch.

### Breaking changes

- The hub listens on port **7420** (was 3001).
- The hub keeps its data in its own folder (`REKORD_DATA_DIR`) instead of the Electron
  config folder; see the upgrade guide for every platform.
- Docker: the `/config` volume is replaced by `/data`, and environment variables were
  renamed (`REKORD_BIND`, `REKORD_DATA_DIR`, `REKORD_MUSIC_ROOT`).
- Android: the app is signed with a new key. Uninstall the legacy app before installing.
- The desktop and Android apps now bundle their own UI instead of loading it from the hub,
  so they are updated by installing a new version.
- The API moved to `/api/v1` with a `{ ok, data }` envelope and stable error codes.
- Cross-origin requests are restricted, and host-level operations require the hub computer
  or an explicit remote-admin switch (see [SECURITY.md](SECURITY.md)).

### New architecture

- **Hub in Rust** (`rekord-server`, `crates/core`): one self-contained binary built on
  axum, Tokio and SQLite. Low memory use, fast start-up, graceful shutdown that closes the
  database cleanly.
- **Client in Svelte 5**: one codebase for the browser, desktop and Android, with
  lazy-loaded views and languages.
- **Tauri 2 shells** for Linux, Windows and Android. The **RE-KORD Server** app embeds the
  hub in the desktop app, like the legacy Electron "Server" app, and serves the web client
  and admin panel to the rest of the network.
- **Admin panel** at `/admin`: music folder, library structure, scans and scan reports,
  jobs, diagnostics, activity log, backups, accounts, integrations and network.
- **Packaging**: one command per platform and flavor (`scripts/pack.sh`), built in a Docker
  image so the host only needs Docker. Portable Windows downloads (single exe for the
  client, folder for the server). A headless Linux package with a hardened systemd unit.
  yt-dlp, cloudflared and ffmpeg are bundled at pinned versions and verified with SHA-256.
- **Docker image**: multi-stage build, non-root user, health check, amd64 and arm64.
- **CI** on every push and pull request: version consistency, rustfmt, clippy, Rust and
  JavaScript tests, type checks, the desktop bundle, an Android APK and the Docker image.

### Data and migration

- **Automatic one-time import** of a legacy library: the first scan of a music folder that
  contains `.kord` imports curated metadata, accounts, settings, favorites, playlists (in
  legacy order), library selections, play counts, history, moods, shuffle exclusions, theme
  backgrounds and Plectr records. Legacy credentials (Discogs token, YouTube cookies) are
  imported once at start-up. Later scans never resurrect data you deleted.
- Explicit **merge** from `.kord` at any time (admin panel, client or
  `--sync-legacy-meta`) that never overwrites newer data.
- Legacy (v2) **backup ZIPs** restore directly; the new v3 backup adds hub settings and
  per-account state. Accounts are matched by name on restore.

### Library

- **Embedded tags are imported on scan**: title, album, multiple genres, full release dates,
  track and disc numbers, BPM and lyrics (inspired by PR #95 by @knoellix).
- **Exact durations for long VBR MP3s** without a Xing header: frames are counted on scan
  and a synthetic seek header is served with the file, so long DJ sets show the right length
  and seek accurately (inspired by PR #95 by @knoellix).
- **WMA, AIFF and ALAC play everywhere**: the hub converts them once to a cached FLAC copy
  that seeks like any file.
- Display titles and album names are separate from file names, cleaned of numbering and
  video noise; musical versions such as "(Live)" or "(Remix)" are kept.
- Curated and hand-edited values are protected across rescans, imports and metadata fetches.
- Normalised multi-genre support, full dates (`YYYY-MM-DD`, `YYYY-MM`, `YYYY`) and
  track/disc numbers inferred from file names when tags lack them.
- Full-text, accent-insensitive search over titles, artists, albums and genres.
- **Safe rescans**: an incremental scan refuses to drop a large part of the library at
  once (for example when a disk is not mounted) and reports what is missing; favorites and
  playlist entries reconnect when a file returns.
- Per-account library statistics, added/updated timestamps ("recently updated" albums), and
  a filesystem watcher that coalesces bursts of changes into one update.

### Listening

- Per-account queue synced to the hub, so it follows you between devices.
- Near-gapless playback with crossfade off; crossfade of 3 or 5 seconds.
- Smart shuffle and Smart Radio by moods, genres and history; instant playlists from genres
  and moods on the dashboard.
- Automatic recovery when the hub goes away and comes back; failing tracks are skipped.
- **Google Cast** from Chrome and, natively, from the Android app, with transcoding for
  formats receivers cannot play.
- **Android**: media notification and lock-screen controls with the screen off, audio focus
  (pause on calls and when headphones are unplugged), Back sends the app to the background
  without stopping music, portrait on phones, files saved to Downloads, QR pairing.
- Sonic Nebula, DiscoWall, karaoke and eight visualizers.

### Studio

- Rewritten Studio with **Listen**, **Discover**, **Download**, **Metadata** and **Covers**.
- Downloads run as hub jobs that survive a closed tab: re-attach to see progress, per-item
  results (downloaded, already present, failed with a reason), and the folder is re-indexed
  before completion.
- **Update yt-dlp** from the app: the hub fetches the latest official release and verifies
  its checksum.
- Discover › Web: new releases from YouTube Music with 30-second previews.
- Metadata matching uses the track list first and similarity thresholds, so wrong matches are
  rejected instead of written.
- **Curiosità** (trivia) rebuilt: multi-source search (Wikipedia, Wikiquote, Last.fm,
  Discogs, TheAudioDB), per-language entries, editing before saving, artist photos.

### Plectr

- Redesigned game with a portrait 9:16 stage, real pause, results screen, per-difficulty
  records synced to the account, latency calibration, key remapping, light stage for slower
  devices and a challenge mode.

### Interface

- New design system: self-hosted fonts (no Google Fonts requests), consistent type scale,
  accessible dialogs, skeletons and empty states.
- History-based navigation: Back closes dialogs first, then returns to the previous view.
- Faster on Linux (WebKitGTK): no animated icons in lists, capped canvases, glass blur only on
  the few fixed surfaces (top bar, player bar, sidebar, first card).
- **German translation** by @knoellix (PR #93), alongside Italian and English, with tests
  that keep the three languages in sync.
- Update banners when the app and the hub are out of step.

### Security

- Path traversal protection on every file route.
- Browser origin policy: only the hub's own pages, the Tauri apps, the development servers
  and configured origins may call the API.
- Library and machine operations restricted to the hub computer (and the Default account
  for machine operations) unless remote administration is turned on.
- Validated account ids; artwork downloads protected against server-side request forgery.
- Security headers on every response.

## Earlier versions

The legacy app's history (1.x to 4.4 and the legacy 5.0) is on
[GitHub Releases](https://github.com/Creiv/RE-KORD/releases) and in the repository tags.
Highlights:

- **Legacy 5.0**: structural refactor, graceful shutdown, job queue, diagnostics, CI and
  end-to-end tests, offline PWA shell.
- **4.4**: server-side cover thumbnails.
- **4.3**: Sonic Nebula, Smart Radio on the dashboard, Android background resilience.
- **4.2**: adaptive library scan (layout detection), Discogs integration.
- **4.1**: SQLite library core, artwork cache, Cast to Google Home, sleep timer, Pro
  Workspace UI.
- **4.0**: Android client with QR pairing, theme sharing, adjustable glass.

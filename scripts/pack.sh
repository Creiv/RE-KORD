#!/usr/bin/env bash
# RE-KORD packages: one command per platform and flavor, as in 5.0.
#
#   pnpm pack:linux:server   release/linux/
#                              RE-KORD-Server-<v>-linux-x64.AppImage / .deb   desktop app with the hub
#                              RE-KORD-Server-<v>-linux-x64-headless.tar.gz   windowless hub (systemd)
#   pnpm pack:linux:client   release/linux/
#                              RE-KORD-Client-<v>-linux-x64.AppImage / .deb
#   pnpm pack:win:server     release/windows/
#                              RE-KORD-Server-<v>-windows-x64.zip   folder with "RE-KORD Server.exe"
#                                                                   (embedded hub), no installer
#   pnpm pack:win:client     release/windows/
#                              RE-KORD-Client-<v>-windows-x64.exe   single exe, just run it
#   pnpm pack:android        release/android/
#                              RE-KORD-Client-<v>-android-arm64.apk   (optimized build; signed
#                              with keystore.properties if present, otherwise with the debug key)
#   pnpm pack:all            all of the above
#
#   scripts/pack.sh <linux|windows|android|all> [server|client|all] [options]
#     --no-tools   server flavor without yt-dlp, qjs, cloudflared and ffmpeg (uses the system ones)
#     --native     no Docker: requires the full toolchain on this machine
#
# Linux and Windows are built in a Docker container (scripts/docker/builder.Dockerfile)
# that has webkit2gtk, GStreamer and cargo-xwin: Docker is all this machine needs. It is
# skipped with --native, or automatically on Linux when webkit2gtk-4.1 is already installed.
# Android uses the local SDK/NDK (scripts/lib/android-env.sh).
#
# Every run updates release/<platform>/SHA256SUMS; the full log is
# release/<platform>/build.log.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

usage() { awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "$0"; }
die() { echo "ERROR: $*" >&2; exit 1; }
step() { echo; echo "==> $*"; }

PLATFORM=""
FLAVOR=all
TOOLS=1
NATIVE=0
ARGS=("$@")
# First word: platform; second (optional): flavor. "all" is valid for both,
# so the position matters, not the value.
POSITIONAL=0
while (( $# )); do
  if [[ "$1" != -* ]]; then
    POSITIONAL=$((POSITIONAL + 1))
    case "$POSITIONAL:$1" in
      1:linux|1:windows|1:android|1:all) PLATFORM="$1" ;;
      1:win) PLATFORM=windows ;;
      2:server|2:client|2:all) FLAVOR="$1" ;;
      1:*) die "unrecognized platform: $1 (linux, windows, android, all)" ;;
      2:*) die "unrecognized flavor: $1 (server, client, all)" ;;
      *) die "extra argument: $1" ;;
    esac
    shift
    continue
  fi
  case "$1" in
    --no-tools) TOOLS=0 ;;
    --native) NATIVE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unrecognized option: $1 (--help for the list)" ;;
  esac
  shift
done
[[ -n "$PLATFORM" ]] || { usage; exit 2; }

passthrough=()
(( TOOLS )) || passthrough+=(--no-tools)
(( NATIVE )) && passthrough+=(--native)

if [[ "$PLATFORM" == all ]]; then
  "$0" linux "$FLAVOR" "${passthrough[@]}"
  "$0" windows "$FLAVOR" "${passthrough[@]}"
  if [[ "$FLAVOR" != server ]]; then "$0" android "${passthrough[@]}"; fi
  exit 0
fi

VERSION="$(node -p 'require("./package.json").version')"
TRIPLE_WIN=x86_64-pc-windows-msvc
TOOLS_PLATFORM=""
case "$PLATFORM" in
  linux) OUT="$ROOT/release/linux"; TOOLS_PLATFORM=linux-x64 ;;
  windows) OUT="$ROOT/release/windows"; TOOLS_PLATFORM=windows-x64 ;;
  android) OUT="$ROOT/release/android"; FLAVOR=client ;;
esac
mkdir -p "$OUT"
want() { [[ "$FLAVOR" == all || "$FLAVOR" == "$1" ]]; }

# --- Outside the container: preparation, then (if needed) re-enter via Docker ----
if [[ -z "${REKORD_BUILDER:-}" ]]; then
  LOG="$OUT/build.log"
  : > "$LOG"
  exec > >(tee -a "$LOG") 2>&1
  echo "RE-KORD $VERSION — $PLATFORM ($FLAVOR) — $(date -Is)"

  step "Version check"
  node scripts/version.mjs check "$VERSION"

  step "JS dependencies (frozen lockfile)"
  pnpm install --frozen-lockfile

  if [[ "$PLATFORM" != android ]] && want server && (( TOOLS )); then
    step "yt-dlp, QuickJS-ng, cloudflared, ffmpeg for $TOOLS_PLATFORM (verified download)"
    bash scripts/fetch-tools.sh "$TOOLS_PLATFORM"
  fi

  use_docker=0
  if [[ "$PLATFORM" == windows && "$(uname -s)" == Linux ]] && (( ! NATIVE )); then
    use_docker=1
  elif [[ "$PLATFORM" == linux ]] && (( ! NATIVE )); then
    pkg-config --exists webkit2gtk-4.1 dbus-1 2>/dev/null || use_docker=1
  fi

  if (( use_docker )); then
    command -v docker >/dev/null || die "Docker is required (or --native with the toolchain installed)"
    DOCKERFILE="$ROOT/scripts/docker/builder.Dockerfile"
    # The tag follows the Dockerfile's content: when that changes, the image is rebuilt.
    IMAGE="rekord-builder:$(sha256sum "$DOCKERFILE" | cut -c1-12)"
    if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
      step "Build image $IMAGE (first time only, a few minutes)"
      docker build -f "$DOCKERFILE" -t "$IMAGE" "$ROOT/scripts/docker"
    fi
    CACHE="${REKORD_BUILDER_CACHE:-$HOME/.cache/rekord-builder}"
    mkdir -p "$CACHE/cargo" "$CACHE/xwin" "$CACHE/home"
    REPO="$ROOT"
    step "Building in Docker ($IMAGE)"
    tty=()
    [[ -t 0 ]] && tty=(-t)
    # Same absolute path inside and outside: pnpm links and paths in the logs
    # stay valid. Target dir kept separate from the host's (different glibc).
    docker run --rm "${tty[@]}" \
      --user "$(id -u):$(id -g)" \
      -v "$REPO:$REPO" -w "$ROOT" \
      -v "$CACHE:/cache" \
      -e CARGO_TARGET_DIR="$ROOT/target/docker" \
      -e CI=true \
      "$IMAGE" bash scripts/pack.sh "$PLATFORM" "$FLAVOR" "${passthrough[@]}"
  else
    REKORD_BUILDER=native bash "$0" "${ARGS[@]}"
  fi

  step "Checksums"
  (
    cd "$OUT"
    find . -maxdepth 1 -type f -name 'RE-KORD-*' -printf '%f\0' | sort -z | xargs -0 -r sha256sum > SHA256SUMS
    cat SHA256SUMS
  )
  echo
  echo "Done: $OUT (log: $LOG)"
  exit 0
fi

# --- Inside the container (or native): the actual build -------------------------
TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/target}"
MARKER="$(mktemp)"
trap 'rm -f "$MARKER"' EXIT

tauri() { pnpm --filter @rekord/client-shell exec tauri "$@"; }

# copy_bundles <bundle dir> <final name without extension> <extensions...>
copy_bundles() {
  local dir="$1" base="$2"; shift 2
  local ext f dest found=0
  for ext in "$@"; do
    f="$(find "$dir" -type f -name "*.$ext" -newer "$MARKER" 2>/dev/null | head -n1)"
    [[ -n "$f" ]] || continue
    dest="$OUT/$base.$ext"
    [[ "$ext" == exe ]] && dest="$OUT/$base-setup.exe"
    cp -f "$f" "$dest"
    echo "  $dest"
    found=1
  done
  (( found )) || die "no package produced in $dir"
}

server_flavor_args() {
  printf '%s\n' --features hub --config src-tauri/tauri.hub.conf.json
  if (( TOOLS )); then
    # The tools go into the app's resources, under bin/ (embedded_hub.rs).
    printf '%s\n' --config \
      "{\"bundle\":{\"resources\":{\"../../../release/bin/$TOOLS_PLATFORM/\":\"bin/\"}}}"
  fi
}

stage_headless_tools() {
  local dest="$1"
  (( TOOLS )) || return 0
  mkdir -p "$dest/bin"
  cp -a "$ROOT/release/bin/$TOOLS_PLATFORM/." "$dest/bin/"
}

# GStreamer plugins the AppImage bundles (bundleMediaFramework copies every plugin
# of GSTREAMER_PLUGINS_DIR). Only what WebKit needs to play the library: the full
# set (250+) made GStreamer scan for seconds at the first launch of each version
# and weighed on the package. Formats: MP3 (mpg123), AAC/ALAC (libav), FLAC, Ogg
# Vorbis, Opus, WAV, WavPack, WebM/Matroska; Web Audio needs app, interleave,
# rawparse and gio. Checked with all of them by playing each format in WebKitGTK.
GST_PLUGINS_KEEP=(
  coreelements typefindfunctions playback app gio autodetect pulseaudio pipewire alsa
  audioconvert audioresample volume audiofx rawparse interleave pbtypes videoconvertscale
  audioparsers id3demux apetag icydemux mpg123 libav flac isomp4 ogg vorbis opus
  wavparse wavpack matroska
)

curate_gstreamer_plugins() {
  local src dir p
  src="/usr/lib/$(uname -m)-linux-gnu/gstreamer-1.0"
  [[ -d "$src" ]] || src=/usr/lib/gstreamer-1.0
  dir="$TARGET_DIR/gst-plugins-bundle"
  rm -rf "$dir" && mkdir -p "$dir"
  for p in "${GST_PLUGINS_KEEP[@]}"; do
    if [[ -f "$src/libgst$p.so" ]]; then
      cp -L "$src/libgst$p.so" "$dir/"
    else
      echo "warning: GStreamer plugin '$p' not found in $src" >&2
    fi
  done
  export GSTREAMER_PLUGINS_DIR="$dir"
}

linux_client() {
  step "Linux desktop client (deb + AppImage)"
  touch "$MARKER"
  curate_gstreamer_plugins
  tauri build --bundles deb,appimage
  copy_bundles "$TARGET_DIR/release/bundle" "RE-KORD-Client-$VERSION-linux-x64" AppImage deb
}

linux_server() {
  step "Linux desktop server, embedded hub (deb + AppImage)"
  touch "$MARKER"
  local flavor
  mapfile -t flavor < <(server_flavor_args)
  curate_gstreamer_plugins
  tauri build --bundles deb,appimage "${flavor[@]}"
  copy_bundles "$TARGET_DIR/release/bundle" "RE-KORD-Server-$VERSION-linux-x64" AppImage deb

  step "Linux headless hub (tarball + systemd)"
  pnpm build:ui
  cargo build -p rekord-server --release --locked
  local name="RE-KORD-Server-$VERSION-linux-x64-headless"
  # Staged outside the shared folder: with Docker Desktop, file permissions on the
  # mounted volume cannot be changed (chmod is refused).
  local stage_root
  stage_root="$(mktemp -d)"
  local stage="$stage_root/$name"
  mkdir -p "$stage/systemd"
  install -m 0755 "$TARGET_DIR/release/rekord-server" "$stage/rekord-server"
  cp -a apps/client-ui/dist "$stage/client-ui"
  cp -a apps/server-ui/dist "$stage/admin-ui"
  cp -f modules.manifest.toml "$stage/modules.manifest.toml"
  cp -f scripts/linux/rekord-server.service scripts/linux/rekord-server.env scripts/linux/install.sh \
    scripts/linux/50-rekord-power.rules "$stage/systemd/"
  stage_headless_tools "$stage"
  echo "$VERSION" > "$stage/VERSION"
  cat > "$stage/run.sh" <<'EOF'
#!/usr/bin/env bash
# Starts the RE-KORD hub with the UIs shipped in this package.
# Options and variables: ./rekord-server --help (REKORD_BIND, REKORD_DATA_DIR, ...).
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
# The package's yt-dlp (with its JavaScript runtime), cloudflared and ffmpeg, if present.
if [[ -z "${YTDLP_PATH:-}" && -x "$DIR/bin/yt-dlp" ]]; then export YTDLP_PATH="$DIR/bin/yt-dlp"; fi
if [[ -z "${REKORD_YTDLP_JS_BIN:-}" && -x "$DIR/bin/qjs" ]]; then export REKORD_YTDLP_JS_BIN="$DIR/bin/qjs"; fi
if [[ -z "${REKORD_CLOUDFLARED_BIN:-}" && -x "$DIR/bin/cloudflared" ]]; then export REKORD_CLOUDFLARED_BIN="$DIR/bin/cloudflared"; fi
if [[ -z "${REKORD_FFMPEG:-}" && -x "$DIR/bin/ffmpeg" ]]; then export REKORD_FFMPEG="$DIR/bin/ffmpeg"; fi
exec "$DIR/rekord-server" \
  --client-ui "${REKORD_CLIENT_UI:-$DIR/client-ui}" \
  --admin-ui "${REKORD_ADMIN_UI:-$DIR/admin-ui}" \
  "$@"
EOF
  chmod +x "$stage/run.sh"
  cat > "$stage/README.txt" <<EOF
RE-KORD hub $VERSION (Linux x64, windowless)

Quick try:
  ./run.sh                       http://<this-machine>:7420  (admin panel: /admin)
  REKORD_BIND=127.0.0.1:7420 ./run.sh

As a service (dedicated user, automatic start, data in /var/lib/rekord):
  sudo ./systemd/install.sh

bin/ contains yt-dlp, qjs (QuickJS-ng, the JavaScript runtime yt-dlp needs for YouTube;
MIT, license in bin/qjs-LICENSE.txt), cloudflared and ffmpeg (LGPL, license in
bin/ffmpeg-LICENSE.txt); without it, the hub uses the ones on the PATH. For the windowed app use RE-KORD-Server-*.AppImage.
EOF
  tar -C "$stage_root" -czf "$OUT/$name.tar.gz" "$name"
  rm -rf "$stage_root"
  echo "  $OUT/$name.tar.gz"
}

# Windows without an installer, as in 5.0: just run the exe. WebView2 is already present on
# up-to-date Windows 10/11; the loader is statically linked into the exe.
windows_tauri() {
  tauri build --runner cargo-xwin --target "$TRIPLE_WIN" --no-bundle "$@"
}

windows_client() {
  step "Windows desktop client (portable exe)"
  windows_tauri
  local dest="$OUT/RE-KORD-Client-$VERSION-windows-x64.exe"
  cp -f "$TARGET_DIR/$TRIPLE_WIN/release/rekord-client.exe" "$dest"
  echo "  $dest"
}

windows_server() {
  step "Windows desktop server, embedded hub (portable folder in a zip)"
  local flavor
  mapfile -t flavor < <(server_flavor_args)
  windows_tauri "${flavor[@]}"
  pnpm build:server-ui
  # The app looks for the UIs and tools next to the exe (resource_dir on Windows).
  local name="RE-KORD-Server-$VERSION-windows-x64"
  # Staged outside the shared folder: with Docker Desktop, file permissions on the
  # mounted volume cannot be changed (chmod is refused).
  local stage_root
  stage_root="$(mktemp -d)"
  local stage="$stage_root/RE-KORD Server"
  mkdir -p "$stage"
  cp -f "$TARGET_DIR/$TRIPLE_WIN/release/rekord-server-app.exe" "$stage/RE-KORD Server.exe"
  cp -a apps/server-ui/dist "$stage/admin-ui"
  cp -a apps/client-ui/dist "$stage/client-ui"
  stage_headless_tools "$stage"
  printf '%s\r\n' \
    "RE-KORD Server $VERSION (Windows x64)" \
    '' \
    'Start: double-click "RE-KORD Server.exe". The window is the client; the hub starts' \
    'with it and stays reachable from other devices at http://<IP-of-this-PC>:7420' \
    '(admin panel: /admin). On first start Windows asks whether to allow network access:' \
    'answer yes for private networks.' \
    '' \
    'Keep the exe together with the admin-ui, client-ui and bin folders: the whole folder' \
    'can be moved anywhere. bin\ contains yt-dlp, qjs (QuickJS-ng, the JavaScript runtime' \
    'yt-dlp needs for YouTube; MIT, license in bin\qjs-LICENSE.txt), cloudflared and ffmpeg' \
    '(LGPL, license in bin\ffmpeg-LICENSE.txt). Data: %APPDATA%\app.rekord.server.' \
    > "$stage/README.txt"
  rm -f "$OUT/$name.zip"
  (cd "$stage_root" && zip -qr "$OUT/$name.zip" "RE-KORD Server")
  rm -rf "$stage_root"
  echo "  $OUT/$name.zip"
}

android_client() {
  step "Android client (arm64 APK, optimized build)"
  touch "$MARKER"
  bash scripts/android-build.sh --release
  local apk
  apk="$(find apps/client-shell/src-tauri/gen/android/app/build/outputs/apk -type f -name '*.apk' -newer "$MARKER" | head -n1)"
  [[ -n "$apk" ]] || die "no APK produced"
  cp -f "$apk" "$OUT/RE-KORD-Client-$VERSION-android-arm64.apk"
  echo "  $OUT/RE-KORD-Client-$VERSION-android-arm64.apk"
}

case "$PLATFORM" in
  linux)
    if want client; then linux_client; fi
    if want server; then linux_server; fi
    ;;
  windows)
    if want client; then windows_client; fi
    if want server; then windows_server; fi
    ;;
  android) android_client ;;
esac

#!/usr/bin/env bash
# Downloads and verifies the tools bundled with the "server" packages:
# yt-dlp (downloads in Studio), QuickJS-ng (the JavaScript runtime yt-dlp needs for
# YouTube), cloudflared (tunnel for remote access) and ffmpeg (transcoding for
# Cast). They end up in release/bin/<platform>/.
#
#   scripts/fetch-tools.sh [platform]     linux-x64 | linux-arm64 | windows-x64
#
# A file already present at the pinned version is not downloaded again.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/lib/fetch-common.sh"

PLATFORM="${1:-$(rk_default_platform)}"
DEST="$RK_FETCH_ROOT/release/bin/$PLATFORM"
EXT=""
[[ "$PLATFORM" == windows-* ]] && EXT=".exe"

# The pinned versions live in each tool's own script: they are read from there
# to tell whether the copy already downloaded is the right one.
pinned() { sed -n "s/^$1=\"\${$1:-\(.*\)}\"$/\1/p" "$HERE/$2"; }
fresh() { [[ -x "$DEST/$1$EXT" || -f "$DEST/$1$EXT" ]] && grep -qF "$2" "$DEST/$1.version" 2>/dev/null; }

fresh yt-dlp "$(pinned YTDLP_VERSION fetch-ytdlp.sh)" || bash "$HERE/fetch-ytdlp.sh" "$PLATFORM" "$DEST"
fresh qjs "$(pinned QJS_VERSION fetch-qjs.sh)" || bash "$HERE/fetch-qjs.sh" "$PLATFORM" "$DEST"
fresh cloudflared "$(pinned CLOUDFLARED_VERSION fetch-cloudflared.sh)" || bash "$HERE/fetch-cloudflared.sh" "$PLATFORM" "$DEST"
fresh ffmpeg "$(pinned FFMPEG_BUILD fetch-ffmpeg.sh)" || bash "$HERE/fetch-ffmpeg.sh" "$PLATFORM" "$DEST"

echo "Tools ready in $DEST:"
ls -la "$DEST"

#!/usr/bin/env bash
# Downloads QuickJS-ng (`qjs`, MIT) from https://github.com/quickjs-ng/quickjs/releases
# at a pinned version and verifies it. yt-dlp needs a JavaScript runtime to solve
# YouTube's player challenges (without one YouTube answers "The page needs to be
# reloaded"); qjs is a single static file of about 2.5 MB.
#
#   scripts/fetch-qjs.sh [platform] [directory]
#     platform:    linux-x64 | linux-arm64 | windows-x64 | macos-x64 | macos-arm64
#     directory:   default release/bin/<platform>
#
#   QJS_VERSION=v0.17.0 scripts/fetch-qjs.sh   another version
#
# The published checksum is read from the assets' `digest` field in the GitHub API
# (GITHUB_TOKEN, if set, avoids the anonymous rate limit). The license comes from
# the same tag and is pinned too. See scripts/lib/fetch-common.sh. The hub finds
# qjs next to the bundled yt-dlp (or in bin/), or via REKORD_YTDLP_JS_BIN.
set -euo pipefail
source "$(dirname "$0")/lib/fetch-common.sh"

QJS_VERSION="${QJS_VERSION:-v0.17.0}"
PLATFORM="${1:-$(rk_default_platform)}"
DEST="${2:-$RK_FETCH_ROOT/release/bin/$PLATFORM}"

case "$PLATFORM" in
  linux-x64) ASSET=qjs-linux-x86_64; OUT=qjs ;;
  linux-arm64) ASSET=qjs-linux-aarch64; OUT=qjs ;;
  windows-x64) ASSET=qjs-windows-x86_64.exe; OUT=qjs.exe ;;
  macos-x64) ASSET=qjs-darwin-x86_64; OUT=qjs ;;
  macos-arm64) ASSET=qjs-darwin-arm64; OUT=qjs ;;
  *) rk_fetch_die "unrecognized platform: $PLATFORM" ;;
esac

rk_need curl awk
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "==> QuickJS-ng $QJS_VERSION ($ASSET) → $DEST/$OUT"
rk_download "https://github.com/quickjs-ng/quickjs/releases/download/$QJS_VERSION/$ASSET" "$TMP/$ASSET"

UPSTREAM=""
API="https://api.github.com/repos/quickjs-ng/quickjs/releases/tags/$QJS_VERSION"
AUTH=()
[[ -n "${GITHUB_TOKEN:-}" ]] && AUTH=(-H "Authorization: Bearer $GITHUB_TOKEN")
if curl -fsSL --retry 3 -H "Accept: application/vnd.github+json" -H "User-Agent: rekord-pack" \
  ${AUTH[@]+"${AUTH[@]}"} -o "$TMP/release.json" "$API"; then
  UPSTREAM="$(rk_json_asset_digest "$TMP/release.json" "$ASSET")"
fi
rk_verify quickjs "$QJS_VERSION" "$ASSET" "$TMP/$ASSET" "$UPSTREAM"

# The license is not a release asset: it is taken from the tag and must match the
# hash pinned in third-party.sha256 (no published checksum to fall back on).
rk_download "https://raw.githubusercontent.com/quickjs-ng/quickjs/$QJS_VERSION/LICENSE" "$TMP/LICENSE"
rk_verify quickjs "$QJS_VERSION" LICENSE "$TMP/LICENSE" ""

mkdir -p "$DEST"
install -m 0755 "$TMP/$ASSET" "$DEST/$OUT"
install -m 0644 "$TMP/LICENSE" "$DEST/qjs-LICENSE.txt"
echo "$QJS_VERSION (QuickJS-ng, MIT)" > "$DEST/qjs.version"
echo "  done: $DEST/$OUT"

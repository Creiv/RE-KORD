#!/usr/bin/env bash
# RE-KORD macOS packages in release/macos/ (runs only on a Mac):
#
#   rekord-server-<v>-macos-<arch>.tar.gz   hub: executable, run.sh, client-ui, admin-ui
#   RE-KORD_<v>_<arch>.dmg                  desktop client (Tauri)
#   SHA256SUMS
#
#   scripts/pack-macos.sh                 everything
#   scripts/pack-macos.sh --no-client     the hub only
#   scripts/pack-macos.sh --with-tools    adds verified yt-dlp and cloudflared in bin/
#   scripts/pack-macos.sh --server-flavor also the "Server" client (embedded hub)
#   scripts/pack-macos.sh --universal     universal binaries (arm64 + x86_64)
#
# Signing and notarization: Tauri does them on its own if it finds APPLE_SIGNING_IDENTITY,
# APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID in the environment. Without them, the .dmg is
# unsigned and Gatekeeper asks for confirmation on first launch (right-click → Open).
set -euo pipefail
[[ "$(uname -s)" == Darwin ]] || { echo "pack-macos.sh runs only on macOS." >&2; exit 1; }
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CLIENT=1
TOOLS=0
SERVER_FLAVOR=0
UNIVERSAL=0
while (( $# )); do
  case "$1" in
    --no-client) CLIENT=0 ;;
    --with-tools) TOOLS=1 ;;
    --server-flavor) SERVER_FLAVOR=1 ;;
    --universal) UNIVERSAL=1 ;;
    -h|--help) awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "$0"; exit 0 ;;
    *) echo "Unrecognized option: $1" >&2; exit 2 ;;
  esac
  shift
done

VERSION="$(node -p 'require("./package.json").version')"
case "$(uname -m)" in
  arm64) ARCH=arm64 ;;
  *) ARCH=x64 ;;
esac
(( UNIVERSAL )) && ARCH=universal
OUT="$ROOT/release/macos"
TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/target}"
STAGE_NAME="rekord-server-$VERSION-macos-$ARCH"
STAGE="$OUT/$STAGE_NAME"
LOG="$OUT/build.log"
mkdir -p "$OUT"
: > "$LOG"
MARKER="$OUT/.pack-started"
touch "$MARKER"
exec > >(tee -a "$LOG") 2>&1
echo "RE-KORD $VERSION — macOS packages ($ARCH) — $(date)"

step() { echo; echo "==> $*"; }

step "Version check"
node scripts/version.mjs check "$VERSION"

step "JS dependencies (frozen lockfile)"
pnpm install --frozen-lockfile

step "UI build (client + admin panel)"
pnpm build:ui

step "Hub build (release)"
if (( UNIVERSAL )); then
  rustup target add aarch64-apple-darwin x86_64-apple-darwin
  cargo build -p rekord-server --release --locked --target aarch64-apple-darwin
  cargo build -p rekord-server --release --locked --target x86_64-apple-darwin
  mkdir -p "$TARGET_DIR/universal-apple-darwin/release"
  lipo -create -output "$TARGET_DIR/universal-apple-darwin/release/rekord-server" \
    "$TARGET_DIR/aarch64-apple-darwin/release/rekord-server" \
    "$TARGET_DIR/x86_64-apple-darwin/release/rekord-server"
  SERVER_BIN="$TARGET_DIR/universal-apple-darwin/release/rekord-server"
else
  cargo build -p rekord-server --release --locked
  SERVER_BIN="$TARGET_DIR/release/rekord-server"
fi

step "Hub package: $STAGE_NAME"
rm -rf "$STAGE"
mkdir -p "$STAGE"
install -m 0755 "$SERVER_BIN" "$STAGE/rekord-server"
cp -a apps/client-ui/dist "$STAGE/client-ui"
cp -a apps/server-ui/dist "$STAGE/admin-ui"
cp -f modules.manifest.toml "$STAGE/modules.manifest.toml"
echo "$VERSION" > "$STAGE/VERSION"
cat > "$STAGE/run.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
if [[ -z "${YTDLP_PATH:-}" && -x "$DIR/bin/yt-dlp" ]]; then export YTDLP_PATH="$DIR/bin/yt-dlp"; fi
if [[ -z "${REKORD_YTDLP_JS_BIN:-}" && -x "$DIR/bin/qjs" ]]; then export REKORD_YTDLP_JS_BIN="$DIR/bin/qjs"; fi
if [[ -z "${REKORD_CLOUDFLARED_BIN:-}" && -x "$DIR/bin/cloudflared" ]]; then
  export REKORD_CLOUDFLARED_BIN="$DIR/bin/cloudflared"
fi
exec "$DIR/rekord-server" --client-ui "$DIR/client-ui" --admin-ui "$DIR/admin-ui" "$@"
EOF
chmod +x "$STAGE/run.sh"

if (( TOOLS )); then
  step "yt-dlp, QuickJS-ng and cloudflared (verified download)"
  # yt-dlp_macos is already universal; cloudflared isn't: take the one for this machine.
  plat="macos-$([[ "$(uname -m)" == arm64 ]] && echo arm64 || echo x64)"
  bash scripts/fetch-ytdlp.sh "$plat" "$STAGE/bin"
  bash scripts/fetch-qjs.sh "$plat" "$STAGE/bin"
  bash scripts/fetch-cloudflared.sh "$plat" "$STAGE/bin"
fi

tar -C "$OUT" -czf "$OUT/$STAGE_NAME.tar.gz" "$STAGE_NAME"
rm -rf "$STAGE"
echo "  $OUT/$STAGE_NAME.tar.gz"

bundle_client() {
  local label="$1"; shift
  step "Desktop client $label (Tauri, dmg)"
  local args=(build --bundles dmg)
  local bundle="$TARGET_DIR/release/bundle/dmg"
  if (( UNIVERSAL )); then
    args+=(--target universal-apple-darwin)
    bundle="$TARGET_DIR/universal-apple-darwin/release/bundle/dmg"
  fi
  pnpm --filter @rekord/client-shell exec tauri "${args[@]}" "$@"
  local found=0 f
  for f in "$bundle"/*.dmg; do
    [[ -f "$f" && "$f" -nt "$MARKER" ]] || continue
    cp -f "$f" "$OUT/"
    echo "  $OUT/$(basename "$f")"
    found=1
  done
  (( found )) || { echo "No .dmg produced in $bundle" >&2; exit 1; }
}

if (( CLIENT )); then
  bundle_client "RE-KORD"
  (( SERVER_FLAVOR )) && bundle_client "RE-KORD Server" --features hub --config src-tauri/tauri.hub.conf.json
fi

step "Checksums"
(
  cd "$OUT"
  shasum -a 256 ./*.tar.gz ./*.dmg 2>/dev/null | sed 's# \./# #' > SHA256SUMS || true
  cat SHA256SUMS
)
rm -f "$MARKER"
echo
echo "Done: $OUT (log: $LOG)"

#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
OUT="$ROOT/release/linux"
mkdir -p "$OUT/server" "$OUT/client"

echo "==> Build UI"
pnpm install --frozen-lockfile=false
pnpm build:ui

echo "==> Build server (release)"
cargo build -p rekord-server --release
TARGET_DIR="${CARGO_TARGET_DIR:-target}"
cp -f "$TARGET_DIR/release/rekord-server" "$OUT/server/"
rm -rf "$OUT/server/admin-ui"
cp -a apps/server-ui/dist "$OUT/server/admin-ui"
cp -f modules.manifest.toml "$OUT/server/"
cat > "$OUT/server/run.sh" <<'EOF'
#!/usr/bin/env bash
DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$DIR/rekord-server" --admin-ui "$DIR/admin-ui" --modules-manifest "$DIR/modules.manifest.toml" "$@"
EOF
chmod +x "$OUT/server/run.sh"

echo "==> Build Tauri client (if toolchain available)"
if pnpm --filter @rekord/client-shell exec tauri build --bundles deb,appimage 2>/tmp/rekord-tauri-build.log; then
  find apps/client-shell/src-tauri/target/release/bundle -type f \( -name '*.AppImage' -o -name '*.deb' \) -exec cp -f {} "$OUT/client/" \; || true
  cp -f apps/client-shell/src-tauri/target/release/rekord-client "$OUT/client/" 2>/dev/null || true
else
  echo "Tauri bundle skipped (see /tmp/rekord-tauri-build.log). Copying client-ui dist as portable web client."
  rm -rf "$OUT/client/web"
  cp -a apps/client-ui/dist "$OUT/client/web"
  cat > "$OUT/client/README.txt" <<'EOF'
Client UI static build. Serve with any static server and point Server URL to the RE-KORD API,
or open via Tauri once desktop deps are installed.
EOF
fi

echo "Done: $OUT"
ls -laR "$OUT"

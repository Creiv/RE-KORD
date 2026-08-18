#!/usr/bin/env bash
# Stages Windows pack assets. Set FORCE_WINDOWS_CROSS=1 to attempt cargo --target windows.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
OUT="$ROOT/release/windows"
mkdir -p "$OUT/server" "$OUT/client"

echo "==> Build UI"
pnpm install --frozen-lockfile=false
pnpm build:ui

TARGET_DIR="${CARGO_TARGET_DIR:-target}"

if [[ "${FORCE_WINDOWS_CROSS:-}" == "1" ]]; then
  if rustup target list --installed 2>/dev/null | grep -qE 'x86_64-pc-windows-(gnu|msvc)'; then
    TARGET=$(rustup target list --installed | grep -E 'x86_64-pc-windows-(gnu|msvc)' | head -n1)
    echo "==> Cross-building server for $TARGET"
    cargo build -p rekord-server --release --target "$TARGET"
    cp -f "$TARGET_DIR/$TARGET/release/rekord-server.exe" "$OUT/server/" 2>/dev/null \
      || cp -f "$TARGET_DIR/$TARGET/release/rekord-server" "$OUT/server/"
  else
    echo "FORCE_WINDOWS_CROSS=1 but no Windows Rust target installed."
  fi
else
  echo "==> Skipping Windows native cross-build (set FORCE_WINDOWS_CROSS=1 to enable)."
fi

rm -rf "$OUT/server/client-ui" "$OUT/server/admin-ui"
cp -a apps/client-ui/dist "$OUT/server/client-ui"
cp -a apps/server-ui/dist "$OUT/server/admin-ui"
cp -f modules.manifest.toml "$OUT/server/"
rm -rf "$OUT/client/web"
cp -a apps/client-ui/dist "$OUT/client/web"

cat > "$OUT/README.txt" <<'EOF'
RE-KORD Windows pack (staging)

Server
  On Windows with Rust:
    cargo build -p rekord-server --release
    rekord-server.exe --client-ui client-ui --admin-ui admin-ui

  Default bind is 0.0.0.0:7420 (LAN). Override with REKORD_BIND=127.0.0.1:7420.

  Included here:
    server/client-ui/   full app served at http://<host>:7420/
    server/admin-ui/    hub panel served at http://<host>:7420/admin
    server/modules.manifest.toml

Client
  client/web/   same UI as portable static files (optional; hub already serves it)

  Native shell on Windows:
    pnpm --filter @rekord/client-shell tauri build
EOF

echo "Done: $OUT"
ls -laR "$OUT"

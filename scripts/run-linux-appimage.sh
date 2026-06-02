#!/usr/bin/env sh
# Avvio AppImage su Ubuntu/Debian senza libfuse2 (es. installazione pulita 24.04+).
# Uso: ./scripts/run-linux-appimage.sh [percorso/RE-KORD-Server-*.AppImage]
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMG="${1:-}"
if [ -z "$IMG" ]; then
  IMG="$(ls -1 "$ROOT"/release/RE-KORD-Server-*-linux-*.AppImage 2>/dev/null | head -1 || true)"
fi
if [ -z "$IMG" ] || [ ! -f "$IMG" ]; then
  echo "AppImage non trovata. Passa il path o esegui npm run pack:linux:server prima." >&2
  exit 1
fi
chmod +x "$IMG"
export APPIMAGE_EXTRACT_AND_RUN=1
exec "$IMG" "$@"

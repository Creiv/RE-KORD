#!/usr/bin/env bash
# Prepares RE-KORD Android client build inputs (non-interactive).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "RE-KORD Android client setup"
echo "See docs/ANDROID.md"

pnpm install
pnpm --filter @rekord/client-ui build

if [[ -d apps/client-shell/src-tauri/gen/android ]]; then
  echo "Android project already present."
else
  echo "Android native project not generated yet."
  echo "On a machine with Android SDK/NDK:"
  echo "  cd apps/client-shell && pnpm exec tauri android init"
fi

echo "Done."

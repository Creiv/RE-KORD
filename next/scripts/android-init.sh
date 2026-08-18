#!/usr/bin/env bash
# Prepara la build del client Android. Con il progetto nativo gia' versionato
# (apps/client-shell/src-tauri/gen/android) qui non c'e' quasi niente da generare:
# serve per controllare la toolchain e per ricreare il progetto se lo si e' cancellato.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
source "$ROOT/scripts/lib/android-env.sh"

ANDROID_DIR="apps/client-shell/src-tauri/gen/android"

echo "RE-KORD Android client setup"
rk_android_preflight aarch64-linux-android

echo "==> Dipendenze e UI"
pnpm install
pnpm --filter @rekord/client-ui build

if [[ -d "$ANDROID_DIR" ]]; then
  echo "==> Progetto nativo: gia' presente in $ANDROID_DIR (versionato, non lo tocco)"
else
  # `tauri android init` scrive il progetto da zero: qui ci arriva solo chi l'ha
  # cancellato, e va confrontato con git perche' la CLI riscrive anche le nostre
  # modifiche (traffico in chiaro verso l'hub, firma di release, servizio audio).
  echo "==> Progetto nativo assente: lo rigenero con tauri android init"
  pnpm --filter @rekord/client-shell exec tauri android init
  echo
  echo "Ora controlla le differenze: git diff -- $ANDROID_DIR"
  echo "Le modifiche RE-KORD al progetto nativo sono descritte in $RK_ANDROID_DOCS"
fi

echo
echo "Fatto. APK: ./scripts/android-build.sh --install"

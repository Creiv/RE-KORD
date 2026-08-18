#!/usr/bin/env bash
# Costruisce l'APK del client RE-KORD per Android.
#
#   ./scripts/android-build.sh                 APK debug universale, firmato con la
#                                              chiave di debug: si installa e basta
#   ./scripts/android-build.sh --release        APK di release (serve keystore.properties)
#   ./scripts/android-build.sh --split          un APK per architettura, piu' leggero
#   ./scripts/android-build.sh --aab            bundle per il Play Store
#   ./scripts/android-build.sh --install        manda l'APK al telefono collegato
#   ./scripts/android-build.sh --targets aarch64,x86_64
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
source "$ROOT/scripts/lib/android-env.sh"

PROFILE=debug
FORMAT=--apk
SPLIT=0
INSTALL=0
# Solo arm64 per difetto: e' l'architettura di ogni telefono in circolazione, e ogni
# architettura in piu' e' una compilazione Rust in piu'.
TARGETS=aarch64

while (( $# )); do
  case "$1" in
    --debug) PROFILE=debug ;;
    --release) PROFILE=release ;;
    --apk) FORMAT=--apk ;;
    --aab) FORMAT=--aab ;;
    --split) SPLIT=1 ;;
    --install) INSTALL=1 ;;
    --targets) shift; TARGETS="${1:-}" ;;
    --targets=*) TARGETS="${1#*=}" ;;
    # L'aiuto e' il commento in testa al file: si stampa finche' le righe iniziano
    # con #, cosi' non va risincronizzato a mano quando il blocco cresce.
    -h|--help) awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "$0"; exit 0 ;;
    *) rk_die "Opzione non riconosciuta: $1 (--help per l'elenco)" ;;
  esac
  shift
done

IFS=, read -r -a TARGET_LIST <<<"$TARGETS"
RUST_TARGETS=()
for t in "${TARGET_LIST[@]}"; do
  case "$t" in
    aarch64|arm64) RUST_TARGETS+=(aarch64-linux-android) ;;
    armv7|arm) RUST_TARGETS+=(armv7-linux-androideabi) ;;
    i686|x86) RUST_TARGETS+=(i686-linux-android) ;;
    x86_64) RUST_TARGETS+=(x86_64-linux-android) ;;
    *) rk_die "Architettura non riconosciuta: $t (aarch64, armv7, i686, x86_64)" ;;
  esac
done

rk_android_preflight "${RUST_TARGETS[@]}"

ANDROID_DIR="apps/client-shell/src-tauri/gen/android"
[[ -d "$ANDROID_DIR" ]] || rk_die "Manca $ANDROID_DIR: lancia prima ./scripts/android-init.sh"

KEYSTORE="$ANDROID_DIR/keystore.properties"
if [[ "$PROFILE" == release && ! -f "$KEYSTORE" ]]; then
  cat >&2 <<EOF

Attenzione: manca $KEYSTORE, l'APK di release uscira' NON firmato e Android
rifiutera' di installarlo. Per creare una chiave tua (una volta sola, e conservala:
senza la stessa chiave gli aggiornamenti non si installano sopra):

  keytool -genkey -v -keystore $ANDROID_DIR/rekord.jks \\
    -keyalg RSA -keysize 2048 -validity 10000 -alias rekord

  cat > $KEYSTORE <<'PROPS'
  storeFile=rekord.jks
  storePassword=...
  keyAlias=rekord
  keyPassword=...
  PROPS

Chiave e password restano fuori da git.

EOF
fi

echo "==> Build client Android ($PROFILE, ${FORMAT#--}, ${TARGETS})"
MARKER="$(mktemp)"
trap 'rm -f "$MARKER"' EXIT

# La CLI di Tauri conosce solo --debug: la release e' il suo comportamento normale.
ARGS=(android build "$FORMAT")
[[ "$PROFILE" == debug ]] && ARGS+=(--debug)
for t in "${TARGET_LIST[@]}"; do
  ARGS+=(--target "$t")
done
(( SPLIT )) && ARGS+=(--split-per-abi)

pnpm --filter @rekord/client-shell exec tauri "${ARGS[@]}"

echo
echo "==> Pacchetti prodotti"
mapfile -t ARTIFACTS < <(find "$ANDROID_DIR/app/build/outputs" \
  -type f \( -name '*.apk' -o -name '*.aab' \) -newer "$MARKER" | sort)
(( ${#ARTIFACTS[@]} )) || rk_die "Nessun pacchetto trovato sotto $ANDROID_DIR/app/build/outputs"
for f in "${ARTIFACTS[@]}"; do
  echo "  $(du -h "$f" | cut -f1)  $f"
done

if (( INSTALL )); then
  APK="$(printf '%s\n' "${ARTIFACTS[@]}" | grep -m1 '\.apk$' || true)"
  [[ -n "$APK" ]] || rk_die "--install vuole un APK, non un bundle .aab"
  command -v adb >/dev/null 2>&1 || rk_die "adb non trovato: sdkmanager platform-tools"
  echo "==> Installo su dispositivo"
  adb install -r "$APK"
fi

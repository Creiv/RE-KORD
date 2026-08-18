#!/usr/bin/env bash
# Controlli comuni ai comandi Android (init, build). Da usare con `source`.
# Ogni messaggio dice cosa manca e cosa installare: la catena Android e' lunga
# (SDK, NDK, JDK, target Rust) e un errore di Gradle a meta' build non lo spiega.

RK_ANDROID_DOCS="next/docs/ANDROID.md"

rk_die() {
  echo "ERRORE: $*" >&2
  echo "Vedi $RK_ANDROID_DOCS" >&2
  exit 1
}

rk_android_sdk() {
  local candidates=(
    "${ANDROID_HOME:-}"
    "${ANDROID_SDK_ROOT:-}"
    "$HOME/Android/Sdk"
    "$HOME/Library/Android/sdk"
    "/usr/lib/android-sdk"
  )
  local dir
  for dir in "${candidates[@]}"; do
    if [[ -n "$dir" && -d "$dir/platforms" ]]; then
      export ANDROID_HOME="$dir"
      export ANDROID_SDK_ROOT="$dir"
      echo "SDK:  $dir"
      return 0
    fi
  done
  rk_die "Android SDK non trovato. Installa i command line tools e esporta ANDROID_HOME."
}

rk_android_ndk() {
  if [[ -n "${NDK_HOME:-}" && -d "$NDK_HOME" ]]; then
    echo "NDK:  $NDK_HOME (da NDK_HOME)"
    return 0
  fi
  # Piu' versioni installate: si prende la piu' alta, con l'ordinamento per numero
  # (con quello alfabetico la 9 batterebbe la 28).
  local newest
  newest="$(ls -1 "$ANDROID_HOME/ndk" 2>/dev/null | sort -V | tail -1 || true)"
  if [[ -n "$newest" ]]; then
    export NDK_HOME="$ANDROID_HOME/ndk/$newest"
    echo "NDK:  $NDK_HOME"
    return 0
  fi
  if [[ -d "$ANDROID_HOME/ndk-bundle" ]]; then
    export NDK_HOME="$ANDROID_HOME/ndk-bundle"
    echo "NDK:  $NDK_HOME"
    return 0
  fi
  rk_die "NDK non trovato. Installalo con: sdkmanager 'ndk;28.2.13676358'"
}

rk_android_jdk() {
  if [[ -z "${JAVA_HOME:-}" ]]; then
    local dir
    for dir in /usr/lib/jvm/java-21-openjdk-* /usr/lib/jvm/java-17-openjdk-*; do
      if [[ -x "$dir/bin/javac" ]]; then
        export JAVA_HOME="$dir"
        break
      fi
    done
  fi
  local javac="${JAVA_HOME:+$JAVA_HOME/bin/}javac"
  command -v "$javac" >/dev/null 2>&1 || rk_die "JDK non trovato (serve 17 o superiore). Su Ubuntu: apt install openjdk-17-jdk"
  local major
  major="$("$javac" -version 2>&1 | sed -E 's/^javac ([0-9]+).*/\1/')"
  [[ "$major" =~ ^[0-9]+$ ]] || rk_die "Versione JDK illeggibile: $("$javac" -version 2>&1)"
  (( major >= 17 )) || rk_die "JDK $major troppo vecchio: Gradle 8 e AGP chiedono almeno il 17."
  echo "JDK:  ${JAVA_HOME:-di sistema} (javac $major)"
}

# I target Rust servono per la libreria nativa dentro l'APK: senza, cargo fallisce
# a build avviata. Si aggiungono da soli, e' un comando idempotente.
rk_android_rust_targets() {
  command -v rustup >/dev/null 2>&1 || rk_die "rustup non trovato: serve per i target Android di Rust."
  local installed missing=()
  installed="$(rustup target list --installed)"
  local target
  for target in "$@"; do
    grep -qx "$target" <<<"$installed" || missing+=("$target")
  done
  if (( ${#missing[@]} )); then
    echo "==> Aggiungo i target Rust mancanti: ${missing[*]}"
    rustup target add "${missing[@]}"
  fi
}

rk_android_preflight() {
  echo "==> Toolchain Android"
  rk_android_sdk
  rk_android_ndk
  rk_android_jdk
  command -v pnpm >/dev/null 2>&1 || rk_die "pnpm non trovato: corepack enable oppure npm i -g pnpm"
  rk_android_rust_targets "$@"
}

# Build environment for the RE-KORD desktop packages (used by scripts/pack.sh).
#
# Contains everything Tauri needs for Linux (webkit2gtk-4.1 and friends)
# and for the cross-compiled Windows installer (cargo-xwin + LLVM + NSIS), so
# the packager's machine needs none of these packages.
#
# Ubuntu 24.04: a recent WebKitGTK (faster, fewer bugs) and GLib/GStreamer matching
# those of current distributions, so the AppImage doesn't mix its own libraries with
# incompatible system modules. Requires glibc 2.39: Ubuntu 24.04+, Mint 22+,
# Debian 13+, Fedora 40+.
#
# The GStreamer plugins installed here end up in the AppImage (bundleMediaFramework):
# without them, WebKit finds no decoders or audio output and the web process exits on
# the first track. base/good: ogg, opus, vorbis, flac, mp3, wav, webm, audio output; libav: AAC/M4A.
# Only the playback subset is bundled (scripts/pack.sh, GSTREAMER_PLUGINS_DIR).
#
# On first use cargo-xwin downloads Microsoft's CRT and Windows SDK, accepting
# their license: that is the price of producing the .exe installer from Linux.
FROM ubuntu:24.04

ARG NODE_VERSION=22.23.4
ARG PNPM_VERSION=9.15.0
ARG CARGO_XWIN_VERSION=0.23.1

ENV DEBIAN_FRONTEND=noninteractive \
    RUSTUP_HOME=/opt/rustup \
    CARGO_HOME=/opt/cargo \
    PATH=/opt/cargo/bin:/opt/node/bin:/usr/local/bin:/usr/bin:/bin

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential pkg-config curl wget ca-certificates git file xz-utils unzip zip \
      libwebkit2gtk-4.1-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev \
      libdbus-1-dev libxdo-dev patchelf xdg-utils \
      gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-libav \
      gstreamer1.0-pulseaudio gstreamer1.0-alsa \
      nsis clang lld llvm \
 && rm -rf /var/lib/apt/lists/* \
 # cargo-xwin looks for the names without a version suffix.
 && for t in clang-cl llvm-lib lld-link llvm-rc llvm-ar; do \
      src="$(ls /usr/bin/${t}-[0-9]* 2>/dev/null | sort -V | tail -n1)"; \
      [ -n "$src" ] && [ ! -e "/usr/local/bin/$t" ] && ln -s "$src" "/usr/local/bin/$t" || true; \
    done

RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
      | tar -xJ -C /opt && mv "/opt/node-v${NODE_VERSION}-linux-x64" /opt/node \
 && npm install -g "pnpm@${PNPM_VERSION}"

RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable \
 && rustup target add x86_64-pc-windows-msvc \
 && cargo install --locked "cargo-xwin@${CARGO_XWIN_VERSION}" \
 && rm -rf /opt/cargo/registry /opt/cargo/git \
 # The container runs as the user who starts the build (files in release/ owned by
 # them, not root): toolchain readable and writable by anyone.
 && chmod -R a+rwX /opt/rustup /opt/cargo

# Persistent caches mounted by scripts/pack.sh (cargo registry, xwin CRT/SDK,
# tools downloaded by Tauri such as linuxdeploy and the NSIS plugins).
ENV CARGO_HOME=/cache/cargo \
    XWIN_CACHE_DIR=/cache/xwin \
    HOME=/cache/home \
    APPIMAGE_EXTRACT_AND_RUN=1 \
    REKORD_BUILDER=1

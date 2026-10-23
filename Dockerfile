# syntax=docker/dockerfile:1.7
#
# RE-KORD hub in a container.
#
#   docker build -t rekord:5.0.0 .            (from the repository root)
#   docker compose up -d                      (see docker-compose.yml)
#
# Stages: ui (client + admin panel with pnpm) → server (rekord-server in
# release) → tools (yt-dlp, QuickJS-ng and cloudflared downloaded at a pinned
# version and verified with SHA-256, see scripts/fetch-*.sh) → runtime (debian slim with
# ffmpeg, non-root user, /data and /music as volumes).

ARG NODE_VERSION=22
ARG RUST_VERSION=1
ARG DEBIAN_RELEASE=bookworm

# ---------------------------------------------------------------- ui
FROM node:${NODE_VERSION}-${DEBIAN_RELEASE}-slim AS ui
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1
RUN corepack enable
WORKDIR /src
# Manifests first: the dependency layer stays cached as long as the
# lockfile and package.json files don't change.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/client-ui/package.json apps/client-ui/
COPY apps/server-ui/package.json apps/server-ui/
COPY apps/client-shell/package.json apps/client-shell/
COPY packages/ui/package.json packages/ui/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --filter "@rekord/client-ui..." --filter "@rekord/server-ui..."
COPY packages/ui packages/ui
COPY apps/client-ui apps/client-ui
COPY apps/server-ui apps/server-ui
RUN pnpm build:ui

# ---------------------------------------------------------------- server
FROM rust:${RUST_VERSION}-${DEBIAN_RELEASE} AS server
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates crates
COPY apps/server apps/server
# The Tauri shell is a workspace member but is not built here: its manifest
# (and an empty lib) is enough for cargo to read the workspace.
COPY apps/client-shell/src-tauri/Cargo.toml apps/client-shell/src-tauri/Cargo.toml
RUN mkdir -p apps/client-shell/src-tauri/src && : > apps/client-shell/src-tauri/src/lib.rs
# `sharing=locked`: the amd64 and arm64 builds of one buildx run would otherwise
# write the same registry cache at once (`libc .cargo-ok File exists`).
RUN --mount=type=cache,id=cargo-registry,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,id=rekord-target,target=/src/target,sharing=locked \
    cargo build -p rekord-server --release --locked \
 && install -m 0755 target/release/rekord-server /rekord-server

# ---------------------------------------------------------------- tools
FROM node:${NODE_VERSION}-${DEBIAN_RELEASE}-slim AS tools
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY scripts/lib/fetch-common.sh scripts/lib/
COPY scripts/fetch-ytdlp.sh scripts/fetch-qjs.sh scripts/fetch-cloudflared.sh scripts/third-party.sha256 scripts/
ARG TARGETARCH
# Empty = the versions pinned in the scripts.
ARG YTDLP_VERSION=
ARG QJS_VERSION=
ARG CLOUDFLARED_VERSION=
RUN set -eu; \
    case "${TARGETARCH:-amd64}" in arm64) plat=linux-arm64 ;; *) plat=linux-x64 ;; esac; \
    YTDLP_VERSION="${YTDLP_VERSION}" bash scripts/fetch-ytdlp.sh "$plat" /out; \
    QJS_VERSION="${QJS_VERSION}" bash scripts/fetch-qjs.sh "$plat" /out; \
    CLOUDFLARED_VERSION="${CLOUDFLARED_VERSION}" bash scripts/fetch-cloudflared.sh "$plat" /out

# ---------------------------------------------------------------- runtime
FROM debian:${DEBIAN_RELEASE}-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg tini \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --user-group --home-dir /data --shell /usr/sbin/nologin rekord \
 && mkdir -p /data /music /app/bin \
 && chown rekord:rekord /data /music

COPY --from=server /rekord-server /app/rekord-server
COPY --from=ui /src/apps/client-ui/dist /app/client-ui
COPY --from=ui /src/apps/server-ui/dist /app/admin-ui
COPY --from=tools /out/ /app/bin/

# Same variables as the command line: rekord-server --help.
ENV REKORD_BIND=0.0.0.0:7420 \
    REKORD_DATA_DIR=/data \
    REKORD_MUSIC_ROOT=/music \
    REKORD_CLIENT_UI=/app/client-ui \
    REKORD_ADMIN_UI=/app/admin-ui \
    YTDLP_PATH=/app/bin/yt-dlp \
    REKORD_YTDLP_JS_BIN=/app/bin/qjs \
    REKORD_CLOUDFLARED_BIN=/app/bin/cloudflared \
    RUST_LOG=info,tower_http=info

USER rekord
WORKDIR /data
VOLUME ["/data", "/music"]
EXPOSE 7420

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["sh", "-c", "curl -fsS \"http://127.0.0.1:${REKORD_BIND##*:}/api/v1/health\" >/dev/null || exit 1"]

# tini forwards SIGTERM to the hub (clean DB shutdown) and reaps the child
# processes (ffmpeg, yt-dlp, cloudflared).
ENTRYPOINT ["/usr/bin/tini", "--", "/app/rekord-server"]

#!/bin/sh
set -e

CONFIG_DIR="${REKORD_USER_CONFIG_DIR:-/config}"
MUSIC_DIR="${REKORD_DOCKER_MUSIC_DIR:-/music}"
CONFIG_FILE="${CONFIG_DIR}/music-root.config.json"

mkdir -p "${CONFIG_DIR}" "${MUSIC_DIR}"

if [ ! -f "${CONFIG_FILE}" ]; then
  printf '%s\n' \
    '{' \
    "  \"musicRoot\": \"${MUSIC_DIR}\"," \
    '  "schemaVersion": 3' \
    '}' > "${CONFIG_FILE}"
  echo "[rekord-docker] bootstrap config: ${CONFIG_FILE} -> ${MUSIC_DIR}"
fi

exec node server/index.mjs

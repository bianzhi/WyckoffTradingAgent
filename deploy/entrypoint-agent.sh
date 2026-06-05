#!/bin/sh
set -e

# Fix ownership of volume mounts (Docker named volumes may be owned by root
# if the container was previously run as root).  Runs as root before
# dropping to the wyckoff user via gosu.

DATADIR="${WYCKOFF_DATA_DIR:-/app/data}"
LOGDIR="${WYCKOFF_LOG_DIR:-/app/logs}"

if [ "$(id -u)" = "0" ]; then
    chown -R wyckoff:wyckoff "$DATADIR" "$LOGDIR" 2>/dev/null || true
    exec gosu wyckoff "$@"
fi

exec "$@"

#!/bin/sh
# Volumes montados pelo host costumam chegar como root: acerta o dono e roda
# como o usuário `node`. O Claude Code recusa "Liberar tudo" rodando como root.
set -e
if [ "$(id -u)" = "0" ]; then
  chown node:node /data /workspace 2>/dev/null || true
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"

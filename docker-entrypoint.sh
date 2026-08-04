#!/bin/sh
set -eu

mkdir -p /root/.codex

# Seed the container-owned Codex state once. Keeping the live auth file in the
# named volume lets Codex refresh tokens without modifying the host's desktop
# credential or sharing its session database.
if [ ! -s /root/.codex/auth.json ] && [ -r /run/secrets/codex-auth.json ]; then
  cp /run/secrets/codex-auth.json /root/.codex/auth.json
  chmod 600 /root/.codex/auth.json
fi

exec "$@"

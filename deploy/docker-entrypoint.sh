#!/bin/sh
set -eu

# A newly-created named volume is owned by root. Fix only the volume root, then
# run the application as the unprivileged node user.
chown node:node /home/node/.codex

exec runuser -u node -- "$@"

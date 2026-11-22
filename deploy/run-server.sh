#!/bin/bash
# Started by launchd (macOS) or systemd (Linux). Reads settings from a 0600 env file so no secret sits in the service definition.
set -euo pipefail
ENV_FILE="${OPNAV_SERVER_ENV:-$HOME/.config/opportunity-nav/server.env}"
cd "$(dirname "$0")/.."
exec node --env-file="$ENV_FILE" apps/server/src/main.ts

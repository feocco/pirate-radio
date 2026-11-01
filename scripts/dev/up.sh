#!/usr/bin/env bash
# One-command boot of the full dev stack (`npm run dev`): Postgres + seed via
# start.sh, the local OIDC issuer, then `serve` in the foreground. Ctrl-C stops
# what this script started. Cloud agents normally get the same stack from
# .cursor/environment.json (`start` + `terminals`); use this when those
# terminals are not running, or set SERVICE_PORT / LOCAL_OIDC_PORT to boot a
# second stack beside them.
set -euo pipefail
cd "$(dirname "$0")/../.."
# shellcheck source=scripts/dev/env.sh
source scripts/dev/env.sh

if curl -s -o /dev/null -m 2 "http://${SERVICE_HOST}:${SERVICE_PORT}/health"; then
  echo "[up] serve already answers on ${SERVICE_HOST}:${SERVICE_PORT}. Open ${PIRATE_RADIO_PUBLIC_URL}, or set SERVICE_PORT and LOCAL_OIDC_PORT to boot a second stack." >&2
  exit 1
fi

# start.sh and serve.sh run whatever dist/ holds, so rebuild to serve the
# current source rather than a stale build.
npm run build
bash scripts/dev/start.sh

oidc_pid=""
cleanup() {
  if [ -n "$oidc_pid" ]; then kill "$oidc_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT

if curl -sk -o /dev/null -m 2 "$PIRATE_RADIO_OIDC_ISSUER/.well-known/openid-configuration"; then
  echo "[up] reusing local OIDC issuer at $PIRATE_RADIO_OIDC_ISSUER"
else
  node scripts/dev/local-oidc.mjs &
  oidc_pid=$!
fi

echo "[up] reader: ${PIRATE_RADIO_PUBLIC_URL} (sign-in auto-approves ${LOCAL_OIDC_USERNAME:-demo.reader})"
bash scripts/dev/serve.sh

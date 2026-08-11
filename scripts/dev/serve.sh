#!/usr/bin/env bash
# Launches `serve` for the local dev stack (runs as a `terminal`).
# Waits for the local OIDC issuer, then selects feeds: real public feeds when
# they are reachable (egress allowlist), falling back to the local feed so the
# startup RSS poll cannot crash `serve` on a blocked host.
set -uo pipefail
cd "$(dirname "$0")/../.."
# shellcheck source=scripts/dev/env.sh
source scripts/dev/env.sh

echo "[serve] waiting for local OIDC issuer at $PIRATE_RADIO_OIDC_ISSUER ..."
for _ in $(seq 1 60); do
  curl -sk -o /dev/null "$PIRATE_RADIO_OIDC_ISSUER/.well-known/openid-configuration" && break
  sleep 1
done

# Build the feed list from whichever default feeds are actually reachable.
reachable=()
if curl -s -o /dev/null -m 8 https://piratewires.substack.com/feed.xml; then
  reachable+=('{"id":"pirate-wires","name":"Pirate Wires","type":"pirate-wires","url":"https://piratewires.substack.com/feed.xml"}')
fi
if curl -s -o /dev/null -m 8 https://www.hyperdimensional.co/feed; then
  reachable+=('{"id":"hyperdimensional","name":"Hyperdimensional","type":"substack","url":"https://www.hyperdimensional.co/feed"}')
fi

if [ "${#reachable[@]}" -gt 0 ]; then
  joined=$(IFS=,; echo "${reachable[*]}")
  export PIRATE_RADIO_FEEDS="[$joined]"
  unset PIRATE_RADIO_FEED_URL
  echo "[serve] using ${#reachable[@]} reachable public feed(s)"
else
  export PIRATE_RADIO_FEED_URL="$PIRATE_RADIO_OIDC_ISSUER/feed.xml"
  echo "[serve] public feeds blocked; using local fallback feed at $PIRATE_RADIO_FEED_URL"
fi

exec node dist/src/cli.js serve

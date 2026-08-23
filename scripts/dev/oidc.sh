#!/usr/bin/env bash
# Launches the dev-only OIDC issuer (runs as a `terminal`).
# The issuer refuses to start unless PIRATE_RADIO_DEV_STACK=1, which only
# env.sh sets, so it must be sourced rather than invoking node directly.
set -uo pipefail
cd "$(dirname "$0")/../.."
# shellcheck source=scripts/dev/env.sh
source scripts/dev/env.sh

exec node scripts/dev/local-oidc.mjs

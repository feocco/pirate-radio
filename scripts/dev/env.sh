#!/usr/bin/env bash
# Shared environment for the local Pirate Radio dev stack (Cursor Cloud / local).
# Sourced by start.sh and serve.sh. Values are overridable from the environment.
#
# NOTE: NODE_TLS_REJECT_UNAUTHORIZED=0 is set ONLY so `serve` trusts the
# self-signed local OIDC issuer (scripts/dev/local-oidc.mjs). Dev-only.

# Opt-in flag that authorizes the dev-only OIDC issuer and seed to run.
export PIRATE_RADIO_DEV_STACK=1

export PIRATE_RADIO_DEV_DIR="${PIRATE_RADIO_DEV_DIR:-/tmp/pirate-radio-dev}"

export DATABASE_URL="${DATABASE_URL:-postgres://pirate_radio:pirate_radio@127.0.0.1:5432/pirate_radio}"

export LOCAL_OIDC_HOST="${LOCAL_OIDC_HOST:-127.0.0.1}"
export LOCAL_OIDC_PORT="${LOCAL_OIDC_PORT:-9443}"
export LOCAL_OIDC_CLIENT_ID="${LOCAL_OIDC_CLIENT_ID:-pirate-radio-local}"

export PIRATE_RADIO_OIDC_ISSUER="${PIRATE_RADIO_OIDC_ISSUER:-https://${LOCAL_OIDC_HOST}:${LOCAL_OIDC_PORT}}"
export PIRATE_RADIO_OIDC_CLIENT_ID="${PIRATE_RADIO_OIDC_CLIENT_ID:-$LOCAL_OIDC_CLIENT_ID}"
export PIRATE_RADIO_OIDC_CLIENT_SECRET="${PIRATE_RADIO_OIDC_CLIENT_SECRET:-local-secret}"

export SERVICE_HOST="${SERVICE_HOST:-127.0.0.1}"
export SERVICE_PORT="${SERVICE_PORT:-8123}"
export PIRATE_RADIO_PUBLIC_URL="${PIRATE_RADIO_PUBLIC_URL:-http://127.0.0.1:${SERVICE_PORT}}"

export PIRATE_RADIO_LIBRARY_DIR="${PIRATE_RADIO_LIBRARY_DIR:-${PWD}/output/library}"
export PIRATE_RADIO_STATE_PATH="${PIRATE_RADIO_STATE_PATH:-${PIRATE_RADIO_LIBRARY_DIR}/state.json}"

export PWR_HEADLESS="${PWR_HEADLESS:-true}"
export NODE_TLS_REJECT_UNAUTHORIZED="0"

#!/usr/bin/env bash
# Build-time setup for the Pirate Radio cloud/dev environment (runs in `install`).
# Must be idempotent: it can run repeatedly on partially prepared disk state.
set -euo pipefail
cd "$(dirname "$0")/../.."

npm ci
npx playwright install chromium

# Local Postgres backs `serve` and the DB integration tests. Installing it here
# bakes the binaries into the environment Build snapshot.
if ! command -v pg_ctlcluster >/dev/null 2>&1; then
  sudo apt-get update -qq
  sudo apt-get install -y -qq postgresql postgresql-contrib
fi

npm run build

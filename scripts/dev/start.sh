#!/usr/bin/env bash
# Per-run startup for the Pirate Radio cloud/dev environment (runs in `start`).
# Brings up Postgres and seeds realistic data. The long-lived OIDC provider and
# `serve` process run as `terminals` (see .cursor/environment.json).
set -uo pipefail
cd "$(dirname "$0")/../.."
# shellcheck source=scripts/dev/env.sh
source scripts/dev/env.sh

mkdir -p "$PIRATE_RADIO_DEV_DIR" "$PIRATE_RADIO_LIBRARY_DIR"

# Self-heal: if the Build's `install` phase has not run yet (no dist, or Postgres
# missing), run it now so the stack works on a first, buildless boot too.
if [ ! -f dist/src/cli.js ] || ! command -v pg_ctlcluster >/dev/null 2>&1; then
  echo "[start] install artifacts missing; running install.sh"
  bash scripts/dev/install.sh || echo "[start] install fallback had issues"
fi

# Start Postgres (cluster binaries come from the Build; data dir resets per run).
sudo pg_ctlcluster 16 main start 2>/dev/null || true
for _ in $(seq 1 30); do
  pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1 && break
  sleep 1
done

# Ensure the app role and database exist (idempotent).
sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='pirate_radio'" | grep -q 1 \
  || sudo -u postgres psql -c "CREATE ROLE pirate_radio LOGIN PASSWORD 'pirate_radio'"
sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='pirate_radio'" | grep -q 1 \
  || sudo -u postgres createdb -O pirate_radio pirate_radio

# Seed realistic data. Best-effort: needs OPENAI_API_KEY (a run-time secret) for
# audio, and reaches public feeds only when they are on the egress allowlist.
if [ -f dist/src/cli.js ]; then
  node scripts/dev/seed.mjs || echo "[start] seed skipped"
else
  echo "[start] dist not built yet; skipping seed"
fi

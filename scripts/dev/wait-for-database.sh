#!/usr/bin/env bash
# Wait until DATABASE_URL accepts connections with the configured app credentials.
# Used by serve.sh so the CLI does not race start.sh role/database creation.
set -euo pipefail

DATABASE_URL="${DATABASE_URL:?DATABASE_URL is required}"
MAX_ATTEMPTS="${WAIT_FOR_DATABASE_MAX_ATTEMPTS:-60}"
SLEEP_SECONDS="${WAIT_FOR_DATABASE_SLEEP_SECONDS:-1}"

safe_target="$(printf '%s' "$DATABASE_URL" | sed -E 's|^postgres(ql)?://[^@]+@|postgres://***@|')"

echo "[wait-for-database] waiting for application database at ${safe_target} ..."

last_error=""
for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
  if err="$(psql "$DATABASE_URL" -c 'SELECT 1' -q -t -o /dev/null 2>&1)"; then
    echo "[wait-for-database] database is ready"
    exit 0
  fi
  last_error="$err"
  sleep "$SLEEP_SECONDS"
done

echo "[wait-for-database] database not ready after ${MAX_ATTEMPTS} attempt(s) (${MAX_ATTEMPTS} x ${SLEEP_SECONDS}s)" >&2
if [ -n "$last_error" ]; then
  echo "[wait-for-database] last error: ${last_error}" >&2
fi
exit 1

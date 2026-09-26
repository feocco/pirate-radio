#!/usr/bin/env bash
# Build-time setup for the Pirate Radio cloud/dev environment (runs in `install`).
# Must be idempotent: it can run repeatedly on partially prepared disk state.
#
# Step order matters. Everything that only needs registry.npmjs.org runs first
# so the Build snapshot has dist/ even when the egress-dependent steps below
# cannot reach their hosts (see docs/cloud-agents.md, "Network Access").
set -euo pipefail
cd "$(dirname "$0")/../.."

npm ci
npm run build

# Playwright fetches Chromium from cdn.playwright.dev, which 307-redirects to
# storage.googleapis.com; both hosts must be on the egress allowlist. The
# browser is only used by `login`/`extract` against browser-scraped sources,
# not by tests, seed, or `serve`, so a failed download degrades rather than
# fails the Build.
if ! npx playwright install chromium; then
  echo "[install] WARNING: Playwright Chromium download failed; browser-based extraction" >&2
  echo "[install] stays unavailable until storage.googleapis.com is on the Network Access allowlist." >&2
fi

# Local Postgres backs `serve` and the DB integration tests. Installing it here
# bakes the binaries into the Build snapshot. The base image is Ubuntu, so apt
# needs archive.ubuntu.com and security.ubuntu.com on the egress allowlist.
if ! command -v pg_ctlcluster >/dev/null 2>&1; then
  if ! (sudo apt-get update -qq && sudo apt-get install -y -qq postgresql postgresql-contrib); then
    echo "[install] ERROR: Postgres apt install failed. If apt reported '403 Forbidden', add" >&2
    echo "[install] archive.ubuntu.com and security.ubuntu.com to the Network Access allowlist." >&2
    exit 1
  fi
fi

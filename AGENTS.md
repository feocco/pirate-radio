# Pirate Radio Agent Notes

This repo owns the public application code for Pirate Radio. Keep private
runtime configuration in `homelab-config`.

## Boundaries

- Commit source, tests, docs, Dockerfile, and generic `.env.example` values.
- Do not commit `.env`, `.playwright-profile/`, `output/`, `dist/`, or
  `node_modules/`.
- Do not put homelab runtime Compose files, real Home Assistant URLs/tokens,
  OpenAI keys, or notification tokens in this public repo.
- Preserve the existing CLI commands: `login`, `extract`, `speak`, `read`,
  `poll`, `serve`, and `simulate`. The additive `migrate-progress` and
  `export-progress` commands own the legacy progress cutover and rollback.

## Verification

Run the narrow checks before publishing changes:

```bash
npm test
npm run build
docker build -t pirate-radio:local .
```

For deployment work, validate the matching private `homelab-config`
registration separately.

## Implementation Notes

- The extractor should keep writing title and story body only.
- RSS monitoring uses `https://piratewires.substack.com/feed.xml`.
- Service mode listens for Home Assistant `mobile_app_notification_action`
  events directly over WebSocket.
- Generated audio listings come from the library manifest, not by reading MP3
  files into memory.
- Never authorize with usernames, emails, forwarded identity headers, or
  submission snapshots. Application identity is `(issuer, subject)`, coarse
  access comes from Authentik group snapshots, and row ownership uses the
  internal application-user id.
- Keep profile editing in Authentik. The repo-local account menu links to the
  central profile and logout must revoke both the Pirate Radio session and the
  active Authentik browser session; cover both behaviors in focused tests.
- `/health`, `/auth/login`, and `/auth/callback` are the only unauthenticated
  routes. Keep MP3 ranges, images, alignment, manifests, docs, and article text
  behind the same opaque application session.
- Durable user/session/progress/submission state belongs in Postgres. MP3,
  story, image, alignment, library-manifest, and RSS operational state remain
  filesystem-owned and must use atomic replacement for JSON writes.
- Set `PWR_HEADLESS=true` for Docker or other headless hosts.
- X Articles must use the official Post lookup API and `X_API_BEARER_TOKEN`;
  do not add an X browser-scraping fallback.
- Preserve optional article authors from extraction/feed metadata into both
  story JSON and `index.json`; omit missing bylines instead of inventing one.
- Keep article deletion admin-only and recoverable: archive generated files and
  the pre-delete manifest under `trash/` before changing `index.json`, and do
  not erase Postgres progress or submission history as part of that action.

## Cursor Cloud specific instructions

The cloud dev stack is defined in `.cursor/environment.json` + `scripts/dev/`
(all dev-only; never used by the homelab runtime):

- `install` (`scripts/dev/install.sh`, runs at Build): `npm ci`, Playwright
  chromium, local Postgres, `npm run build`.
- `start` (`scripts/dev/start.sh`, per run): starts Postgres, ensures the
  `pirate_radio` role/db, and runs `scripts/dev/seed.mjs`.
- `terminals`: `scripts/dev/local-oidc.mjs` (local OIDC issuer) and
  `scripts/dev/serve.sh` (waits for the issuer, picks reachable feeds, runs
  `serve`).

Durable gotchas and clarifications:

- There is no lint script. Static checking is `npm run build` (`tsc`). Full
  verification set is under `## Verification` (`npm test`, `npm run build`,
  `docker build`).
- `npm test` runs offline against mocks/fixtures. The Postgres integration suite
  (`tests/database.integration.test.ts`) is skipped unless
  `PIRATE_RADIO_TEST_DATABASE_URL` points at a reachable Postgres.
- `serve` needs `DATABASE_URL` + OIDC issuer/client/secret and does OIDC
  discovery at startup, so the HTTP server never binds without a reachable
  issuer. openid-client v6 rejects plaintext-HTTP issuers (localhost included),
  so the local dev issuer is HTTPS and `serve` runs with
  `NODE_TLS_REJECT_UNAUTHORIZED=0` (set in `scripts/dev/env.sh`; dev-only).
- The startup RSS poll runs before the interval and uses `Promise.all`, so one
  unreachable feed rejects `serve` startup after the listener bound.
  `scripts/dev/serve.sh` builds `PIRATE_RADIO_FEEDS` from only the reachable
  feeds and falls back to the local issuer's `/feed.xml` when all are blocked.
- Egress is an allowlist, not a full block: `api.openai.com` is reachable, so
  OpenAI TTS only needs the `OPENAI_API_KEY` secret. The public RSS feeds
  (`piratewires.substack.com`, `www.hyperdimensional.co`) must be added to the
  Network Access allowlist, and that change only applies to a freshly booted
  agent VM (not the current session).
- Seeding regenerates per run because user secrets (the `OPENAI_API_KEY` used
  for TTS) are not available during Builds. `scripts/dev/seed.mjs` is
  idempotent (skips slugs already in the manifest), tunable via
  `PIRATE_RADIO_SEED_COUNT` / `PIRATE_RADIO_SEED_MAX_CHARS`, and pulls live
  Substack-type articles when feeds are reachable, else uses bundled samples.
- Session/OIDC cookies are `Secure`. Drive the reader over `http://127.0.0.1`
  (a browser secure context), not a LAN IP, or the session cookie is dropped
  and login appears to loop.

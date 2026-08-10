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

Startup runs `npm ci` and `npx playwright install chromium`. Everything below
is run/verify guidance, not install steps.

- There is no lint script. Static checking is `npm run build` (`tsc`). The full
  verification set is in `## Verification` above (`npm test`, `npm run build`,
  `docker build`).
- `npm test` runs fully offline against mocks/fixtures. The Postgres
  integration suite (`tests/database.integration.test.ts`) is skipped unless
  `PIRATE_RADIO_TEST_DATABASE_URL` points at a reachable Postgres. Postgres is
  not preinstalled; install and start a local cluster (e.g. `apt-get install
  postgresql` then `pg_ctlcluster 16 main start`) only when you need the DB
  suite or `serve`.
- Outbound egress is restricted here: live feeds (piratewires/substack), OpenAI
  TTS, and a real Authentik are unreachable. Full conversions and real Authentik
  login therefore need user-provided secrets plus network allowlisting. For
  offline work, point `PIRATE_RADIO_FEED_URL` at a local RSS file/URL so the
  poll loop succeeds (a local server can reuse `tests/fixtures/pirate-feed.xml`).
- `serve` performs OIDC discovery at startup and fails fast if the issuer is
  unreachable, so the HTTP server never binds without a working issuer.
  openid-client v6 rejects plaintext-HTTP issuers (localhost included): a local
  stand-in issuer must be HTTPS, and a self-signed dev issuer needs
  `NODE_TLS_REJECT_UNAUTHORIZED=0` on the `serve` process.
- The startup RSS poll runs before the poll interval; if a feed fetch throws,
  `serve` startup rejects even though the listener already bound. Keep feeds
  reachable when running `serve` locally.
- Session/OIDC cookies are `Secure`. Drive the reader over `http://127.0.0.1`
  (a browser secure context) rather than a LAN IP, or the session cookie is not
  stored and login appears to loop.

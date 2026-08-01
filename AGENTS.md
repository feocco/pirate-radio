# Pirate Wires Reader Agent Notes

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

Standard commands live in `README.md` (`npm test`, `npm run build`, dev CLI
`npm run cli -- <command>`) and `docs/configuration.md` (env vars). Notes below
are the non-obvious bits for running things in this sandbox. The startup update
script already runs `npm install` and `npx playwright install chromium`.

- Checks: there is no separate lint script. `npm run build` (`tsc`, strict) is
  the typecheck/lint gate. `npm test` (Vitest) is the unit suite.
- Postgres integration test: `tests/database.integration.test.ts` is skipped
  unless `PIRATE_RADIO_TEST_DATABASE_URL` points at a reachable Postgres. Start
  a local cluster (`sudo pg_ctlcluster 16 main start`), create a
  `pirate_radio` role/db, then run `npm test` with that env var set to include
  it. It `TRUNCATE`s app tables on each run.
- Running `serve` has two hard external dependencies: a reachable Postgres
  (`DATABASE_URL`; migrations run on boot) and a reachable OIDC issuer
  (`PIRATE_RADIO_OIDC_ISSUER`; discovery runs on boot and every route except
  `/health`, `/auth/login`, `/auth/callback` needs a session in the
  `pirate-radio-users` group). `OPENAI_API_KEY` is only needed to actually
  generate TTS audio (`speak`/`read`/queue conversions), not to boot `serve`.
- Startup poll gotcha: `serve` `await`s one RSS poll during startup, and
  `fetchArticleFeeds` uses `Promise.all`, so an unreachable feed URL crashes
  boot. In a network-restricted sandbox set `PIRATE_RADIO_FEEDS` to a reachable
  or empty feed (an inline empty-RSS `data:` URL works) instead of the default
  external feeds.
- OIDC in the sandbox: `openid-client` v6 requires an HTTPS issuer (the app does
  not pass `allowInsecureRequests`). To run `serve` without the real Authentik,
  front a local mock provider (e.g. `oauth2-mock-server`) over HTTPS and trust
  its self-signed cert via `NODE_EXTRA_CA_CERTS`. The identity comes from the
  id_token `groups` claim, which must include `pirate-radio-users` (and
  `pirate-radio-admins` for `/admin` and `/simulate/*`).
- Cookies: sessions are set `Secure`. Browsers accept `Secure` cookies over
  `http://127.0.0.1`/`localhost`, so a loopback dev server works in Chrome, but
  `curl` will not send `Secure` cookies over http (pass them via an explicit
  `Cookie:` header when scripting authenticated requests).
- The library is filesystem-owned under `PIRATE_RADIO_LIBRARY_DIR`. You can seed
  a playable item without OpenAI by writing story JSON/text plus an MP3 and
  registering it through `appendLibraryItem` (which computes `audioUrl`/
  `audioBytes` and writes `index.json`).

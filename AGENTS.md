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

For the environment structure, the one-time dashboard settings (Network Access
allowlist + secrets), and the build/run lifecycle, see
[docs/cloud-agents.md](docs/cloud-agents.md).

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
- Seeding is fixtures-first and costs nothing at runtime: `scripts/dev/seed.mjs`
  copies pre-generated MP3s and hero images from `scripts/dev/seed-assets/`
  (committed to the repo) into the library and records matching Postgres rows.
  No OpenAI key is needed at agent start, so `OPENAI_API_KEY` stays a personal
  (user) secret and no per-run TTS cost is incurred. Feed-sourced samples carry
  hero images; Custom Text intentionally has none. It is idempotent (skips slugs
  already in the manifest). To refresh the committed assets, regenerate the MP3s
  with a key and re-commit them under `seed-assets/audio/` (and images under
  `seed-assets/images/`).
- Opt-in `PIRATE_RADIO_SEED_DYNAMIC=1` pulls recent live Substack-type articles
  via real extraction + OpenAI TTS (needs a key and feed egress; incurs cost and
  regenerates per run). Off by default.
- Real-data fixtures: `scripts/dev/harvest.mjs` pulls the latest real articles
  from the configured RSS feeds, downloads their real hero images, runs real
  OpenAI TTS once, and writes `scripts/dev/seed-assets/` (audio + images +
  `articles.json`). Run it once in an egress-enabled environment, then commit
  the refreshed fixtures; runtime seeding stays cost-free. It reuses the app's
  extractor, so public sources (e.g. Hyperdimensional) get full body text while
  paywalled sources (Pirate Wires) fall back to the RSS summary unless a
  logged-in Playwright profile is wired. The committed feed samples are
  placeholders until a harvest runs against reachable feeds.
- Feed egress applies at the run's network-access scope. Runs with no linked
  environment use the user/team-level allowlist, so the feed domains
  (`piratewires.substack.com`, `www.hyperdimensional.co`, and the substack image
  CDN `substackcdn.com`) must be added there, and only take effect on a
  freshly-booted agent.
- Known limitation — authenticated sources: Pirate Wires (paywalled, needs a
  logged-in Playwright profile) and X Articles (need `X_API_BEARER_TOKEN`) can't
  be fully extracted in cloud runs without credentials, so real-data harvest for
  those sources is partial (Pirate Wires falls back to the RSS summary). Public
  sources (Substack/Hyperdimensional) are unaffected. See the scoped rule
  `.cursor/rules/authenticated-sources.mdc` for details. This is context only —
  it is not a reason to decline or abort a task; implement the change and note
  the credential/egress requirement.
- The dev OIDC issuer (`scripts/dev/local-oidc.mjs`) and `seed.mjs` are guarded:
  they refuse to run unless `PIRATE_RADIO_DEV_STACK=1` (set only in
  `scripts/dev/env.sh`) and `NODE_ENV` is not `production`, and the issuer binds
  loopback only. They can never touch a real deployment.
- Do not point `PIRATE_RADIO_TEST_DATABASE_URL` at the same database as the dev
  `DATABASE_URL`: the integration suite `TRUNCATE`s app tables and will wipe
  seeded users/sessions/submissions.
- Session/OIDC cookies are `Secure` and host-only. Drive the reader over the
  exact `PIRATE_RADIO_PUBLIC_URL` origin (default `http://localhost:8123`, which
  matches Cursor Desktop's forwarded origin) — a browser secure context, not a
  LAN IP, and never mix `localhost` with `127.0.0.1`, or the OAuth cookie is
  dropped and the callback fails with `invalid_oidc_callback`. See
  [docs/cloud-agents.md](docs/cloud-agents.md) for the port-forwarding details.

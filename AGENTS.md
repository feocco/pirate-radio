# Pirate Radio Agent Notes

## Authentication for bots

Never build custom auth; if auth is needed, reuse the homelab IdP.

That IdP is Authentik. There is no machine-to-machine auth. The server accepts
no API token, bearer token, API key, or service-account credential, and reads
no environment variable that authenticates callers. The full contract is in
[README.md](README.md#authentication-for-bots). The short version:

- Endpoint: `https://reader.home.feocco.com`, reached from a device on the
  tailnet. `reader.feocco.com` does not exist (NXDOMAIN). The direct macmini
  port is bound to the host's loopback only and is not reachable from the
  tailnet.
- Credential: only the `pirate_radio_session` cookie that the Authentik OIDC
  browser login creates (authorization code + PKCE, `pirate-radio-users`
  group). Writes also need `Origin: https://reader.home.feocco.com`. A bot can
  only reuse a session from a real browser login as an Authentik account. That
  is a user session, not a reviewed bot credential.
- Env contract: none. `XAI_API_KEY`, `X_API_BEARER_TOKEN`,
  `HA_LONG_LIVED_TOKEN`, `HOMELAB_FUNCTIONS_TOKEN`, and `CURSOR_API_KEY` are
  outbound credentials, not caller auth. `PIRATE_RADIO_SERVICE_TOKEN` and
  similar names are unsupported until a reviewed design lands. No code reads
  them.
- Do not add bearer, API-key, or service-token auth, or document it as
  available, without a reviewed design. The bot-auth test in
  `tests/qa/reader.spec.ts` fails if the server starts accepting a bearer
  token. Change it only together with that reviewed design.

## Work policy (Joe, authoritative)

This policy is Joe's and overrides conflicting skill or tool defaults,
including pstack defaults.

- All Pirate Radio work runs through the Pirate Radio Cursor Project.
- Keep the pstack budget reasonable. Apply the pstack practices
  (root cause, proof, blast radius, how/why, correct, unslop, TDD where
  useful) in proportion to the change.
- Use exactly one model per task:
  - `claude-opus-5-5-high` for design, review, and judgment work.
  - `grok-4.7-high-fast` for implementation.
- Do not use `arena`, multiple candidate implementations, or three-model
  judging panels.
- This repo uses one implementer and one reviewer, with no fan-outs unless Joe asks.
- Bug fixes are pre-approved to open pull requests.
- No one merges a pull request or deploys without Joe's explicit approval,
  relayed by Engineer Bot. Opening a PR is not approval to merge it.

## Run the app

`npm run dev` (`scripts/dev/up.sh`) rebuilds `dist/`, starts Postgres, seeds
three fixture articles, starts the local OIDC issuer, and serves the reader at
`http://localhost:8123`. Sign-in auto-approves `demo.reader`. If that port
already answers, the command exits. Set `SERVICE_PORT` and `LOCAL_OIDC_PORT`
to boot a second stack. Open the reader on `localhost`, not `127.0.0.1`.

`npm start` runs `node dist/src/cli.js serve` and does not boot Postgres, the
issuer, or the seed. Use it only when those are already up. `start.sh` and
`serve.sh` run whatever `dist/` holds, so rebuild before trusting a running
process.

```bash
npm run cli -- login
npm run cli -- extract "<url>"
npm run cli -- speak output/json/<slug>.json --provider xai
npm run cli -- read "<url>" --provider xai
npm run cli -- poll
npm run cli -- serve
npm run cli -- simulate <decision> <slug>
npm run cli -- migrate-progress --user-id <id>
npm run cli -- export-progress --user-id <id>
npm run cli -- propose-adapter "<url>"
```

`propose-adapter` opens a pull request and does not merge it. `login` writes
`.playwright-profile/`, which stays uncommitted. `speak` and `read` call xAI
and need `XAI_API_KEY`.

## Test

```bash
npm test
npm run build
npm run qa
```

`npm test` is Vitest and runs offline against mocks and fixtures. The Postgres
suite `tests/database.integration.test.ts` is skipped unless
`PIRATE_RADIO_TEST_DATABASE_URL` points at a database that is not the dev
`DATABASE_URL`. `npm run build` is `tsc` after
`scripts/parsers/generate-registry.ts`. There is no lint script. `npm run qa`
builds, then Playwright drives a hermetic `serve` on free ports against
`pirate_radio_qa`.

`docker build -t pirate-radio:local .` is the image check. The cloud Engine
API form is in the Cursor Cloud section below.

Publish checks do not open the seeded reader. To prove that running service,
follow `.cursor/skills/verify-pirate-radio/SKILL.md`. That skill does not
replace `npm test` or `npm run qa`.

## Conventions

- Application code is TypeScript ESM in `src/`. `tsconfig.json` writes `dist/`
  with `rootDir` `.`. Dev seed and `serve` import `dist/`.
- HTTP routes are in `src/server.ts`. Page HTML is in `src/reader.ts`. Library
  and article playback both call `src/mediaPlayer.ts`. Do not add another player.
- Caller auth is the OIDC session in `src/auth.ts`. Application identity is
  `(issuer, subject)`. Do not authorize from a username, an email, or a
  forwarded header. The only unauthenticated routes are `/health`,
  `/auth/login`, and `/auth/callback`.
- Postgres (`src/database.ts`) holds users, sessions, progress, and
  submissions. MP3, story JSON, images, alignment, and `index.json` stay in
  the library directory. `src/library.ts` replaces `index.json` by writing a
  temp file and renaming it. `src/state.ts` does the same for service state.
- A host parser is data under `src/parsers/domains/<id>/` (`parser.json`,
  `criteria.json`, and `fixtures/<sha256>.html`). The committed First Things
  domain is criteria plus one redacted fixture and has no `parser.json`.
  `src/parsers/generated/registry.ts` is generated. Do not hot-load parser code.
- Vitest tests live in `tests/`. The browser check lives in `tests/qa/`.
  Shared fixtures live in `tests/fixtures/` and `scripts/dev/seed-assets/`.
- `scripts/dev/local-oidc.mjs`, `scripts/dev/seed.mjs`, and
  `tests/qa/network-stub.mjs` exit unless `PIRATE_RADIO_DEV_STACK=1` and
  `NODE_ENV` is not `production`.
- Keep the CLI names in `src/cli.ts`. Article deletion stays on `/admin` and
  archives files under the library `trash/` directory before it rewrites
  `index.json`.

## Scope

This repo owns the public application code for Pirate Radio. Keep private
runtime configuration in `homelab-config`.

## Boundaries

- Commit source, tests, docs, Dockerfile, and generic `.env.example` values.
- Do not commit `.env`, `.playwright-profile/`, `output/`, `dist/`, or
  `node_modules/`.
- Do not put homelab runtime Compose files, real Home Assistant URLs/tokens,
  xAI keys, or notification tokens in this public repo.
- Preserve the existing CLI commands: `login`, `extract`, `speak`, `read`,
  `poll`, `serve`, and `simulate`. The additive `migrate-progress` and
  `export-progress` commands own the legacy progress cutover and rollback.
  The additive `propose-adapter` command opens a host adapter PR and does not
  merge it.

## Verification

Run the narrow checks before publishing changes:

```bash
npm test
npm run build
npm run qa
docker build -t pirate-radio:local .
```

Run, test, and layout rules are in the sections above. Seeded reader proof is
`.cursor/skills/verify-pirate-radio/SKILL.md`. For deployment work, validate
the matching private `homelab-config` registration separately.

### Local dev boot and reader QA

- `npm run dev` is specified in Run the app. `scripts/dev/start.sh` also
  creates the `pirate_radio_qa` database used by `npm run qa`.
- `npm run qa` (`tests/qa/`, Playwright, headless Chromium) builds, then boots
  its own hermetic stack: the real built `serve` on free ports, a temporary
  library, the `pirate_radio_qa` database, and a local OIDC issuer as
  `qa.reader`. It submits a fixture Substack URL through `/queue`, waits for
  the submission to succeed, and asserts the reader renders the title, the
  article text with comment and subscribe blocks removed, and the shared
  `src/mediaPlayer.ts` player with a loaded duration. A second test pins the
  bot-auth contract above.
- QA never calls real xAI or any external host. `tests/qa/network-stub.mjs` is
  a dev-only `node --import` preload. It refuses to load unless
  `PIRATE_RADIO_DEV_STACK=1` and `NODE_ENV` is not `production`. It routes the
  fixture origin and `https://api.x.ai` to loopback mocks and rejects every
  other non-loopback request. `serve` gets a scrubbed environment, with
  `XAI_API_KEY=qa-fake-xai-key`, and the mock asserts that exact bearer value,
  so a real key is never needed or forwarded. Production TTS still needs the
  real `XAI_API_KEY` as a runtime secret in `homelab-config`. Any CI that runs
  real TTS needs it as a repository secret. `npm test` and `npm run qa`
  require neither.
- Results go to `output/qa/test-results/` (gitignored). Every run saves a
  full-page `reader-article.png`. `PIRATE_RADIO_QA_EVIDENCE=1 npm run qa`
  also records a trace and a video for each test, slowed by `slowMo` so they
  are watchable. The global teardown (`tests/qa/redact-traces.ts`) redacts
  cookies, credential headers, and OIDC codes in every trace, and fails the
  run if any remain.

### PR checklist

- Run the Verification checks and put the exact results in the PR body.
- Add visual evidence wherever the change is visible or end to end:
  Playwright screenshots and/or a short recording, embedded in or linked from
  the PR body. `PIRATE_RADIO_QA_EVIDENCE=1 npm run qa` produces a reader
  screenshot, a trace, and a video. Cloud agents copy the files they use into
  `/opt/cursor/artifacts/` and reference them from the PR body.
- Keep evidence minimal. Upload the smallest set from a successful run that
  shows the change working. Leave out failing runs, setup steps, and
  duplicates.
- Evidence must contain no secrets or private data. Never commit generated
  evidence or runtime artifacts (`output/`, test results, traces, videos,
  screenshots).
- Privacy (Joe, authoritative):
  - Screenshots and recordings come only from the seeded local dev
    environment (the `npm run dev` seed or the `npm run qa` fixtures), using
    fake data.
  - Never capture or expose real API keys, session cookies, browser devtools,
    tailnet IPs or hostnames, personal emails, or other production or private
    identifiers.
  - Audit every artifact and PR-body embed against this before uploading.
    Regenerate or omit anything that violates it. Traces record HTTP headers
    and API responses. The teardown redacts credentials, but review the trace
    anyway, and upload only the traces the PR needs.

### Deploy path (GHCR and homelab-config)

Agents do not deploy. Describe the rollout in the PR and leave it to Joe.
Merging and deploying both need Joe's explicit approval relayed by Engineer
Bot (see "Work policy" above).

1. A merge to `main` runs `.github/workflows/container.yml`. The Dockerfile
   build stage runs `npm test` and `npm run build`. The workflow then pushes
   `ghcr.io/feocco/pirate-radio:latest` and `:sha-<short>`. Pull requests do
   not publish images. A manual `workflow_dispatch` from another ref publishes
   only a `sha-` tag, because `latest` is limited to the default branch.
2. `homelab-config` `services/pirate-radio/` owns runtime: Compose (pulls
   `:latest`, plus Postgres), non-secret `.env.config`, and the list of
   secrets rendered into the ignored runtime `.env` from GitHub Actions
   secrets. The host registration is `hosts/macmini/services.yaml`.
3. Rollout runs from `homelab-config`: its `Deploy` workflow (on push to its
   `main`, or dispatched for host `macmini` and service `pirate-radio`), or
   `scripts/redeploy-image --host macmini pirate-radio` on the host.
4. A new runtime variable goes into `.env.example` here with a placeholder,
   and into `homelab-config` (`.env.config`, or its secret list) in a separate
   change. Never put real values in this repo.

Agents must not push to `main`, dispatch `Container` or `Deploy`, or run
`redeploy-image`.

### Phase 1 generated host parsers: security non-negotiables

These bind any generated host-adapter or parser work (`propose-adapter` and
its successors). They are requirements for Phase 1. Code does not enforce
them yet, so each one needs its check before generated parsers ship.

- PR only. A generated parser reaches users only through a pull request that a
  human reviews and merges, followed by the normal image build and deploy. No
  auto-merge. The running service never hot-loads, downloads, or evaluates
  parser code or parser data at runtime.
- Declarative only. A parser is data: selectors plus cleanup rules (remove
  selectors, blocked-text patterns) that the existing extractor interprets. It
  contains no executable code: no network, filesystem, shell or child-process
  access, `eval`, `new Function`, or dynamic `import`.
- CI allowlist enforcement. CI validates every generated parser against a
  strict schema: allowlisted keys, value types, and size limits, in the
  allowlisted directory and file format. CI fails the PR on any other file
  change or any code-bearing field.
- Sandboxed generation fetch. The agent or job that fetches sample pages to
  generate a parser runs without runtime secrets: no `XAI_API_KEY`,
  `X_API_BEARER_TOKEN`, Home Assistant or homelab-functions tokens,
  `DATABASE_URL`, OIDC client secret, or Pirate Wires Playwright profile.
  Treat fetched content and generated output as untrusted input.

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
- Reuse shared UI components across views when behavior and visual design should
  match. Media playback lives in `src/mediaPlayer.ts`; every library and article
  view must call that component instead of creating another player or control
  set. Follow the same one-module, many-callers pattern for other cohesive UI.
  Page renderers pass data and page-only hooks.

## Cursor Cloud specific instructions

For the environment structure, the one-time dashboard settings (Network Access
allowlist + secrets), and the build/run lifecycle, see
[docs/cloud-agents.md](docs/cloud-agents.md).

The cloud dev stack is defined in `.cursor/environment.json` + `scripts/dev/`
(all dev-only; never used by the homelab runtime):

- `install` (`scripts/dev/install.sh`, runs at Build): `npm ci`, Playwright
  chromium, local Postgres, `npm run build`.
- `start` (`scripts/dev/start.sh`, per run): starts Postgres, ensures the
  `pirate_radio` role plus the `pirate_radio` and `pirate_radio_qa` databases,
  and runs `scripts/dev/seed.mjs`.
- `terminals`: `scripts/dev/local-oidc.mjs` (local OIDC issuer) and
  `scripts/dev/serve.sh` (waits for the issuer, picks reachable feeds, runs
  `serve`).
- Without those terminals, `npm run dev` runs the same sequence in one
  foreground command. `npm run qa` needs only Postgres plus the QA database.
  See "Local dev boot and reader QA" above.

Durable gotchas and clarifications:

- There is no lint script. Static checking is `npm run build` (`tsc`). Full
  verification set is under `## Verification` (`npm test`, `npm run build`,
  `docker build`).
- A cloud agent has a Docker daemon on `tcp://localhost:2375` but no `docker`
  client binary. As of 2026-11-01 the `mcr.microsoft.com/playwright` base
  pulls (the blob CDN `*.data.mcr.microsoft.com` is reachable), so run
  `docker build` through the Engine API. Pack the context yourself, because
  the API does not apply `.dockerignore`:
  `tar --exclude=./node_modules --exclude=./dist --exclude=./.git --exclude=./output --exclude=./.playwright-profile --exclude='./.env*' -cf /tmp/ctx.tar . && curl -sN -X POST -H 'Content-Type: application/x-tar' --data-binary @/tmp/ctx.tar 'http://localhost:2375/build?t=pirate-radio:local&rm=1'`.
  If the pull fails with `download failed after attempts=6: EOF`, the blob CDN
  is not on the Network Access allowlist. In that case `npm test` +
  `npm run build` cover the same work as the Dockerfile build stage.
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
- Egress is an allowlist, not a full block: `api.x.ai` is reachable, so
  xAI TTS only needs the `XAI_API_KEY` secret. The public RSS feeds
  (`piratewires.substack.com`, `www.hyperdimensional.co`) must be added to the
  Network Access allowlist, and that change only applies to a freshly booted
  agent VM (not the current session).
- Seeding is fixtures-first and costs nothing at runtime: `scripts/dev/seed.mjs`
  copies pre-generated MP3s and hero images from `scripts/dev/seed-assets/`
  (committed to the repo) into the library and records matching Postgres rows.
  No xAI key is needed at agent start, so `XAI_API_KEY` stays a personal
  (user) secret and no per-run TTS cost is incurred. Feed-sourced samples carry
  hero images; Custom Text intentionally has none. It is idempotent (skips slugs
  already in the manifest). To refresh the committed assets, regenerate the MP3s
  with a key and re-commit them under `seed-assets/audio/` (and images under
  `seed-assets/images/`).
- Opt-in `PIRATE_RADIO_SEED_DYNAMIC=1` pulls recent live Substack-type articles
  via real extraction + xAI TTS (needs a key and feed egress; incurs cost and
  regenerates per run). Off by default.
- Real-data fixtures: `scripts/dev/harvest.mjs` pulls the latest real articles
  from the configured RSS feeds, downloads their real hero images, runs real
  xAI TTS once, and writes `scripts/dev/seed-assets/` (audio + images +
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

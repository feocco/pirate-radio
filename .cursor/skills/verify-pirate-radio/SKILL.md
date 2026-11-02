---
name: verify-pirate-radio
description: Drive the local Pirate Radio web reader and the First Things parser criteria the way a member would. Use when proving health, sign-in, the library, an article, the queue, or the committed parser fixtures.
---

# Verify Pirate Radio

Prove the local reader by starting a scratch service, signing in through the dev OIDC issuer, and checking what a member can see. Parser criteria run separately against the committed First Things fixture. Do not point this skill at `reader.home.feocco.com` or any other deployed host.

The dev issuer auto-approves `demo.reader`. It is a local stand-in so this repo can boot without Authentik. Production auth stays on the homelab IdP. Never add a second login, a bearer token, or a service token here.

## Journey

One run is one record. `verify.sh` writes it to `output/qa/verify/state.json`. Fields are `runId`, `publicUrl`, `serviceHost`, `servicePort`, `oidcIssuer`, `oidcPort`, `libraryDir`, `devDir`, `databaseName`, `pids.oidc`, `pids.serve`, `evidenceDir`, and `startedAt`. Evidence lives under `output/qa/verify/<runId>/` and outlives cleanup. `output/` is gitignored. Do not commit it.

Follow this order. A later step does not count as proof of an earlier step you skipped.

| Step | Command | Done when |
| --- | --- | --- |
| 1. Launch | `bash .cursor/skills/verify-pirate-radio/verify.sh launch` | Doctor prints `doctor ok` and the scratch `index.json` has the three seed slugs. |
| 2. Doctor | `bash .cursor/skills/verify-pirate-radio/verify.sh doctor` | The recorded pids are alive, their env matches this run, `/health` returns `{"ok":true}`, and the issuer discovery URL returns 200. |
| 3. Health | `node .cursor/skills/verify-pirate-radio/drive.mjs health` | `evidence/health.json` is `{"ok":true}` and an anonymous `GET /library.json` is 401 `authentication_required`. |
| 4. Sign in and library | `node .cursor/skills/verify-pirate-radio/drive.mjs auth` | `evidence/library.png` shows the three seeded titles and `evidence/auth-me.json` has `demo.reader`. |
| 5. Article | `node .cursor/skills/verify-pirate-radio/drive.mjs article` | `evidence/article.png` shows the generalist title, the opening sentence, and a player duration that is not `00:00`. |
| 6. Queue page | `node .cursor/skills/verify-pirate-radio/drive.mjs queue` | `evidence/queue.png` shows the paste form and `Inside Micron's Attempts` with `Convert` still unclicked. |
| 7. Queue conversion | `npm run qa` | Playwright reports the Harbor Lights fixture title, body, and player. Screenshot is `output/qa/test-results/reader-article.png`. |
| 8. Parser criteria | `npx vitest run tests/first-things-criteria.test.ts` | The test passes all five gates on the committed fixture. |
| 9. Cleanup | `bash .cursor/skills/verify-pirate-radio/verify.sh cleanup` | Those two pids are gone, `pirate_radio_verify` is dropped, the scratch directory is gone, and the evidence directory is still there. |

`node .cursor/skills/verify-pirate-radio/drive.mjs all` runs steps 3 through 6 in one browser session. Run steps 7 and 8 yourself. They do not use the scratch service.

Read [features/README.md](features/README.md) before driving. Each feature file is the recipe. Do not mark a feature verified because a different entry point happened to work.

## Launch

From the repo root:

```bash
bash .cursor/skills/verify-pirate-radio/verify.sh launch
```

Launch runs `npm run build`, ensures local Postgres is accepting connections, creates the database `pirate_radio_verify`, and seeds `scripts/dev/seed-assets/` into a new directory under `/tmp/pirate-radio-verify-<runId>/`. It then starts `scripts/dev/local-oidc.mjs` and `node dist/src/cli.js serve` on two free ports. It will not bind `8123`, `9443`, or `5432`.

The public origin is `http://localhost:<servicePort>`. The issuer is `https://localhost:<oidcPort>`. `serve` binds `127.0.0.1` and trusts the dev issuer with `NODE_TLS_REJECT_UNAUTHORIZED=0`, which is dev-only, same as `scripts/dev/env.sh`. The feed list is only the issuer's `/feed.xml`, which serves `tests/fixtures/pirate-feed.xml`. Launch unsets `XAI_API_KEY`, `X_API_BEARER_TOKEN`, `HA_LONG_LIVED_TOKEN`, `HOMELAB_FUNCTIONS_TOKEN`, `CURSOR_API_KEY`, `HA_URL`, and `PIRATE_RADIO_SERVICE_TOKEN` for this process.

Ready means all of these are true:

- The serve log contains `[pirate-radio] listening on 127.0.0.1:<servicePort>`.
- `curl -fsS http://localhost:<servicePort>/health` prints `{"ok":true}`.
- `https://localhost:<oidcPort>/.well-known/openid-configuration` returns 200.
- `<libraryDir>/index.json` contains `return-of-the-generalist-engineer`, `regulators-discover-the-data-center`, and `notes-on-shipping-audio`.

If Postgres is not already up, launch runs `bash scripts/dev/start.sh`. That script also idempotently seeds the default `pirate_radio` database and `output/library`. When Postgres is already up, launch does not reseed that library.

If `output/qa/verify/state.json` already exists, launch exits and tells you to clean up. It will not attach to a stack it did not start, including the cloud `serve` terminal on port `8123`.

## Doctor

```bash
bash .cursor/skills/verify-pirate-radio/verify.sh doctor
```

Doctor is read-only. It fails unless the state file exists, both pids are alive, `/proc/<pid>/cmdline` is `local-oidc.mjs` or `dist/src/cli.js serve`, and that process environment contains this run's `PIRATE_RADIO_DEV_DIR` and serve port. It then checks health on both `127.0.0.1` and `localhost`, issuer discovery, and the three seed slugs. Run it before any drive when a page looks wrong.

## Drive

Drive the seeded stack with `drive.mjs`. The selectors come from `src/reader.ts` and `tests/qa/reader.spec.ts`.

Sign in by opening `/` and choosing `Sign in`, or by opening `/auth/login?returnTo=/`. The dev issuer redirects back. The session cookie is `pirate_radio_session`. It is `Secure`, `HttpOnly`, and host-only. Use the `localhost` origin in the state file. Do not switch to `127.0.0.1`.

After sign-in, the pages and JSON routes to exercise are `/`, `/auth/me`, `/library.json`, `/article/return-of-the-generalist-engineer`, `/progress/return-of-the-generalist-engineer`, `/audio/return-of-the-generalist-engineer.mp3`, `/queue`, `/queue.json`, and `/submissions.json`. Details, commands, and proof are in the feature files.

Queue conversion is not the scratch stack. `npm run qa` builds, starts its own `serve` on free ports, signs in as `qa.reader`, submits `tests/fixtures/qa-article.html` through `#article-url`, and checks the article page. It uses `pirate_radio_qa` and `tests/qa/network-stub.mjs`. It does not call real xAI. Leave the scratch stack up or down. QA does not use it.

Parser criteria do not need a server:

```bash
npx vitest run tests/first-things-criteria.test.ts
```

That test calls `evaluateCriteria` in `src/parsers/criteria.ts` on `src/parsers/domains/first-things/fixtures/2d74b9d666a4fc56265811332fdb1fb4c3ca2e1fde16c0f44c4d8694de7ad10e.html`. The gates are `title`, `first_words`, `last_words`, `phrases_ordered`, and `no_script_or_raw_html`.

Do not click `Convert`, `Convert URL`, `Convert Text`, `Delete article`, or `Propose adapter PR` on the scratch stack. Those actions can call xAI, a public site, or the Cursor API, or archive a library item.

## Evidence

Write proof under the `evidenceDir` in the state file. `drive.mjs` writes:

- `health.json` and `library-locked.json` for the anonymous checks
- `sign-in.png` before login and `library.png` after it
- `auth-me.json`, `library.json`, `progress.json`
- `article.png` and `queue.png`
- `drive.log` with one line per check and no cookie values

`npm run qa` writes `output/qa/test-results/`, including `reader-article.png`. `PIRATE_RADIO_QA_EVIDENCE=1 npm run qa` also writes a trace and a video. `tests/qa/redact-traces.ts` redacts cookies and OIDC codes. Still do not commit those files.

A failed launch copies `oidc.log` and `serve.log` into the evidence directory before it deletes the scratch directory. Those copies are for the failed run. Do not commit them.

Capture the action and the result. A final screenshot without the sign-in page, the library, or the article body is not enough. For the article, the audio response status and the progress JSON are the side effects to keep next to the picture.

Seeded titles, authors, and body text come from `scripts/dev/seed-assets/articles.json`. They are fake. The queue row `Inside Micron's Attempts` comes from `tests/fixtures/pirate-feed.xml`. QA's article is `Harbor Lights After Midnight` by `Quinn Fixture`. Do not harvest live feeds and do not set `PIRATE_RADIO_SEED_DYNAMIC=1` for this proof.

## Cleanup

```bash
bash .cursor/skills/verify-pirate-radio/verify.sh cleanup
```

Cleanup reads the state file and signals only those pids. It sends `SIGTERM`, waits, then `SIGKILL` if that pid is still the process this run started. It checks cmdline and `PIRATE_RADIO_DEV_DIR` before every signal. It never uses `pkill`, `killall`, or a process-name match.

It then terminates sessions on `pirate_radio_verify` and drops that database only. It deletes the `/tmp/pirate-radio-verify-<runId>` directory and the state file. It does not delete `evidenceDir`, `output/qa/test-results/`, `output/library`, `pirate_radio`, or `pirate_radio_qa`.

Run cleanup after a failed launch too. The launch command does that itself when it exits with an error.

## Helpers

- `bash .cursor/skills/verify-pirate-radio/verify.sh launch` starts the scratch stack and writes the state file.
- `bash .cursor/skills/verify-pirate-radio/verify.sh doctor` checks that stack without changing it.
- `bash .cursor/skills/verify-pirate-radio/verify.sh cleanup` stops the recorded pids and removes scratch state.
- `node .cursor/skills/verify-pirate-radio/drive.mjs all` drives health, sign-in, the library, one article, and the queue page.
- `node .cursor/skills/verify-pirate-radio/drive.mjs health|auth|article|queue` drives one of those steps.
- `npm run qa` is the queue conversion proof.
- `npx vitest run tests/first-things-criteria.test.ts` is the parser criteria proof.

When the app changes a route, a selector, or a fixture, update the feature file in the same change. `/maintain-verification-skill` is the loop for that update.

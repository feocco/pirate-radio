# HTTP API

The machine-readable contract is served at `/openapi.json`; `/docs` provides a
small browser view. Except for `GET /health`, `GET /auth/login`, and
`GET /auth/callback`, every route requires the `pirate_radio_session` cookie.

## Identity

- `GET /auth/login?returnTo=/path` starts Authentik OIDC with PKCE.
- `GET /auth/callback` consumes the one-time browser-bound transaction.
- `GET /auth/me` returns the current application-user and role snapshot.
- `POST /auth/logout` revokes the session, clears the cookie, and redirects
  through Authentik's OIDC end-session endpoint before returning home.

Unauthenticated calls return `401 authentication_required`. `/admin` and
`/simulate/*` return `403 admin_required` for authenticated non-admin members.
State-changing calls with a missing or foreign Origin return
`403 invalid_origin`.

## Per-user progress

`GET /progress/<slug>` returns only the caller's row. `PUT /progress/<slug>`
accepts `positionSeconds`, optional `durationSeconds`, and optional `ended`.
Responses include optional `completedAt`. Completion is first set at a positive
duration ratio of at least 95%, or when `ended` is true, and is never cleared by
later backward seeks.

## Shared data

`GET /library.json`, `/article/<slug>`, `/audio/*`, `/images/*`, and
`/alignment/*` expose the shared library to authenticated members. Article HTML
adds the first successful human submitter and the current usernames of every
completed user. Existing/automated items have no human attribution.

`GET /submissions.json` returns global recent feed, URL, and custom-text
submissions with status and a preserved username snapshot. The queue page uses
this endpoint directly.

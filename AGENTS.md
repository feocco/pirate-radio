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

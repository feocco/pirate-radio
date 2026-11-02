# Health

Health tells a member, and an anonymous caller, whether this Pirate Radio process is answering. The library stays locked until sign-in.

## Sub-features

- `health-live` returns `{"ok":true}` from `GET /health` with no cookie.
- `health-locked` returns `401` and `authentication_required` for `GET /library.json` with no cookie.
- `health-sign-in-page` shows the HTML sign-in page for a browser `GET /`.

## How to get to it (user POV)

- Request `GET /health` with no session.
- Open `/` in a browser before signing in.
- Request `GET /library.json` with no session. The library must not load.

## Driving it with verify-pirate-radio

Preconditions:

- `bash .cursor/skills/verify-pirate-radio/verify.sh doctor` prints `doctor ok`.
- Use the `publicUrl` in `output/qa/verify/state.json`. Call it `$PUBLIC_URL` below.

- **Liveness.** Request health with no cookie. Run `curl -fsS "$PUBLIC_URL/health"`. The body is `{"ok":true}` and the status is `200`.
- **Locked library.** Request the manifest with no cookie. Run `curl -sS -w "\n%{http_code}\n" "$PUBLIC_URL/library.json"`. The status is `401` and the JSON `error` is `authentication_required`.
- **Sign-in page.** Open `$PUBLIC_URL/` in the drive. Run `node .cursor/skills/verify-pirate-radio/drive.mjs health`. The script writes `health.json`, `library-locked.json`, and `sign-in.png` under the run's `evidenceDir`. The picture shows the heading `Pirate Radio` and a `Sign in` link.

## Gotchas

- `/health` stays public. A `200` from it does not mean the seed finished or that sign-in works. Doctor checks the seed slugs separately.
- A browser `GET /` sends `Accept: text/html` and gets a `401` HTML page, not the JSON error. `curl` without that header gets JSON from `/library.json`.
- Do not send `Authorization: Bearer` or `X-API-Key` and treat a result as success. `tests/qa/reader.spec.ts` requires those headers to get `401`.
- Write the status and body only. Do not write a `Cookie` header into the evidence directory.

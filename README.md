# Pirate Radio

## Authentication for bots

Pirate Radio has no machine-to-machine authentication. The server accepts no
API token, bearer token, API key, or service-account credential, and no
environment variable configures one. A bot can only act as an Authentik user
who signed in through the browser login flow.

### Endpoint

Use `https://reader.home.feocco.com` from a device on the tailnet.

| Endpoint | Use it? | Why |
| --- | --- | --- |
| `https://reader.home.feocco.com` | Yes | It is the deployed `PIRATE_RADIO_PUBLIC_URL`, the only OIDC redirect URI registered in Authentik, and the only `Origin` the server accepts on writes. Its DNS record is a tailnet address, so the client needs tailnet ACL access to the Pirate Radio Tailscale Service. |
| `https://reader.feocco.com` | No | The name does not exist. Authoritative DNS returns NXDOMAIN. |
| Direct macmini port | No | Compose publishes the container port on the Mac mini's loopback only, and no Tailscale Serve port maps to it. Even on the host itself, the cookie and `Origin` checks are bound to `reader.home.feocco.com`. |

### Credential accepted today

The only credential is the `pirate_radio_session` cookie that a browser login
creates:

1. `GET /auth/login?returnTo=/path` starts an OIDC authorization code + PKCE
   login against Authentik and sets a 10-minute `pirate_radio_oidc`
   transaction cookie in that browser.
2. Authentik signs the user in. The identity must be in `pirate-radio-users`.
   Admin routes also need `pirate-radio-admins`.
3. `GET /auth/callback` exchanges the code and sets `pirate_radio_session`. The
   value is random and opaque. The server stores only its SHA-256 hash. The
   cookie is `Secure`, `HttpOnly`, `SameSite=Lax`, and host-only, with a fixed,
   non-rolling lifetime from `PIRATE_RADIO_SESSION_HOURS`.
4. Every route except `/health`, `/auth/login`, and `/auth/callback` requires
   that cookie. Without it the server returns `401`, as
   `{"error":"authentication_required"}` JSON or as a sign-in page for HTML
   `GET` requests.
5. `POST`, `PUT`, `PATCH`, and `DELETE` also require
   `Origin: https://reader.home.feocco.com` exactly, or the server returns
   `403 {"error":"invalid_origin"}`.
6. `POST /auth/logout` revokes the session server-side.

The server ignores `Authorization: Bearer ...` and `X-API-Key` headers. The
Authentik provider allows only the `authorization_code` grant, so client
credentials and Authentik API tokens cannot create a Pirate Radio session
either.

The one path the code accepts for automation is a user session. A bot drives
the browser login (for example, headless Playwright) as an Authentik account in
`pirate-radio-users`. It then sends `Cookie: pirate_radio_session=<value>`,
plus `Origin` on writes, and can check the session with `GET /auth/me`. That
session carries the account's identity and groups, cannot be scoped, expires
on the fixed lifetime, and ends at logout. It is not a reviewed bot
integration.

### Environment-variable contract for a bot

There is none. Pirate Radio reads no environment variable that authenticates
callers. `XAI_API_KEY`, `X_API_BEARER_TOKEN`, `HA_LONG_LIVED_TOKEN`,
`HOMELAB_FUNCTIONS_TOKEN`, and `CURSOR_API_KEY` are outbound credentials the
server uses to call other services. They do not authenticate requests to
Pirate Radio, and bots should not receive them. Whatever variable a bot uses to
hold its session cookie is that bot's own configuration, not a Pirate Radio
contract.

`PIRATE_RADIO_SERVICE_TOKEN`, or any similar name, is unsupported. No code
reads it. Setting it on the server or sending its value as a bearer token has
no effect. Machine-to-machine auth needs a reviewed design before any variable
name becomes a contract. That design must cover identity, group-based access,
scoping, rotation, and revocation.

`npm run qa` enforces this contract against the real server. A bearer token,
an `X-API-Key`, and a set `PIRATE_RADIO_SERVICE_TOKEN` are all rejected with
`401`. The session cookie is accepted from a plain HTTP client. Writes without
`Origin` get `403`, and logout revokes the session. The endpoint facts come
from the `homelab-config` Pirate Radio service, the Authentik blueprint, and
public DNS on 2026-11-01. A live HTTPS request over the tailnet has not been
checked from the cloud dev environment, which is not on the tailnet.

## About

OIDC-protected homelab reader and local CLI for collecting articles from across
the web, queueing pasted text, generating xAI text-to-speech audio, and
reading generated audio with cached article art where available. Supported
article sources include Pirate Wires, Substack publications, X Articles, and
unsupported `https` article URLs extracted by a Cursor Cloud Agent attached to
this repository.

## Setup

```bash
npm install
npx playwright install chromium
```

The xAI audio command uses `XAI_API_KEY` from the environment. The CLI
does not print or store the key.

## Login

```bash
npm run cli -- login
```

This opens a dedicated Playwright browser profile in `.playwright-profile/`.
Log in to Pirate Wires with your email passcode, then press Enter in the
terminal. The profile directory is ignored by git and reused by later commands.

## Extract Text

```bash
npm run cli -- extract "https://www.piratewires.com/p/story-slug"
```

Outputs:

- `output/text/<slug>.txt`
- `output/json/<slug>.json`

The extractor keeps the story focused while preserving reader metadata: title,
optional author, tagline, body blocks, best-effort section titles, and the
article hero image URL.
X Articles use the official X Post lookup API and require
`X_API_BEARER_TOKEN`; the public X page is not scraped.
Unsupported `https` article URLs require `CURSOR_API_KEY` and launch a Cursor
Cloud Agent against `feocco/pirate-radio` that writes `artifacts/story.json`.
That extract agent does not open a pull request. Optional
`--first-sentence` and `--last-sentence` pin the extract to inclusive anchors.
A successful cloud extract records the host fingerprint in
`cloud-hosts.json`. That write does not open an adapter PR.

To open a first-class host adapter PR later, without merging it:

```bash
npm run cli -- propose-adapter "https://darioamodei.com/post/we-must-pace-the-frontier"
```

Admins can send the same request from `/admin` to `POST /admin/propose-adapter`.

## Generate Audio

From an existing JSON file:

```bash
npm run cli -- speak output/json/story-slug.json --provider xai
```

Extract and generate audio in one command:

```bash
npm run cli -- read "https://www.piratewires.com/p/story-slug" --provider xai
```

Outputs:

- `output/audio/<slug>.mp3`

xAI defaults:

- Voice: `eve`
- Language: `en`
- Format: `mp3`

The CLI estimates xAI TTS cost at `$15 / 1M characters` and refuses to
generate audio above `$1` unless `--allow-over-budget` is passed.

## Providers

TTS providers implement `TtsProvider.synthesize({ title, text, outputPath })`.
Only `xai` is implemented now; the provider boundary is in place so
ElevenLabs can be added later without changing the extraction commands.

## Checks

```bash
npm test
npm run build
npm run qa
```

`npm run qa` is the headless Playwright reader check. It needs local Postgres
with the `pirate_radio_qa` database (`bash scripts/dev/start.sh` creates it)
and uses a mocked xAI, so no real key is involved. `npm run dev` boots the full
seeded dev stack. See `AGENTS.md` for both.

## Service Mode

```bash
npm run build
npm start
```

`serve` polls the configured RSS feeds, sends Home Assistant mobile actions via
homelab-functions, listens for the mobile action event over Home Assistant
WebSocket, and writes the reader library under `PIRATE_RADIO_LIBRARY_DIR`. Set
`PWR_HEADLESS=true` for Docker or any headless host.

Service mode requires Postgres and an OpenID Connect provider. Pirate Radio
uses authorization code plus PKCE, creates a host-only opaque session, requires
the `pirate-radio-users` group for every reader route, and requires
`pirate-radio-admins` for `/admin` and `/simulate/*`. See
[configuration](docs/configuration.md), [security](docs/security.md), and the
[HTTP contract](docs/api.md).

When an article is approved, the service now fails closed if the Playwright
profile is not logged into Pirate Wires, sends a failure notification with the
active profile path, and leaves the article pending so it can be retried. After
successful audio generation, it sends a ready notification that opens the
article page directly.

When a feed is configured for the first time, Pirate Radio records its current
articles as a baseline without sending notifications. Only articles discovered
on later polls produce new-article notifications, so adding a publication does
not replay its RSS history.

Set `PIRATE_RADIO_REAUTH_URL` to the Tailnet-only login browser URL when a
reauth browser is available. Auth failures then send a dedicated login-required
notification whose tap target opens that browser, so the article can be retried
after login.

The reader serves:

- `/` for the audio library with cached article art, source filtering, and
  conversion-time sorting by default. Cards show the source and optional
  article author.
- `/docs` for a browser-friendly summary of the service HTTP contract and
  `/openapi.json` for the OpenAPI 3.1 document.
- `/queue` for recent RSS articles that have not been converted yet, with
  search, pagination, async conversion buttons, pasted article URLs, and custom
  text entry.
- `/article/<slug>` for a dedicated article page with audio and full text.
- `/progress/<slug>` for private per-user cross-device playback and durable
  completion at 95% or the browser `ended` event.
- `/submissions.json` for authenticated global conversion history and
  attribution.
- `/audio/<slug>.mp3`, `/images/<slug>.<ext>`, and optional
  `/alignment/<slug>.json` assets.

The queue list is RSS-window-only in v1. It compares the current configured
feeds against the library manifest, then queues selected articles through the
same approval, extraction, TTS, and notification workflow used by mobile
actions. Pasted Pirate Wires, Hyperdimensional, Substack `/p/...`, and X
`/<username>/status/<id>` Article URLs can also be queued from the queue page.
Custom title/text entries bypass article extraction and write directly into the
same reader library after TTS generation.

Set `PIRATE_RADIO_ENABLE_ALIGNMENT=true` to prototype word-level highlighting.
When enabled, synthesis requests xAI TTS with `with_timestamps` and writes that
timing JSON. If timestamps are missing, it falls back to xAI speech-to-text.
Alignment stays off by default because it adds cost and latency.

For manual backfills after relogin, refresh and regenerate an existing library
item with:

```bash
curl -X POST "http://127.0.0.1:8123/simulate/refresh/<slug>?regenerateAudio=true&notify=true"
```

The maintenance endpoint requires an admin application session and a matching
`Origin`; the loopback example is illustrative for an authenticated local test,
not a bypass around OIDC.

## Legacy progress cutover and rollback

After Joe's normal Authentik account has logged in once, obtain its internal id
from `/auth/me` and run:

```bash
npm run cli -- migrate-progress --user-id <application-user-id> --expect-count 12
npm run cli -- export-progress --user-id <application-user-id>
```

The import is transactional and idempotent, retains a timestamped copy of the
source `progress.json`, and refuses a count other than the expected value. The
export creates parsed, rollback-compatible legacy JSON without overwriting the
active source file.

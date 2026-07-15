# Pirate Wires Reader

OIDC-protected homelab reader and local CLI for extracting Pirate Wires,
Substack, and X Articles, queueing pasted text, generating OpenAI text-to-speech
audio, and reading generated audio with cached article art where available.

## Setup

```bash
npm install
npx playwright install chromium
```

The OpenAI audio command uses `OPENAI_API_KEY` from the environment. The CLI
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
tagline, body blocks, best-effort section titles, and the article hero image URL.
X Articles use the official X Post lookup API and require
`X_API_BEARER_TOKEN`; the public X page is not scraped.

## Generate Audio

From an existing JSON file:

```bash
npm run cli -- speak output/json/story-slug.json --provider openai
```

Extract and generate audio in one command:

```bash
npm run cli -- read "https://www.piratewires.com/p/story-slug" --provider openai
```

Outputs:

- `output/audio/<slug>.mp3`

OpenAI defaults:

- Model: `gpt-4o-mini-tts`
- Voice: `alloy`
- Format: `mp3`

The CLI estimates OpenAI TTS cost at `$15 / 1M characters` and refuses to
generate audio above `$1` unless `--allow-over-budget` is passed.

## Providers

TTS providers implement `TtsProvider.synthesize({ title, text, outputPath })`.
Only `openai` is implemented now; the provider boundary is in place so
ElevenLabs can be added later without changing the extraction commands.

## Checks

```bash
npm test
npm run build
```

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
  conversion-time sorting by default.
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
When enabled, the service runs a post-TTS `whisper-1` transcription with word
timestamps and writes alignment JSON. This is disabled by default because it adds
cost, latency, and approximate source-text matching.

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

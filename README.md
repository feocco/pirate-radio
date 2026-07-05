# Pirate Wires Reader

Local CLI and Tailnet reader for extracting logged-in Pirate Wires stories,
queueing pasted text, generating OpenAI text-to-speech audio, and reading
generated audio with cached article art where available.

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

`serve` polls the Substack RSS feed, sends Home Assistant mobile actions via
homelab-functions, listens for the mobile action event over Home Assistant
WebSocket, and writes the reader library under `PIRATE_RADIO_LIBRARY_DIR`. Set
`PWR_HEADLESS=true` for Docker or any headless host.

When an article is approved, the service now fails closed if the Playwright
profile is not logged into Pirate Wires, sends a failure notification with the
active profile path, and leaves the article pending so it can be retried. After
successful audio generation, it sends a ready notification that opens the
article page directly.

Set `PIRATE_RADIO_REAUTH_URL` to the Tailnet-only login browser URL when a
reauth browser is available. Auth failures then send a dedicated login-required
notification whose tap target opens that browser, so the article can be retried
after login.

The reader serves:

- `/` for the audio library with cached article art.
- `/docs` for a browser-friendly summary of the service HTTP contract and
  `/openapi.json` for the OpenAPI 3.1 document.
- `/backlog` for recent RSS articles that have not been converted yet, with
  search, pagination, async conversion buttons, and a pasted Pirate Wires URL
  queue plus custom text entry.
- `/article/<slug>` for a dedicated article page with audio and full text.
- `/progress/<slug>` for cross-device playback position.
- `/audio/<slug>.mp3`, `/images/<slug>.<ext>`, and optional
  `/alignment/<slug>.json` assets.

The backlog list is RSS-window-only in v1. It compares the current feed against
the library manifest, then queues selected articles through the same approval,
extraction, TTS, and notification workflow used by mobile actions. Pasted
`piratewires.com/p/...` URLs can also be queued from the backlog page. Custom
title/text entries bypass Pirate Wires extraction and write directly into the
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

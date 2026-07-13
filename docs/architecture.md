# Architecture

Pirate Radio is a local-first reader pipeline for monitored article sources,
pasted article URLs, and custom pasted text.

## Flow

1. Poll the configured RSS feeds. The default set is Pirate Wires and
   Hyperdimensional.
2. Compare feed entries across sources against durable state.
3. Send a Home Assistant mobile notification through homelab-functions with
   stable Yes/No action IDs.
4. Listen for Home Assistant `mobile_app_notification_action` events over
   WebSocket.
5. On article approval, extract the story with Playwright, including title,
   tagline, body blocks, section headings, and the hero image URL. Custom text
   entries skip extraction and create a story object directly from title/body.
6. Cache article art locally when available, synthesize MP3 audio through the
   selected TTS provider, and optionally write word-timing alignment JSON.
7. Write story JSON, text, MP3, cached image, and a library manifest.
8. Send a ready notification with a direct link to the generated article page.
9. Serve a Tailnet-only reader UI with a library view, article detail pages,
   a recent-article queue, cached images, inline MP3 streaming, and saved
   playback position.

The first service run treats the current feed as a baseline and queues at most
one notification, which avoids a startup flood. Later polls only mark articles
seen when they are queued or decided.

Extraction fails closed when the persistent Playwright profile is not logged
into Pirate Wires. The service sends a failure notification, keeps the article
pending for retry, and avoids generating preview-length audio. When
`PIRATE_RADIO_REAUTH_URL` is configured, auth failures send a dedicated
login-required notification that opens the Tailnet-only reauth browser.

## Components

- `src/feed.ts`: source-aware RSS fetch and parsing.
- `src/server.ts`: service loop, HTTP reader routes, and action simulation.
- `src/backlog.ts`: RSS queue status and async conversion queue helpers.
- `src/notifications.ts`: stable mobile action IDs.
- `src/haActions.ts`: Home Assistant WebSocket listener.
- `src/workflow.ts`: article decision handling.
- `src/assets.ts`: article image caching and asset content types.
- `src/alignment.ts`: optional OpenAI Whisper word-timing artifact writer.
- `src/tts/`: provider interface and OpenAI implementation.
- `src/library.ts`: durable manifest writer.
- `src/progress.ts`: single-user durable playback-position store.
- `src/reader.ts`: library and article-page renderer with server-backed
  playback-position sync, plus the RSS queue page.

## Queue

The `/queue` list uses the current configured RSS feeds. `/queue.json` marks
articles as converted by comparing feed slugs/source URLs with the library
manifest, and marks in-flight conversions from service memory. Posting to
`/queue/convert/<slug>` records the feed article in pending state and starts the
existing `accept` workflow in the background.

The queue page also accepts pasted Pirate Wires, Hyperdimensional, and Substack
`/p/...` article URLs. `POST /queue/convert-url` validates known article URL
patterns, records a minimal pending article, and starts the same background
conversion workflow. Completion/failure still comes through the normal phone
notifications. `/backlog` routes remain compatibility aliases.

The same page accepts custom title/text entries. `POST /queue/convert-text`
validates the title/body, writes a generated story JSON/text file, synthesizes
audio, appends the item to the library manifest, and sends the normal ready or
failure notification. Custom text does not require Pirate Wires login.

## Playback Progress

The reader stores playback position in `<library>/progress.json` through
`GET /progress/<slug>` and `PUT /progress/<slug>`. The file is currently
single-user under a `default` profile so progress follows the user across
browsers and devices. The shape leaves room to replace `default` with an SSO
user ID later. Browser `localStorage` remains a fallback if the server request
fails.

## Alignment Prototype

OpenAI speech generation does not currently return word timing metadata with
the MP3. The optional prototype uses the generated MP3 as input to OpenAI
speech-to-text with `whisper-1`, `response_format=verbose_json`, and
word-level timestamps. The reader consumes alignment JSON only when present and
falls back to ordinary article text otherwise.

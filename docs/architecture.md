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
5. On article approval, extract Pirate Wires through the saved Playwright
   profile, fetch public Substack HTML directly, or retrieve an X Article's
   structured `article` field and expanded author account through the official
   Post lookup API. Custom text entries skip extraction and create a story
   object directly from title/body.
6. Cache article art locally when available, synthesize MP3 audio through the
   selected TTS provider, and optionally write word-timing alignment JSON.
7. Write story JSON, text, MP3, cached image, and a library manifest.
8. Send a ready notification with a direct link to the generated article page.
9. Authenticate through Authentik OIDC and serve a Tailnet-only reader UI with a library view, article detail pages,
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
- `src/auth.ts`: OIDC state/nonce/PKCE, opaque sessions, cookies, and group checks.
- `src/database.ts`: numbered Postgres migrations and app-owned user state.
- `src/backlog.ts`: RSS queue status and async conversion queue helpers.
- `src/notifications.ts`: stable mobile action IDs.
- `src/haActions.ts`: Home Assistant WebSocket listener.
- `src/workflow.ts`: article decision handling.
- `src/assets.ts`: article image caching and asset content types.
- `src/alignment.ts`: optional OpenAI Whisper word-timing artifact writer.
- `src/tts/`: provider interface and OpenAI implementation.
- `src/library.ts`: durable manifest writer.
- `src/mediaPlayer.ts`: shared Shikwasa media player for library and article
  views, including metadata escaping, playback-progress wiring, and a Cast
  control that uses the audio element's Remote Playback API.
- `src/mediaPlayerCast.ts`: Cast button for Shikwasa's extra-controls menu.
  It stays hidden until Chrome reports a receiver. The player stays `fixed:
  static` so library pages do not pin every card to the viewport; width is
  constrained to the container so Shikwasa's own 640px layout and resize
  marquee can shrink on a phone.
- `src/progress.ts`: legacy JSON reader used only for cutover and rollback.
- `src/reader.ts`: library and article-page renderer with server-backed
  playback-position sync, plus the RSS queue page.

## Queue

The `/queue` list uses the current configured RSS feeds. `/queue.json` marks
articles as converted by comparing feed slugs/source URLs with the library
manifest, and marks in-flight conversions from service memory. Posting to
`/queue/convert/<slug>` records the feed article in pending state and starts the
existing `accept` workflow in the background.

The queue page also accepts pasted Pirate Wires, Hyperdimensional, and Substack
`/p/...` article URLs plus X `/<username>/status/<id>` Article URLs.
`POST /queue/convert-url` validates known article URL patterns, records a
minimal pending article, and starts the same background conversion workflow.
X extraction uses `GET /2/tweets/<id>?tweet.fields=article,author_id` with an
app-only bearer token; the expanded X account display name becomes the author,
with the handle as a fallback. It does not depend on X page markup or a browser
session.
Completion/failure still comes through the normal phone notifications.
`/backlog` routes remain compatibility aliases.

The same page accepts custom title/text entries. `POST /queue/convert-text`
validates the title/body, writes a generated story JSON/text file, synthesizes
audio, appends the item to the library manifest, and sends the normal ready or
failure notification. Custom text does not require Pirate Wires login.

## Identity and application data

Authentik proves identity; Pirate Radio keys users by immutable OIDC
`(issuer, subject)` and refreshes username, display name, email, and group
snapshots on login. Authentik groups grant coarse member/admin access. Internal
application user ids own progress and submissions, so email or username changes
cannot move rows. The user snapshot remains after an IdP account disappears so
historical attribution remains readable.

The header's repo-local account menu shows the current username and links to
Authentik's central profile editor. Logout revokes the Pirate Radio session and
continues through the provider's end-session endpoint; Pirate Radio does not
duplicate identity settings UI.

Postgres owns users, hashed sessions, one-time OIDC transactions, per-user
progress/completion, submissions, and migration receipts. One shared filesystem
library still owns MP3, story JSON/text, images, alignment, `index.json`, and
RSS `state.json`. `progress.json` is retained only as migration/rollback input.
Story JSON and `index.json` preserve an optional article author. Feed metadata
backs RSS conversions; pasted HTML uses page author metadata; missing authors
remain absent rather than displaying an unknown placeholder.

Administrators can remove an article from the active manifest from its article
page. Deletion first copies the generated files and a pre-delete manifest into
`trash/<timestamp>-<slug>/`; Postgres progress and submission history remain
untouched. This keeps the common action simple while leaving an operator
recovery path.

The browser may fall back to user-keyed `localStorage` if a progress read fails,
but normal cross-device state is `GET/PUT /progress/<slug>` in Postgres.

## Alignment Prototype

OpenAI speech generation does not currently return word timing metadata with
the MP3. The optional prototype uses the generated MP3 as input to OpenAI
speech-to-text with `whisper-1`, `response_format=verbose_json`, and
word-level timestamps. The reader consumes alignment JSON only when present and
falls back to ordinary article text otherwise.

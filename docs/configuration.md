# Configuration

The app reads configuration from environment variables.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SERVICE_PORT` | `8123` | HTTP service port. |
| `SERVICE_HOST` | falls back to `HOST_BIND_ADDR` | In-container/app bind address. Use `0.0.0.0` in Docker. |
| `HOST_BIND_ADDR` | `127.0.0.1` | HTTP bind address. |
| `PIRATE_RADIO_PUBLIC_URL` | local service URL | URL placed in notifications. |
| `PIRATE_RADIO_LIBRARY_DIR` | `output/library` | Durable text, JSON, audio, cached images, playback progress, optional alignment, and manifest root. |
| `PIRATE_RADIO_STATE_PATH` | `<library>/state.json` | Seen/pending/decision state file. |
| `PIRATE_RADIO_FEED_URL` | Substack RSS feed | Feed to poll. |
| `PIRATE_RADIO_POLL_INTERVAL_MS` | `900000` | Poll interval. |
| `PIRATE_RADIO_MAX_NOTIFICATIONS_PER_POLL` | `1` | Notification cap per poll. |
| `PIRATE_RADIO_ENABLE_ALIGNMENT` | `false` | Set to `true` to run the optional post-TTS Whisper word-timestamp prototype. |
| `PWR_HEADLESS` | unset | Set to `true` for Docker/headless Playwright. |
| `PWR_PROFILE_DIR` | `.playwright-profile` | Playwright browser profile path. Use a durable mounted path in Docker. |
| `OPENAI_API_KEY` | none | Required for approved TTS generation. |
| `HA_URL` | none | Home Assistant base URL. |
| `HA_LONG_LIVED_TOKEN` | none | Home Assistant WebSocket token. |
| `HOMELAB_FUNCTIONS_URL` | none | Notification broker URL. |
| `HOMELAB_FUNCTIONS_TOKEN` | none | Notification broker bearer token. |
| `PIRATE_RADIO_REAUTH_URL` | none | Tailnet-only login browser URL used in auth-required notifications. |

Deployment-specific Compose, Tailnet exposure, monitoring, and real secrets
belong in the private `homelab-config` repo.

# Configuration

The app reads configuration from environment variables.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SERVICE_PORT` | `8123` | HTTP service port. |
| `SERVICE_HOST` | falls back to `HOST_BIND_ADDR` | In-container/app bind address. Use `0.0.0.0` in Docker. |
| `HOST_BIND_ADDR` | `127.0.0.1` | HTTP bind address. |
| `PIRATE_RADIO_PUBLIC_URL` | local service URL | URL placed in notifications. |
| `PIRATE_RADIO_LIBRARY_DIR` | `output/library` | Durable text, JSON, audio, cached images, optional alignment, legacy progress, and manifest root. |
| `PIRATE_RADIO_STATE_PATH` | `<library>/state.json` | Seen/pending/decision state file. |
| `PIRATE_RADIO_FEED_URL` | Pirate Wires RSS feed | Legacy/simple single-feed override. If set without `PIRATE_RADIO_FEEDS`, only Pirate Wires is polled at this URL. |
| `PIRATE_RADIO_FEEDS` | Pirate Wires + Hyperdimensional | JSON array of `{ "id", "name", "type", "url" }` feed configs. `type` is `pirate-wires` or `substack`. |
| `PIRATE_RADIO_POLL_INTERVAL_MS` | `900000` | Poll interval. |
| `PIRATE_RADIO_MAX_NOTIFICATIONS_PER_POLL` | `1` | Notification cap per poll. |
| `PIRATE_RADIO_ENABLE_ALIGNMENT` | `false` | Set to `true` to run the optional post-TTS Whisper word-timestamp prototype. |
| `DATABASE_URL` | none | Required Postgres connection URL for application identity and per-user state. |
| `PIRATE_RADIO_OIDC_ISSUER` | none | Required exact Authentik provider issuer URL. |
| `PIRATE_RADIO_OIDC_CLIENT_ID` | none | Required OIDC client id. |
| `PIRATE_RADIO_OIDC_CLIENT_SECRET` | none | Required OIDC client secret. |
| `PIRATE_RADIO_OIDC_SCOPES` | `openid profile email groups` | OIDC scopes requested at login. |
| `PIRATE_RADIO_MEMBER_GROUP` | `pirate-radio-users` | Group required for all protected routes. |
| `PIRATE_RADIO_ADMIN_GROUP` | `pirate-radio-admins` | Group required for admin and maintenance routes. |
| `PIRATE_RADIO_SESSION_HOURS` | `24` | Fixed, non-rolling opaque session lifetime. |
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

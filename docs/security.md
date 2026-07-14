# Security

## Secrets

Do not commit real values for:

- `OPENAI_API_KEY`
- `HA_URL`
- `HA_LONG_LIVED_TOKEN`
- `HOMELAB_FUNCTIONS_TOKEN`
- `DATABASE_URL`
- `PIRATE_RADIO_OIDC_CLIENT_SECRET`
- Pirate Wires browser profile/session data

`.env`, `.env.*`, `.playwright-profile/`, `output/`, `dist/`, and
`node_modules/` are ignored.

Cached article images and alignment JSON are generated runtime artifacts and
belong under the ignored library/output directory, not in git.
When `PWR_PROFILE_DIR` points into `/data`, that profile directory contains
logged-in browser session material and must stay in the ignored runtime volume.

## Network Exposure

The container port is published to host loopback only. Caddy owns TLS, and the
friend path is a raw-TCP Tailscale Service forwarding 443 to Caddy so TLS SNI
still selects the correct virtual host. Do not restore a node-wide direct app
port mapping: that would bypass Caddy and the service-specific friend grant.

All reader, article, media, range, image, alignment, manifest, queue, progress,
submission, docs, admin, and simulation routes use the native application
session. Only health, login, and callback are unauthenticated. Forwarded user
headers are ignored.

## Identity and sessions

Authentik supplies OIDC identity and verified-email account linking. Pirate
Radio authorizes immutable issuer/subject pairs, not mutable email or username.
Authorization code uses PKCE, nonce, a browser-bound one-time state record, and
a ten-minute callback lifetime. Session tokens contain 256 random bits; only
SHA-256 hashes are stored. Cookies are host-only, `Secure`, `HttpOnly`,
`SameSite=Lax`, fixed at 24 hours, and revoked on logout.

Every state-changing route requires an `Origin` exactly matching
`PIRATE_RADIO_PUBLIC_URL`. Authentik groups provide coarse member/admin access;
Postgres application-user ids provide row ownership. Member users cannot read
or overwrite another user's playback position.

## Home Assistant Actions

The service only reacts to action IDs with the `PIRATE_RADIO_ACCEPT::` or
`PIRATE_RADIO_SKIP::` prefixes. Notification delivery can go through
homelab-functions, but the long-running action listener belongs to this service.

# Sign in and library

Sign in creates the `pirate_radio_session` cookie through the local dev issuer, and the library then lists the three seeded articles.

## Sub-features

- `auth-sign-in` follows `Sign in` through the dev issuer and lands on `/`.
- `auth-me` shows `demo.reader` as an admin member.
- `library-seed` shows the three seeded titles, with art on the feed articles and a placeholder on the custom text.
- `library-filter` limits the list to `Hyperdimensional`.

## How to get to it (user POV)

- Open `/` and choose `Sign in`.
- Open `/auth/login?returnTo=/` directly.
- Use the source filter labeled `Filter by source` on the library.
- Open the account menu labeled `Account menu for demo.reader`.

## Driving it with verify-pirate-radio

Preconditions:

- Doctor prints `doctor ok`.
- No browser is already signed in on a different host for this port. Use `http://localhost:<servicePort>` from the state file.

- **Sign in.** Open `/` and choose `Sign in`. Run `node .cursor/skills/verify-pirate-radio/drive.mjs auth`. The browser lands on `$PUBLIC_URL/` and the library replaces `Loading...`.
- **Session.** The script checks `GET /auth/me`. Status `200`. `username` is `demo.reader`, `isAdmin` is true, and `groups` includes `pirate-radio-users` and `pirate-radio-admins`. It writes `auth-me.json`.
- **Seeded cards.** The same run shows headings `The Quiet Return of the Generalist Engineer`, `Regulators Discover the Data Center`, and `Notes on Shipping Software That Reads Itself Aloud`. The first two cards use an image. The custom-text card uses the placeholder thumb. `library.png` shows all three.
- **Filter.** The script sets `Filter by source` to `Hyperdimensional` and requires the generalist heading to stay and the other two titles to leave. It then sets `All sources` and requires all three back.
- **Manifest.** `GET /library.json` with the session returns `200` and the same three slugs. The script writes `library.json`.

## Gotchas

- The cookie is `Secure` and host-only. Opening `http://127.0.0.1:<port>` drops it and `/auth/callback` fails with `invalid_oidc_callback`.
- The issuer certificate is self-signed. The drive sets `ignoreHTTPSErrors`. A browser that rejects the certificate never finishes sign-in.
- `demo.reader` is an admin on this issuer, so the `Admin` link is visible. Do not choose `Propose adapter PR`.
- `Log out` revokes the session. A later drive in the same browser then sees the sign-in page again. `drive.mjs` does not log out.
- The three titles are the fixture copy in `scripts/dev/seed-assets/articles.json`. If that file changes, update this map in the same change. The drive fails when the slugs differ.

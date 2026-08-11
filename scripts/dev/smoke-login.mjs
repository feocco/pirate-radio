// Non-interactive smoke test of the dev OAuth login flow (DEV/CLOUD ONLY).
//
// Drives the full authorization-code + PKCE handshake against the running
// `serve` and local OIDC issuer, asserting the transaction cookie round-trips
// and a protected route returns the authenticated user. This reproduces the
// exact origin/cookie path that fails as `invalid_oidc_callback` when hosts are
// mismatched, so it guards that regression. It also asserts the negative case
// (callback without the transaction cookie -> 400).
//
// Requires the stack running (scripts/dev/serve.sh + local-oidc.mjs) and
// PIRATE_RADIO_DEV_STACK=1. Run: node scripts/dev/smoke-login.mjs
import http from "node:http";
import https from "node:https";

if (process.env.PIRATE_RADIO_DEV_STACK !== "1" || process.env.NODE_ENV === "production") {
  console.error("[smoke] dev-only. Set PIRATE_RADIO_DEV_STACK=1 (see scripts/dev/env.sh).");
  process.exit(1);
}

const APP = (process.env.PIRATE_RADIO_PUBLIC_URL ?? "http://localhost:8123").replace(/\/$/, "");

function request(urlStr, { headers = {} } = {}) {
  const url = new URL(urlStr);
  const lib = url.protocol === "https:" ? https : http;
  const opts = { method: "GET", headers };
  if (url.protocol === "https:") opts.rejectUnauthorized = false; // self-signed dev issuer
  return new Promise((resolve, reject) => {
    const req = lib.request(url, opts, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

function cookie(setCookie, name) {
  for (const line of setCookie ?? []) {
    const first = line.split(";")[0];
    const eq = first.indexOf("=");
    if (first.slice(0, eq) === name) return first.slice(eq + 1);
  }
  return undefined;
}

let failures = 0;
function check(label, cond, detail = "") {
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function login() {
  const r1 = await request(`${APP}/auth/login`);
  const binding = cookie(r1.headers["set-cookie"], "pirate_radio_oidc");
  const authorizeUrl = r1.headers.location;
  const r2 = await request(authorizeUrl);
  const callbackUrl = r2.headers.location;
  return { binding, authorizeUrl, callbackUrl, r1, r2 };
}

async function main() {
  console.log(`[smoke] target ${APP}`);

  // Positive: full handshake with the transaction cookie present.
  const flow = await login();
  check("/auth/login returns 302 to the issuer authorize endpoint", flow.r1.status === 302 && /\/authorize\?/.test(flow.authorizeUrl || ""), flow.authorizeUrl);
  check("/auth/login sets the pirate_radio_oidc transaction cookie", Boolean(flow.binding));
  check("authorize redirects back to /auth/callback with a code", flow.r2.status === 302 && /\/auth\/callback\?/.test(flow.callbackUrl || "") && /[?&]code=/.test(flow.callbackUrl || ""), flow.callbackUrl);

  const cb = await request(flow.callbackUrl, { headers: { Cookie: `pirate_radio_oidc=${flow.binding}` } });
  const session = cookie(cb.headers["set-cookie"], "pirate_radio_session");
  check("/auth/callback (with cookie) returns 302 to returnTo", cb.status === 302, `status=${cb.status} body=${cb.body}`);
  check("/auth/callback sets a session cookie", Boolean(session));

  const me = await request(`${APP}/auth/me`, { headers: { Cookie: `pirate_radio_session=${session}` } });
  let identity = {};
  try { identity = JSON.parse(me.body); } catch { /* leave empty */ }
  check("/auth/me returns 200 for the session", me.status === 200, `status=${me.status}`);
  check("/auth/me reports an authenticated username", Boolean(identity.username), me.body);

  // Negative: the callback without the transaction cookie must fail closed.
  const flow2 = await login();
  const cbNoCookie = await request(flow2.callbackUrl);
  let err = {};
  try { err = JSON.parse(cbNoCookie.body); } catch { /* leave empty */ }
  check("/auth/callback WITHOUT cookie fails with invalid_oidc_callback", cbNoCookie.status === 400 && err.error === "invalid_oidc_callback", `status=${cbNoCookie.status} body=${cbNoCookie.body}`);

  console.log(failures === 0 ? "[smoke] OK — login flow healthy" : `[smoke] ${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();

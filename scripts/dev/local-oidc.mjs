// Local development OIDC provider for Cursor Cloud (and local) dev only.
//
// Pirate Radio's `serve` command requires an OpenID Connect issuer. Real
// deployments use Authentik; this stub lets a cloud agent (or a developer
// offline) exercise the full login + reader flow without a real IdP.
//
// SECURITY: dev-only. It auto-approves every authorize request and issues an
// admin identity. Never point a production/homelab deployment at this issuer.
//
// openid-client v6 rejects plaintext-HTTP issuers (localhost included), so this
// serves HTTPS with a self-signed cert generated on first run. The `serve`
// process must set NODE_TLS_REJECT_UNAUTHORIZED=0 to trust it (see env.sh).
import { createServer } from "node:https";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPair, exportJWK, SignJWT } from "jose";

// GUARDRAIL: this issuer auto-approves logins and mints an admin identity. It is
// only allowed in the dev stack, never in a real deployment.
if (process.env.PIRATE_RADIO_DEV_STACK !== "1" || process.env.NODE_ENV === "production") {
  console.error("[local-oidc] refusing to start: dev-only issuer. Set PIRATE_RADIO_DEV_STACK=1 and ensure NODE_ENV!=production (see scripts/dev/env.sh).");
  process.exit(1);
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOST = process.env.LOCAL_OIDC_HOST ?? "127.0.0.1";
const PORT = Number(process.env.LOCAL_OIDC_PORT ?? 9443);
const ISSUER = `https://${HOST}:${PORT}`;
const CLIENT_ID = process.env.LOCAL_OIDC_CLIENT_ID ?? process.env.PIRATE_RADIO_OIDC_CLIENT_ID ?? "pirate-radio-local";
const MEMBER_GROUP = process.env.PIRATE_RADIO_MEMBER_GROUP ?? "pirate-radio-users";
const ADMIN_GROUP = process.env.PIRATE_RADIO_ADMIN_GROUP ?? "pirate-radio-admins";
const SUBJECT = process.env.LOCAL_OIDC_SUBJECT ?? "demo-reader-subject";
const USERNAME = process.env.LOCAL_OIDC_USERNAME ?? "demo.reader";
const NAME = process.env.LOCAL_OIDC_NAME ?? "Demo Reader";
const EMAIL = process.env.LOCAL_OIDC_EMAIL ?? "demo.reader@example.com";

// GUARDRAIL: bind loopback only unless explicitly overridden, so the auto-approve
// issuer is never exposed off-box.
const LOOPBACK = HOST === "127.0.0.1" || HOST === "::1" || HOST === "localhost";
if (!LOOPBACK && process.env.LOCAL_OIDC_ALLOW_NONLOOPBACK !== "1") {
  console.error(`[local-oidc] refusing to bind non-loopback host "${HOST}". Set LOCAL_OIDC_ALLOW_NONLOOPBACK=1 to override (not recommended).`);
  process.exit(1);
}

const devDir = process.env.PIRATE_RADIO_DEV_DIR ?? "/tmp/pirate-radio-dev";
const keyPath = join(devDir, "oidc-key.pem");
const certPath = join(devDir, "oidc-cert.pem");

function ensureCert() {
  if (existsSync(keyPath) && existsSync(certPath)) return;
  mkdirSync(devDir, { recursive: true });
  // openssl rejects `IP:` entries that are not IP literals, so a DNS host such
  // as the default `localhost` has to be declared as `DNS:`.
  const isIpLiteral = /^[0-9.]+$/.test(HOST) || HOST.includes(":");
  const names = new Set([isIpLiteral ? `IP:${HOST}` : `DNS:${HOST}`, "DNS:localhost", "IP:127.0.0.1"]);
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyPath, "-out", certPath, "-days", "30",
    "-subj", `/CN=${HOST}`, "-addext", `subjectAltName=${[...names].join(",")}`,
  ], { stdio: "ignore" });
}

ensureCert();
const tlsKey = readFileSync(keyPath);
const tlsCert = readFileSync(certPath);

const { publicKey, privateKey } = await generateKeyPair("RS256");
const publicJwk = { ...(await exportJWK(publicKey)), kid: "sig1", use: "sig", alg: "RS256" };

let feedXml = "";
try {
  feedXml = readFileSync(join(repoRoot, "tests", "fixtures", "pirate-feed.xml"), "utf8");
} catch {
  feedXml = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Local</title></channel></rss>`;
}

const codes = new Map();

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

const server = createServer({ key: tlsKey, cert: tlsCert }, async (req, res) => {
  const url = new URL(req.url ?? "/", ISSUER);
  try {
    if (url.pathname === "/.well-known/openid-configuration") {
      return send(res, 200, { "content-type": "application/json" }, JSON.stringify({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks`,
        userinfo_endpoint: `${ISSUER}/userinfo`,
        end_session_endpoint: `${ISSUER}/endsession`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic", "none"],
        scopes_supported: ["openid", "profile", "email", "groups"],
        claims_supported: ["sub", "iss", "aud", "exp", "iat", "nonce", "email", "preferred_username", "name", "groups"],
      }));
    }
    if (url.pathname === "/jwks") {
      return send(res, 200, { "content-type": "application/json" }, JSON.stringify({ keys: [publicJwk] }));
    }
    if (url.pathname === "/authorize") {
      const redirectUri = url.searchParams.get("redirect_uri");
      if (!redirectUri) return send(res, 400, {}, "missing redirect_uri");
      const code = randomBytes(24).toString("base64url");
      codes.set(code, { nonce: url.searchParams.get("nonce") ?? "" });
      const location = new URL(redirectUri);
      location.searchParams.set("code", code);
      location.searchParams.set("state", url.searchParams.get("state") ?? "");
      return send(res, 302, { location: location.href }, "");
    }
    if (url.pathname === "/token" && req.method === "POST") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      const entry = codes.get(body.get("code") ?? "");
      codes.delete(body.get("code") ?? "");
      const now = Math.floor(Date.now() / 1000);
      const idToken = await new SignJWT({
        nonce: entry?.nonce ?? "",
        email: EMAIL,
        preferred_username: USERNAME,
        name: NAME,
        groups: [MEMBER_GROUP, ADMIN_GROUP],
      })
        .setProtectedHeader({ alg: "RS256", kid: "sig1" })
        .setIssuer(ISSUER)
        .setSubject(SUBJECT)
        .setAudience(CLIENT_ID)
        .setIssuedAt(now)
        .setExpirationTime(now + 3600)
        .sign(privateKey);
      return send(res, 200, { "content-type": "application/json", "cache-control": "no-store" }, JSON.stringify({
        access_token: randomBytes(24).toString("base64url"),
        id_token: idToken,
        token_type: "Bearer",
        expires_in: 3600,
        scope: "openid profile email groups",
      }));
    }
    if (url.pathname === "/userinfo") {
      return send(res, 200, { "content-type": "application/json" }, JSON.stringify({
        sub: SUBJECT, email: EMAIL, preferred_username: USERNAME, name: NAME,
        groups: [MEMBER_GROUP, ADMIN_GROUP],
      }));
    }
    if (url.pathname === "/endsession") {
      return send(res, 302, { location: url.searchParams.get("post_logout_redirect_uri") ?? `${ISSUER}/` }, "");
    }
    if (url.pathname === "/feed.xml") {
      return send(res, 200, { "content-type": "application/rss+xml" }, feedXml);
    }
    return send(res, 404, {}, "not found");
  } catch (error) {
    console.error("[local-oidc] error", error);
    if (!res.headersSent) send(res, 500, {}, "error");
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[local-oidc] dev issuer ${ISSUER} (client ${CLIENT_ID}, user ${USERNAME})`);
});

// Dev/QA-only `node --import` preload for the reader QA harness.
//
// It wraps the global fetch of the process it is loaded into (the real built
// `serve`) so the harness can run the full submit -> extract -> TTS -> reader
// flow with no external network and no real xAI key:
//
//   - origins listed in PIRATE_RADIO_QA_ROUTES (JSON: {"https://api.x.ai":
//     "http://127.0.0.1:PORT"}) are rewritten to their loopback target, keeping
//     path, query, method, headers, and body;
//   - loopback requests (local OIDC issuer, fixture feed) pass through;
//   - every other request fails before it reaches the network.
//
// GUARDRAIL: refuses to load unless PIRATE_RADIO_DEV_STACK=1 and NODE_ENV is not
// "production", and every route target must be loopback, so it can never
// redirect a real deployment's traffic or credentials off-box.

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function refuse(message) {
  console.error(`[qa-network] refusing to load: ${message}`);
  process.exit(1);
}

if (process.env.PIRATE_RADIO_DEV_STACK !== "1" || process.env.NODE_ENV === "production") {
  refuse("dev/QA-only preload. Set PIRATE_RADIO_DEV_STACK=1 and ensure NODE_ENV!=production.");
}

function isLoopback(url) {
  return LOOPBACK_HOSTS.has(url.hostname);
}

function parseRoutes(value) {
  let parsed;
  try {
    parsed = JSON.parse(value ?? "{}");
  } catch {
    refuse("PIRATE_RADIO_QA_ROUTES must be a JSON object of origin -> loopback origin.");
  }
  const routes = new Map();
  for (const [from, to] of Object.entries(parsed)) {
    const target = new URL(to);
    if (!isLoopback(target)) refuse(`route ${from} -> ${to} must target loopback.`);
    routes.set(new URL(from).origin, target.origin);
  }
  return routes;
}

const routes = parseRoutes(process.env.PIRATE_RADIO_QA_ROUTES);
const realFetch = globalThis.fetch;

globalThis.fetch = function qaFetch(input, init) {
  const original = new URL(input instanceof Request ? input.url : String(input));
  const target = routes.get(original.origin);
  if (target) {
    const rewritten = `${target}${original.pathname}${original.search}`;
    return realFetch(input instanceof Request ? new Request(rewritten, input) : rewritten, init);
  }
  if (isLoopback(original)) return realFetch(input, init);
  console.error(`[qa-network] blocked ${original.href}`);
  return Promise.reject(new TypeError(`[qa-network] blocked external request to ${original.href}`));
};

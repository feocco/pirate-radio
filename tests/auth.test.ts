import { createServer } from "node:http";
import { describe, expect, test, vi } from "vitest";
import { ForbiddenIdentityError, OIDC_COOKIE, OidcAuthenticator, identityFromClaims, parseCookies, type OidcProtocol } from "../src/auth.js";
import type { PirateRadioConfig } from "../src/config.js";
import { createPirateRadioRequestHandler } from "../src/server.js";
import { MemoryStore } from "./support/fakes.js";

const config: PirateRadioConfig = {
  port: 8123,
  host: "127.0.0.1",
  publicBaseUrl: "https://pirate-radio.example.com",
  libraryDir: "/tmp/library",
  statePath: "/tmp/state.json",
  pollIntervalMs: 60_000,
  maxNotificationsPerPoll: 1,
  feedUrl: "https://example.com/feed.xml",
  feeds: [{ id: "test", name: "Test", type: "substack", url: "https://example.com/feed.xml" }],
  enableAlignment: false,
  databaseUrl: "postgres://example",
  oidcIssuer: "https://auth.example/application/o/pirate-radio/",
  oidcClientId: "client-id",
  oidcClientSecret: "client-secret",
  oidcScopes: "openid profile email groups",
  memberGroup: "pirate-radio-users",
  adminGroup: "pirate-radio-admins",
  sessionLifetimeHours: 24,
};

class TestProtocol implements OidcProtocol {
  parameters?: Record<string, string>;
  endSessionParameters?: Record<string, string>;
  checks?: { codeVerifier: string; state: string; nonce: string };
  claims: Record<string, unknown> = {
    iss: config.oidcIssuer,
    sub: "subject-1",
    preferred_username: "friend",
    name: "Friendly User",
    email: "friend@example.com",
    groups: ["pirate-radio-users"],
  };
  initialize = vi.fn(async () => {});
  authorizationUrl(parameters: Record<string, string>): string {
    this.parameters = parameters;
    return `https://auth.example/authorize?state=${parameters.state}`;
  }
  endSessionUrl(parameters: Record<string, string>): string {
    this.endSessionParameters = parameters;
    return "https://auth.example/end-session";
  }
  async exchange(_url: URL, checks: { codeVerifier: string; state: string; nonce: string }): Promise<Record<string, unknown>> {
    this.checks = checks;
    return this.claims;
  }
}

describe("OIDC application sessions", () => {
  test("normalizes duplicate group claims", () => {
    expect(identityFromClaims({
      iss: config.oidcIssuer,
      sub: "subject-1",
      email: "friend@example.com",
      groups: ["pirate-radio-users", "pirate-radio-admins", "pirate-radio-users"],
    }).groups).toEqual(["pirate-radio-users", "pirate-radio-admins"]);
  });

  test("stores state, nonce, PKCE, binds the browser, and replays a successful callback", async () => {
    const store = new MemoryStore();
    const protocol = new TestProtocol();
    const auth = new OidcAuthenticator(config, store, protocol);
    await auth.initialize();

    const login = await auth.login(new URL("https://pirate-radio.example.com/auth/login?returnTo=/queue"));
    const transaction = [...store.transactions.values()][0];
    expect(transaction).toMatchObject({ returnTo: "/queue" });
    expect(protocol.parameters).toMatchObject({
      state: transaction.state,
      nonce: transaction.nonce,
      code_challenge_method: "S256",
      redirect_uri: "https://pirate-radio.example.com/auth/callback",
    });
    expect(protocol.parameters?.code_challenge).not.toBe(transaction.codeVerifier);

    const binding = parseCookies(login.transactionCookie)[OIDC_COOKIE];
    const callbackUrl = new URL(`https://pirate-radio.example.com/auth/callback?code=test&state=${transaction.state}`);
    const result = await auth.callback(callbackUrl, `${OIDC_COOKIE}=${binding}`);
    expect(protocol.checks).toEqual({ codeVerifier: transaction.codeVerifier, state: transaction.state, nonce: transaction.nonce });
    expect(result.returnTo).toBe("/queue");
    expect(result.sessionCookie).toContain("Secure; HttpOnly; SameSite=Lax");
    expect(result.sessionCookie).not.toContain("Domain=");
    const replay = await auth.callback(callbackUrl, `${OIDC_COOKIE}=${binding}`);
    expect(replay.sessionCookie).toBe(result.sessionCookie);
    expect(store.sessions.size).toBe(1);
  });

  test("retries an in-flight callback instead of consuming the transaction twice", async () => {
    const store = new MemoryStore();
    const protocol = new TestProtocol();
    let exchanges = 0;
    let releaseExchange!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseExchange = resolve;
    });
    protocol.exchange = async (url, checks) => {
      exchanges += 1;
      protocol.checks = checks;
      await blocked;
      return protocol.claims;
    };
    const auth = new OidcAuthenticator(config, store, protocol);
    await auth.initialize();
    const login = await auth.login(new URL("https://pirate-radio.example.com/auth/login?returnTo=/queue"));
    const transaction = [...store.transactions.values()][0];
    const binding = parseCookies(login.transactionCookie)[OIDC_COOKIE];
    const callbackUrl = new URL(`https://pirate-radio.example.com/auth/callback?code=test&state=${transaction.state}`);
    const cookieHeader = `${OIDC_COOKIE}=${binding}`;

    const first = auth.callback(callbackUrl, cookieHeader);
    const second = auth.callback(callbackUrl, cookieHeader);
    releaseExchange();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(exchanges).toBe(1);
    expect(firstResult.sessionCookie).toBe(secondResult.sessionCookie);
    expect(store.sessions.size).toBe(1);
  });

  test("restores the OIDC transaction when token exchange fails so login can retry", async () => {
    const store = new MemoryStore();
    const protocol = new TestProtocol();
    const auth = new OidcAuthenticator(config, store, protocol);
    await auth.initialize();
    const login = await auth.login(new URL("https://pirate-radio.example.com/auth/login?returnTo=/queue"));
    const transaction = [...store.transactions.values()][0];
    const binding = parseCookies(login.transactionCookie)[OIDC_COOKIE];
    const callbackUrl = new URL(`https://pirate-radio.example.com/auth/callback?code=test&state=${transaction.state}`);
    const originalExchange = protocol.exchange.bind(protocol);
    protocol.exchange = async () => {
      throw new Error("upstream 502");
    };

    await expect(auth.callback(callbackUrl, `${OIDC_COOKIE}=${binding}`)).rejects.toThrow(/upstream 502/);
    expect(store.transactions.has(transaction.state)).toBe(true);

    protocol.exchange = originalExchange;
    const result = await auth.callback(callbackUrl, `${OIDC_COOKIE}=${binding}`);
    expect(result.returnTo).toBe("/queue");
    expect((await auth.authenticate(result.sessionCookie.split(";", 1)[0]))?.user.username).toBe("friend");
  });

  test("rejects expired transactions and identities without the member group", async () => {
    const store = new MemoryStore();
    const protocol = new TestProtocol();
    const auth = new OidcAuthenticator(config, store, protocol);
    await auth.initialize();
    const login = await auth.login(new URL("https://pirate-radio.example.com/auth/login"));
    const transaction = [...store.transactions.values()][0];
    transaction.expiresAt = new Date(0);
    const binding = parseCookies(login.transactionCookie)[OIDC_COOKIE];
    await expect(auth.callback(new URL(`https://pirate-radio.example.com/auth/callback?code=x&state=${transaction.state}`), `${OIDC_COOKIE}=${binding}`)).rejects.toThrow(/expired/);

    const second = await auth.login(new URL("https://pirate-radio.example.com/auth/login"));
    const active = [...store.transactions.values()].find((value) => value.expiresAt > new Date())!;
    protocol.claims.groups = [];
    const forbiddenUrl = new URL(`https://pirate-radio.example.com/auth/callback?code=x&state=${active.state}`);
    const forbiddenCookie = `${OIDC_COOKIE}=${parseCookies(second.transactionCookie)[OIDC_COOKIE]}`;
    await expect(auth.callback(forbiddenUrl, forbiddenCookie)).rejects.toBeInstanceOf(ForbiddenIdentityError);
    await expect(auth.callback(forbiddenUrl, forbiddenCookie)).rejects.toThrow(/already used/);
  });

  test("stores only hashed session tokens and revokes logout", async () => {
    const store = new MemoryStore();
    const protocol = new TestProtocol();
    const auth = new OidcAuthenticator(config, store, protocol);
    await auth.initialize();
    const login = await auth.login(new URL("https://pirate-radio.example.com/auth/login"));
    const transaction = [...store.transactions.values()][0];
    const callback = await auth.callback(new URL(`https://pirate-radio.example.com/auth/callback?code=x&state=${transaction.state}`), `${OIDC_COOKIE}=${parseCookies(login.transactionCookie)[OIDC_COOKIE]}`);
    const cookiePair = callback.sessionCookie.split(";", 1)[0];
    const rawToken = cookiePair.split("=")[1];
    expect(store.sessions.has(rawToken)).toBe(false);
    expect((await auth.authenticate(cookiePair))?.user.username).toBe("friend");
    const logout = await auth.logout(cookiePair);
    expect(logout.sessionCookie).toContain("Max-Age=0");
    expect(logout.location).toBe("https://auth.example/end-session");
    expect(protocol.endSessionParameters).toEqual({});
    expect(await auth.authenticate(cookiePair)).toBeUndefined();
  });

  test("rejects an expired fixed-lifetime session without renewing it", async () => {
    const store = new MemoryStore();
    const protocol = new TestProtocol();
    const auth = new OidcAuthenticator(config, store, protocol);
    await auth.initialize();
    const login = await auth.login(new URL("https://pirate-radio.example.com/auth/login"));
    const transaction = [...store.transactions.values()][0];
    const callback = await auth.callback(
      new URL(`https://pirate-radio.example.com/auth/callback?code=x&state=${transaction.state}`),
      `${OIDC_COOKIE}=${parseCookies(login.transactionCookie)[OIDC_COOKIE]}`,
    );
    const cookiePair = callback.sessionCookie.split(";", 1)[0];
    const session = [...store.sessions.values()][0];
    session.expiresAt = new Date(0);
    expect(await auth.authenticate(cookiePair)).toBeUndefined();
  });

  test("HTTP callback retries under load share one session and split Set-Cookie headers", async () => {
    const store = new MemoryStore();
    const protocol = new TestProtocol();
    let exchanges = 0;
    let releaseExchange!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseExchange = resolve;
    });
    protocol.exchange = async (_url, checks) => {
      exchanges += 1;
      protocol.checks = checks;
      await blocked;
      return protocol.claims;
    };
    const auth = new OidcAuthenticator(config, store, protocol);
    await auth.initialize();
    const login = await auth.login(new URL("https://pirate-radio.example.com/auth/login?returnTo=/queue"));
    const transaction = [...store.transactions.values()][0];
    const binding = parseCookies(login.transactionCookie)[OIDC_COOKIE];
    const handler = createPirateRadioRequestHandler({ config, store, authenticator: auth });
    const server = createServer((request, response) => void handler(request, response));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing address");
    const callbackUrl = `http://127.0.0.1:${address.port}/auth/callback?code=test&state=${transaction.state}`;
    try {
      const first = fetch(callbackUrl, { redirect: "manual", headers: { cookie: `${OIDC_COOKIE}=${binding}` } });
      const second = fetch(callbackUrl, { redirect: "manual", headers: { cookie: `${OIDC_COOKIE}=${binding}` } });
      releaseExchange();
      const [firstResponse, secondResponse] = await Promise.all([first, second]);
      expect(firstResponse.status).toBe(302);
      expect(secondResponse.status).toBe(302);
      expect(exchanges).toBe(1);
      const firstCookies = firstResponse.headers.getSetCookie();
      expect(firstCookies).toHaveLength(2);
      expect(firstCookies.some((value) => value.startsWith("pirate_radio_session="))).toBe(true);
      expect(firstCookies.some((value) => value.startsWith(`${OIDC_COOKIE}=`))).toBe(true);
      expect(secondResponse.headers.getSetCookie()).toEqual(firstCookies);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

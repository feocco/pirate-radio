import { describe, expect, test, vi } from "vitest";
import { ForbiddenIdentityError, OIDC_COOKIE, OidcAuthenticator, parseCookies, type OidcProtocol } from "../src/auth.js";
import type { PirateRadioConfig } from "../src/config.js";
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
  async exchange(_url: URL, checks: { codeVerifier: string; state: string; nonce: string }): Promise<Record<string, unknown>> {
    this.checks = checks;
    return this.claims;
  }
}

describe("OIDC application sessions", () => {
  test("stores state, nonce, PKCE, binds the browser, and rejects callback replay", async () => {
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
    await expect(auth.callback(callbackUrl, `${OIDC_COOKIE}=${binding}`)).rejects.toThrow(/already used/);
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
    await expect(auth.callback(new URL(`https://pirate-radio.example.com/auth/callback?code=x&state=${active.state}`), `${OIDC_COOKIE}=${parseCookies(second.transactionCookie)[OIDC_COOKIE]}`)).rejects.toBeInstanceOf(ForbiddenIdentityError);
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
    await auth.logout(cookiePair);
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
});

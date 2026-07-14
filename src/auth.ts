import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as oidc from "openid-client";
import type { PirateRadioConfig } from "./config.js";
import type { PirateRadioStore } from "./database.js";
import type { ApplicationUser, OidcIdentitySnapshot } from "./identity.js";

export const SESSION_COOKIE = "pirate_radio_session";
export const OIDC_COOKIE = "pirate_radio_oidc";

export interface AuthenticatedRequest {
  user: ApplicationUser;
  isAdmin: boolean;
}

export interface CallbackResult {
  sessionCookie: string;
  transactionCookie: string;
  returnTo: string;
  user: ApplicationUser;
}

export interface Authenticator {
  initialize(): Promise<void>;
  login(requestUrl: URL): Promise<{ location: string; transactionCookie: string }>;
  callback(requestUrl: URL, cookieHeader: string | undefined): Promise<CallbackResult>;
  authenticate(cookieHeader: string | undefined): Promise<AuthenticatedRequest | undefined>;
  logout(cookieHeader: string | undefined): Promise<string>;
}

export interface OidcProtocol {
  initialize(input: { issuer: string; clientId: string; clientSecret: string }): Promise<void>;
  authorizationUrl(parameters: Record<string, string>): string;
  exchange(requestUrl: URL, checks: { codeVerifier: string; state: string; nonce: string }): Promise<Record<string, unknown>>;
}

class OpenIdClientProtocol implements OidcProtocol {
  private configuration?: oidc.Configuration;

  async initialize(input: { issuer: string; clientId: string; clientSecret: string }): Promise<void> {
    this.configuration = await oidc.discovery(new URL(input.issuer), input.clientId, input.clientSecret);
  }

  authorizationUrl(parameters: Record<string, string>): string {
    return oidc.buildAuthorizationUrl(this.requiredConfiguration(), parameters).href;
  }

  async exchange(requestUrl: URL, checks: { codeVerifier: string; state: string; nonce: string }): Promise<Record<string, unknown>> {
    const tokens = await oidc.authorizationCodeGrant(this.requiredConfiguration(), requestUrl, {
      pkceCodeVerifier: checks.codeVerifier,
      expectedState: checks.state,
      expectedNonce: checks.nonce,
      idTokenExpected: true,
    });
    const claims = tokens.claims();
    if (!claims) throw new Error("OIDC response did not include an ID token.");
    return claims as Record<string, unknown>;
  }

  private requiredConfiguration(): oidc.Configuration {
    if (!this.configuration) throw new Error("OIDC protocol has not been initialized.");
    return this.configuration;
  }
}

export class OidcAuthenticator implements Authenticator {
  constructor(
    private readonly config: PirateRadioConfig,
    private readonly store: PirateRadioStore,
    private readonly protocol: OidcProtocol = new OpenIdClientProtocol(),
  ) {}

  async initialize(): Promise<void> {
    await this.protocol.initialize({
      issuer: this.required(this.config.oidcIssuer, "PIRATE_RADIO_OIDC_ISSUER"),
      clientId: this.required(this.config.oidcClientId, "PIRATE_RADIO_OIDC_CLIENT_ID"),
      clientSecret: this.required(this.config.oidcClientSecret, "PIRATE_RADIO_OIDC_CLIENT_SECRET"),
    });
  }

  async login(requestUrl: URL): Promise<{ location: string; transactionCookie: string }> {
    const state = randomToken();
    const nonce = randomToken();
    const browserBinding = randomToken();
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
    const returnTo = safeReturnTo(requestUrl.searchParams.get("returnTo"));
    await this.store.createOidcTransaction({
      state,
      nonce,
      codeVerifier,
      browserBindingHash: hashToken(browserBinding),
      returnTo,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    const location = this.protocol.authorizationUrl({
      redirect_uri: `${this.baseUrl()}/auth/callback`,
      scope: this.config.oidcScopes,
      response_type: "code",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state,
      nonce,
    });
    return {
      location,
      transactionCookie: cookie(OIDC_COOKIE, browserBinding, 600),
    };
  }

  async callback(requestUrl: URL, cookieHeader: string | undefined): Promise<CallbackResult> {
    const state = requestUrl.searchParams.get("state");
    const binding = parseCookies(cookieHeader)[OIDC_COOKIE];
    if (!state || !binding) throw new Error("Missing OIDC transaction state.");
    const transaction = await this.store.consumeOidcTransaction(state, hashToken(binding));
    if (!transaction) throw new Error("OIDC transaction is expired, invalid, or already used.");
    const claims = await this.protocol.exchange(requestUrl, {
      codeVerifier: transaction.codeVerifier,
      state: transaction.state,
      nonce: transaction.nonce,
    });
    if (!claims?.sub || !claims.iss) throw new Error("OIDC response did not include issuer and subject.");
    const identity = identityFromClaims(claims as Record<string, unknown>);
    if (!identity.groups.includes(this.config.memberGroup)) throw new ForbiddenIdentityError();
    const user = await this.store.upsertUser(identity);
    const sessionToken = randomToken();
    const lifetimeSeconds = Math.floor(this.config.sessionLifetimeHours * 60 * 60);
    await this.store.createSession(hashToken(sessionToken), user.id, new Date(Date.now() + lifetimeSeconds * 1000));
    return {
      sessionCookie: cookie(SESSION_COOKIE, sessionToken, lifetimeSeconds),
      transactionCookie: clearCookie(OIDC_COOKIE),
      returnTo: transaction.returnTo,
      user,
    };
  }

  async authenticate(cookieHeader: string | undefined): Promise<AuthenticatedRequest | undefined> {
    const token = parseCookies(cookieHeader)[SESSION_COOKIE];
    if (!token) return undefined;
    const user = await this.store.sessionUser(hashToken(token));
    if (!user || !user.groups.includes(this.config.memberGroup)) return undefined;
    return { user, isAdmin: user.groups.includes(this.config.adminGroup) };
  }

  async logout(cookieHeader: string | undefined): Promise<string> {
    const token = parseCookies(cookieHeader)[SESSION_COOKIE];
    if (token) await this.store.revokeSession(hashToken(token));
    return clearCookie(SESSION_COOKIE);
  }

  private baseUrl(): string {
    return this.config.publicBaseUrl.replace(/\/$/, "");
  }

  private required(value: string | undefined, name: string): string {
    if (!value) throw new Error(`Missing ${name}.`);
    return value;
  }
}

export class ForbiddenIdentityError extends Error {
  constructor() {
    super("Identity is not a Pirate Radio member.");
  }
}

export function identityFromClaims(claims: Record<string, unknown>): OidcIdentitySnapshot {
  const issuer = stringClaim(claims.iss, "iss");
  const subject = stringClaim(claims.sub, "sub");
  const email = stringClaim(claims.email, "email");
  const username = String(claims.preferred_username ?? claims.nickname ?? email.split("@")[0]);
  const displayName = String(claims.name ?? username);
  const groups = Array.isArray(claims.groups) ? [...new Set(claims.groups.map(String))] : [];
  return { issuer, subject, email, username, displayName, groups };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

export function parseCookies(header: string | undefined): Record<string, string> {
  return Object.fromEntries(
    (header ?? "").split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
      const index = part.indexOf("=");
      return index < 0 ? [part, ""] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
    }),
  );
}

export function originAllowed(request: IncomingMessage, publicBaseUrl: string): boolean {
  if (!request.method || !["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return true;
  const origin = request.headers.origin;
  return typeof origin === "string" && origin === new URL(publicBaseUrl).origin;
}

export function sendAuthenticationRequired(response: ServerResponse, request?: IncomingMessage): void {
  if (request?.method === "GET" && request.headers.accept?.includes("text/html")) {
    const returnTo = request.url?.startsWith("/") ? request.url : "/";
    response.writeHead(401, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Sign in - Pirate Radio</title></head><body><main><h1>Pirate Radio</h1><p>Sign in with Feocco Home to continue.</p><a href="/auth/login?returnTo=${encodeURIComponent(returnTo ?? "/")}">Sign in</a></main></body></html>`);
    return;
  }
  response.writeHead(401, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(`${JSON.stringify({ error: "authentication_required", login: "/auth/login" })}\n`);
}

function identityCookieAttributes(maxAge: number): string {
  return `Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`;
}

function cookie(name: string, value: string, maxAge: number): string {
  return `${name}=${encodeURIComponent(value)}; ${identityCookieAttributes(maxAge)}`;
}

function clearCookie(name: string): string {
  return `${name}=; ${identityCookieAttributes(0)}`;
}

function safeReturnTo(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}

function stringClaim(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new Error(`OIDC claim ${name} is missing.`);
  return value;
}

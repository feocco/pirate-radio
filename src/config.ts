import { DEFAULT_FEEDS, type ArticleFeedConfig } from "./feed.js";

export interface PirateRadioConfig {
  port: number;
  host: string;
  publicBaseUrl: string;
  libraryDir: string;
  statePath: string;
  pollIntervalMs: number;
  maxNotificationsPerPoll: number;
  feedUrl: string;
  feeds: ArticleFeedConfig[];
  homelabFunctionsUrl?: string;
  homelabFunctionsToken?: string;
  haUrl?: string;
  haLongLivedToken?: string;
  reauthUrl?: string;
  enableAlignment: boolean;
  databaseUrl?: string;
  oidcIssuer?: string;
  oidcClientId?: string;
  oidcClientSecret?: string;
  oidcScopes: string;
  memberGroup: string;
  adminGroup: string;
  sessionLifetimeHours: number;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): PirateRadioConfig {
  const libraryDir = env.PIRATE_RADIO_LIBRARY_DIR ?? "output/library";
  const feedUrl = env.PIRATE_RADIO_FEED_URL ?? DEFAULT_FEEDS[0].url;
  const feeds = parseFeeds(env.PIRATE_RADIO_FEEDS) ?? (
    env.PIRATE_RADIO_FEED_URL
      ? [{ ...DEFAULT_FEEDS[0], url: feedUrl }]
      : DEFAULT_FEEDS
  );
  return {
    port: Number(env.SERVICE_PORT ?? env.PORT ?? 8123),
    host: env.SERVICE_HOST ?? env.HOST_BIND_ADDR ?? "127.0.0.1",
    publicBaseUrl: env.PIRATE_RADIO_PUBLIC_URL ?? `http://127.0.0.1:${env.SERVICE_PORT ?? 8123}`,
    libraryDir,
    statePath: env.PIRATE_RADIO_STATE_PATH ?? `${libraryDir}/state.json`,
    pollIntervalMs: Number(env.PIRATE_RADIO_POLL_INTERVAL_MS ?? 15 * 60 * 1000),
    maxNotificationsPerPoll: Number(env.PIRATE_RADIO_MAX_NOTIFICATIONS_PER_POLL ?? 1),
    feedUrl,
    feeds,
    homelabFunctionsUrl: env.HOMELAB_FUNCTIONS_URL,
    homelabFunctionsToken: env.HOMELAB_FUNCTIONS_TOKEN,
    haUrl: env.HA_URL,
    haLongLivedToken: env.HA_LONG_LIVED_TOKEN,
    reauthUrl: env.PIRATE_RADIO_REAUTH_URL,
    enableAlignment: env.PIRATE_RADIO_ENABLE_ALIGNMENT === "true",
    databaseUrl: env.DATABASE_URL,
    oidcIssuer: env.PIRATE_RADIO_OIDC_ISSUER,
    oidcClientId: env.PIRATE_RADIO_OIDC_CLIENT_ID,
    oidcClientSecret: env.PIRATE_RADIO_OIDC_CLIENT_SECRET,
    oidcScopes: env.PIRATE_RADIO_OIDC_SCOPES ?? "openid profile email groups",
    memberGroup: env.PIRATE_RADIO_MEMBER_GROUP ?? "pirate-radio-users",
    adminGroup: env.PIRATE_RADIO_ADMIN_GROUP ?? "pirate-radio-admins",
    sessionLifetimeHours: Number(env.PIRATE_RADIO_SESSION_HOURS ?? 24),
  };
}

export function validateIdentityConfig(config: PirateRadioConfig): void {
  const missing = [
    ["DATABASE_URL", config.databaseUrl],
    ["PIRATE_RADIO_OIDC_ISSUER", config.oidcIssuer],
    ["PIRATE_RADIO_OIDC_CLIENT_ID", config.oidcClientId],
    ["PIRATE_RADIO_OIDC_CLIENT_SECRET", config.oidcClientSecret],
  ].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`Missing required identity configuration: ${missing.join(", ")}`);
  }
  if (!Number.isFinite(config.sessionLifetimeHours) || config.sessionLifetimeHours <= 0) {
    throw new Error("PIRATE_RADIO_SESSION_HOURS must be a positive number.");
  }
}

function parseFeeds(value: string | undefined): ArticleFeedConfig[] | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = JSON.parse(value) as ArticleFeedConfig[];
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("PIRATE_RADIO_FEEDS must be a non-empty JSON array.");
  }
  return parsed.map((feed) => ({
    id: String(feed.id),
    name: String(feed.name),
    type: feed.type === "pirate-wires" ? "pirate-wires" : "substack",
    url: String(feed.url),
  }));
}

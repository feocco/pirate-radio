export const WSJ_SOURCE_NAME = "WSJ";

const WSJ_HOSTNAMES = new Set(["wsj.com", "www.wsj.com"]);
const REJECTED_FIRST_SEGMENTS = new Set([
  "video",
  "livecoverage",
  "watchlist",
  "podcasts",
  "graphics",
  "market-data",
]);
const WSJ_SESSION_COOKIE_NAMES = new Set([
  "djcs_session",
  "usr_prof_v3",
  "usr_prof",
  "id_token",
]);
const WSJ_LOGGED_IN_PATTERN = /\blog\s*out\b|\bsign\s*out\b|customer center/i;
const WSJ_PAYWALL_PATTERN =
  /already a subscriber|subscribe to continue|this article is for subscribers|sign in to (?:read|wsj)/i;

export interface WsjArticleUrl {
  canonicalUrl: string;
  slug: string;
}

export interface WsjAccessInput {
  pageText: string;
  articleWordCount: number;
  profileDir: string;
  cookies?: Array<{ name: string }>;
}

export class WsjAuthRequiredError extends Error {
  constructor(profileDir: string) {
    super(`WSJ login required for ${profileDir}`);
    this.name = "WsjAuthRequiredError";
  }
}

export function isWsjHostname(hostname: string): boolean {
  return WSJ_HOSTNAMES.has(hostname.toLowerCase());
}

export function parseWsjArticleUrl(url: URL): WsjArticleUrl | undefined {
  if (!isWsjHostname(url.hostname)) {
    return undefined;
  }

  const parts = url.pathname.split("/").filter(Boolean).map((part) => part.replace(/\.html?$/i, ""));
  if (parts.length < 2) {
    return undefined;
  }

  const first = (parts[0] ?? "").toLowerCase();
  if (REJECTED_FIRST_SEGMENTS.has(first)) {
    return undefined;
  }

  const last = parts[parts.length - 1] ?? "";
  const classicArticlesPath = first === "articles" && last.length > 0;
  if (!classicArticlesPath && !isWsjArticleSlug(last)) {
    return undefined;
  }

  const canonical = new URL(`https://www.wsj.com/${parts.join("/")}`);
  return { canonicalUrl: canonical.toString(), slug: last.toLowerCase() };
}

export function titleFromWsjSlug(slug: string): string {
  const withoutId = slug.replace(/-[0-9a-f]{8}$/i, "").replace(/-[0-9]{6,}$/, "");
  const title = withoutId
    .split("-")
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
  return title || "WSJ Article";
}

export function validateWsjAccess(input: WsjAccessInput): void {
  if (!hasWsjSession(input)) {
    throw new WsjAuthRequiredError(input.profileDir);
  }
  if (input.articleWordCount === 0) {
    throw new Error("WSJ article loaded without readable story text.");
  }
  if (WSJ_PAYWALL_PATTERN.test(input.pageText) && input.articleWordCount < 250) {
    throw new WsjAuthRequiredError(input.profileDir);
  }
}

function hasWsjSession(input: WsjAccessInput): boolean {
  const hasSessionCookie = (input.cookies ?? []).some((cookie) => WSJ_SESSION_COOKIE_NAMES.has(cookie.name));
  return hasSessionCookie || WSJ_LOGGED_IN_PATTERN.test(input.pageText);
}

function isWsjArticleSlug(segment: string): boolean {
  return /-[0-9a-f]{8}$/i.test(segment) || /-[0-9]{6,}$/.test(segment) || /^SB\d{10,}$/i.test(segment);
}

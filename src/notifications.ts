import type { PirateArticle } from "./feed.js";
import type { LibraryItem } from "./library.js";
import { slugFromUrl } from "./slug.js";

export type PirateRadioDecision = "accept" | "skip";

export interface NotificationButton {
  title: string;
  action: string;
  uri?: string;
}

export interface ArticleNotification {
  title: string;
  message: string;
  tag: string;
  group: string;
  url?: string;
  buttons: NotificationButton[];
}

export interface ParsedPirateRadioAction {
  decision: PirateRadioDecision;
  slug: string;
}

const ACCEPT_PREFIX = "PIRATE_RADIO_ACCEPT::";
const SKIP_PREFIX = "PIRATE_RADIO_SKIP::";

export function buildArticleNotification(
  article: PirateArticle,
  readerBaseUrl?: string,
): ArticleNotification {
  const slug = article.slug ?? slugFromUrl(article.url);
  return {
    title: "Pirate Radio",
    message: `${article.title}${article.author ? ` by ${article.author}` : ""}`,
    tag: `pirate-radio-${slug}`,
    group: "pirate-radio",
    url: readerBaseUrl,
    buttons: [
      {
        title: "Yes",
        action: `${ACCEPT_PREFIX}${slug}`,
      },
      {
        title: "No",
        action: `${SKIP_PREFIX}${slug}`,
      },
    ],
  };
}

export function buildArticleReadyNotification(
  item: Pick<LibraryItem, "slug" | "title">,
  readerBaseUrl: string,
): ArticleNotification {
  return {
    title: "Pirate Radio Ready",
    message: `${item.title} is ready to listen.`,
    tag: `pirate-radio-ready-${item.slug}`,
    group: "pirate-radio",
    url: new URL(`/article/${encodeURIComponent(item.slug)}`, readerBaseUrl).toString(),
    buttons: [],
  };
}

export function buildArticleFailureNotification(
  article: PirateArticle,
  error: unknown,
  readerBaseUrl?: string,
  reauthUrl?: string,
): ArticleNotification {
  const slug = article.slug ?? slugFromUrl(article.url);
  if (isAuthRequiredError(error) && reauthUrl) {
    return {
      title: "Pirate Radio Login Required",
      message: `${article.title} needs a fresh Pirate Wires login before audio can be generated.`,
      tag: `pirate-radio-login-${slug}`,
      group: "pirate-radio",
      url: reauthUrl,
      buttons: [
        {
          title: "Open Login",
          action: "URI",
          uri: reauthUrl,
        },
      ],
    };
  }
  return {
    title: "Pirate Radio Failed",
    message: `${article.title} failed: ${failureMessage(error)}`,
    tag: `pirate-radio-failed-${slug}`,
    group: "pirate-radio",
    url: readerBaseUrl,
    buttons: [],
  };
}

export function parsePirateRadioAction(action: string): ParsedPirateRadioAction | null {
  if (action.startsWith(ACCEPT_PREFIX)) {
    return { decision: "accept", slug: action.slice(ACCEPT_PREFIX.length) };
  }
  if (action.startsWith(SKIP_PREFIX)) {
    return { decision: "skip", slug: action.slice(SKIP_PREFIX.length) };
  }
  return null;
}

export function failureType(error: unknown): string {
  return error instanceof Error ? error.name : "Error";
}

const SECRET_TEXT = /(?:crsr_[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]{8,}|bearer\s+\S+|api[_-]?key\s*[:=]\s*\S+)/gi;

export function publicFailureReason(error: unknown): string {
  const message = errorText(error);
  const haystack = `${errorCode(error)} ${message}`.toLowerCase();
  if (haystack.includes("usage_limit") || haystack.includes("usage limit")) {
    return "Cursor usage limit reached";
  }
  const redacted = message
    .replace(SECRET_TEXT, "")
    .replace(/\s+([.!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (!redacted) return "Conversion failed.";
  return redacted.length > 180 ? `${redacted.slice(0, 177)}...` : redacted;
}

function failureMessage(error: unknown): string {
  return publicFailureReason(error);
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "";
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== "object" || !("code" in error)) return "";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : "";
}

function isAuthRequiredError(error: unknown): boolean {
  return error instanceof Error && error.name === "PirateWiresAuthRequiredError";
}

import type { PirateArticle } from "./feed.js";
import type { LibraryManifest } from "./library.js";

const EXCLUDED_TITLE_PATTERNS = [/three morning takes/i];

export function isVoiceExcludedTitle(title: string): boolean {
  return EXCLUDED_TITLE_PATTERNS.some((pattern) => pattern.test(title));
}

export function filterVoiceExcludedArticles<T extends Pick<PirateArticle, "title">>(
  articles: T[],
): T[] {
  return articles.filter((article) => !isVoiceExcludedTitle(article.title));
}

export function filterVoiceExcludedLibraryManifest(
  manifest: LibraryManifest,
): LibraryManifest {
  return {
    ...manifest,
    items: manifest.items
      .filter((item) => !isVoiceExcludedTitle(item.title))
      .map((item) => ({
        ...item,
        sourceName: item.sourceName ?? sourceNameFromUrl(item.sourceUrl),
      }))
      .sort((left, right) => Date.parse(right.generatedAt) - Date.parse(left.generatedAt)),
  };
}

function sourceNameFromUrl(sourceUrl: string): string | undefined {
  try {
    const url = new URL(sourceUrl);
    if (url.hostname === "www.hyperdimensional.co" || url.hostname === "hyperdimensional.co") {
      return "Hyperdimensional";
    }
    if (
      url.hostname === "www.piratewires.com" ||
      url.hostname === "piratewires.com" ||
      url.hostname === "piratewires.substack.com"
    ) {
      return "Pirate Wires";
    }
    if (url.hostname === "x.com" || url.hostname.endsWith(".x.com")) {
      return "X";
    }
    if (url.protocol === "custom-text:") {
      return "Custom Text";
    }
  } catch {
    return undefined;
  }
  return undefined;
}

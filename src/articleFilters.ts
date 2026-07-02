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
    items: manifest.items.filter((item) => !isVoiceExcludedTitle(item.title)),
  };
}

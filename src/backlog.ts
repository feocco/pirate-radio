import { filterVoiceExcludedArticles } from "./articleFilters.js";
import { slugFromUrl } from "./slug.js";
import type { PirateArticle } from "./feed.js";
import type { LibraryManifest } from "./library.js";
import type { PirateRadioState } from "./state.js";

export interface BacklogItem {
  slug: string;
  title: string;
  author: string;
  publishedAt: string;
  description: string;
  url: string;
  converted: boolean;
  processing: boolean;
}

export interface BuildBacklogItemsInput {
  articles: PirateArticle[];
  manifest: LibraryManifest;
  processingSlugs: ReadonlySet<string>;
}

export interface QueueBacklogConversionInput {
  slug: string;
  articles: PirateArticle[];
  manifest: LibraryManifest;
  state: PirateRadioState;
  statePath: string;
  processingSlugs: Set<string>;
  writeState: (statePath: string, state: PirateRadioState) => Promise<void>;
  startConversion: (slug: string) => Promise<void>;
}

export type QueueBacklogConversionResult =
  | { ok: true; status: "converted" | "processing" | "queued" }
  | { ok: false; status: "missing" };

export interface QueueBacklogUrlConversionInput {
  url: string;
  manifest: LibraryManifest;
  state: PirateRadioState;
  statePath: string;
  processingSlugs: Set<string>;
  writeState: (statePath: string, state: PirateRadioState) => Promise<void>;
  startConversion: (slug: string) => Promise<void>;
}

export type QueueBacklogUrlConversionResult =
  | { ok: true; status: "converted" | "processing" | "queued"; slug: string }
  | { ok: false; status: "invalid_url"; error: string };

export type PirateWiresUrlValidation =
  | { ok: true; url: string; slug: string }
  | { ok: false; error: string };

export function buildBacklogItems(input: BuildBacklogItemsInput): BacklogItem[] {
  return filterVoiceExcludedArticles(input.articles).map((article) => {
    const slug = article.slug ?? slugFromUrl(article.url);
    return {
      slug,
      title: article.title,
      author: article.author,
      publishedAt: article.publishedAt,
      description: article.description,
      url: article.url,
      converted: isConverted(article, input.manifest),
      processing: input.processingSlugs.has(slug),
    };
  });
}

export function findBacklogArticle(
  articles: PirateArticle[],
  slug: string,
): PirateArticle | undefined {
  return filterVoiceExcludedArticles(articles).find(
    (article) => (article.slug ?? slugFromUrl(article.url)) === slug,
  );
}

export async function queueBacklogConversion(
  input: QueueBacklogConversionInput,
): Promise<QueueBacklogConversionResult> {
  const article = findBacklogArticle(input.articles, input.slug);
  if (!article) {
    return { ok: false, status: "missing" };
  }
  if (isConverted(article, input.manifest)) {
    return { ok: true, status: "converted" };
  }
  if (input.processingSlugs.has(input.slug)) {
    return { ok: true, status: "processing" };
  }

  const slug = article.slug ?? slugFromUrl(article.url);
  delete input.state.approved[article.id];
  input.state.pending[slug] = article;
  input.state.seen[article.id] = article;
  await input.writeState(input.statePath, input.state);
  input.processingSlugs.add(slug);
  void input.startConversion(slug).finally(() => {
    input.processingSlugs.delete(slug);
  });
  return { ok: true, status: "queued" };
}

export async function queueBacklogUrlConversion(
  input: QueueBacklogUrlConversionInput,
): Promise<QueueBacklogUrlConversionResult> {
  const validation = validatePirateWiresArticleUrl(input.url);
  if (!validation.ok) {
    return { ok: false, status: "invalid_url", error: validation.error };
  }

  const article: PirateArticle = {
    id: validation.url,
    title: titleFromSlug(validation.slug),
    url: validation.url,
    author: "",
    publishedAt: "",
    description: "Queued from pasted Pirate Wires URL.",
    slug: validation.slug,
  };
  if (isConverted(article, input.manifest)) {
    return { ok: true, status: "converted", slug: validation.slug };
  }
  if (input.processingSlugs.has(validation.slug)) {
    return { ok: true, status: "processing", slug: validation.slug };
  }

  delete input.state.approved[article.id];
  input.state.pending[validation.slug] = article;
  input.state.seen[article.id] = article;
  await input.writeState(input.statePath, input.state);
  input.processingSlugs.add(validation.slug);
  void input.startConversion(validation.slug).finally(() => {
    input.processingSlugs.delete(validation.slug);
  });
  return { ok: true, status: "queued", slug: validation.slug };
}

export function validatePirateWiresArticleUrl(value: string): PirateWiresUrlValidation {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return { ok: false, error: "Enter a valid URL." };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, error: "Enter a valid URL." };
  }
  if (url.hostname !== "piratewires.com" && url.hostname !== "www.piratewires.com") {
    return { ok: false, error: "Enter a Pirate Wires URL from piratewires.com." };
  }

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "p" || !parts[1]) {
    return {
      ok: false,
      error: "Enter a Pirate Wires article URL like https://www.piratewires.com/p/story-slug.",
    };
  }

  url.hash = "";
  url.search = "";
  const slug = slugFromUrl(url.toString());
  return { ok: true, url: url.toString(), slug };
}

function isConverted(article: PirateArticle, manifest: LibraryManifest): boolean {
  const slug = article.slug ?? slugFromUrl(article.url);
  return manifest.items.some((item) => item.slug === slug || item.sourceUrl === article.url);
}

function titleFromSlug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ") || "Pirate Wires Article";
}

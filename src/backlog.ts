import { filterVoiceExcludedArticles } from "./articleFilters.js";
import { slugFromUrl } from "./slug.js";
import type { ArticleSourceType, PirateArticle } from "./feed.js";
import type { LibraryManifest } from "./library.js";
import type { PirateRadioState } from "./state.js";
import { isXHostname, parseXPostUrl } from "./xArticle.js";
import { isWsjHostname, parseWsjArticleUrl, titleFromWsjSlug, WSJ_SOURCE_NAME } from "./wsjArticle.js";

export interface BacklogItem {
  slug: string;
  title: string;
  author: string;
  publishedAt: string;
  description: string;
  url: string;
  sourceType?: ArticleSourceType;
  sourceName?: string;
  canonicalUrl?: string;
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

export type ArticleUrlValidation =
  | { ok: true; url: string; slug: string; sourceType: ArticleSourceType; sourceName: string }
  | { ok: false; error: string };

export interface ArticleUrlValidationOptions {
  resolveUrl?: (url: string) => Promise<string>;
}

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
      sourceType: article.sourceType,
      sourceName: article.sourceName,
      canonicalUrl: article.canonicalUrl,
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
  const validation = await validateArticleUrl(input.url);
  if (!validation.ok) {
    return { ok: false, status: "invalid_url", error: validation.error };
  }

  const article: PirateArticle = {
    id: validation.url,
    title: pendingTitle(validation),
    url: validation.url,
    author: "",
    publishedAt: "",
    description: `Queued from pasted ${validation.sourceName} URL.`,
    slug: validation.slug,
    sourceType: validation.sourceType,
    sourceName: validation.sourceName,
    canonicalUrl: validation.url,
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

export async function validateArticleUrl(
  value: string,
  options: ArticleUrlValidationOptions = {},
): Promise<ArticleUrlValidation> {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return { ok: false, error: "Enter a valid URL." };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, error: "Enter a valid URL." };
  }

  if (url.hostname === "open.substack.com") {
    const resolved = await resolveOpenSubstackUrl(url.toString(), options.resolveUrl);
    if (!resolved.ok) {
      return resolved;
    }
    url = new URL(resolved.url);
  }

  if (isXHostname(url.hostname)) {
    const xPost = parseXPostUrl(url);
    if (!xPost) {
      return {
        ok: false,
        error: "Enter an X post URL with a /username/status/id path.",
      };
    }
    return {
      ok: true,
      url: xPost.canonicalUrl,
      slug: xPost.postId,
      sourceType: "x",
      sourceName: "X",
    };
  }

  if (isWsjHostname(url.hostname)) {
    const wsjArticle = parseWsjArticleUrl(url);
    if (!wsjArticle) {
      return {
        ok: false,
        error: "Enter a WSJ article URL such as /section/headline-id or /articles/headline.",
      };
    }
    return {
      ok: true,
      url: wsjArticle.canonicalUrl,
      slug: wsjArticle.slug,
      sourceType: "wsj",
      sourceName: WSJ_SOURCE_NAME,
    };
  }

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "p" || !parts[1]) {
    return {
      ok: false,
      error: "Enter an article URL with a /p/story-slug path.",
    };
  }

  url.hash = "";
  url.search = "";
  const slug = slugFromUrl(url.toString());
  const source = sourceForUrl(url);
  if (!source) {
    return { ok: false, error: "Enter a supported article URL from Pirate Wires, Substack, X, or WSJ." };
  }
  const canonicalUrl = canonicalArticleUrl(url, source.sourceType);
  return { ok: true, url: canonicalUrl, slug, ...source };
}

export function validatePirateWiresArticleUrl(value: string): ArticleUrlValidation {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return { ok: false, error: "Enter a valid URL." };
  }
  if (url.hostname !== "piratewires.com" && url.hostname !== "www.piratewires.com") {
    return { ok: false, error: "Enter a Pirate Wires URL from piratewires.com." };
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "p" || !parts[1]) {
    return {
      ok: false,
      error: "Enter an article URL with a /p/story-slug path.",
    };
  }
  url.hash = "";
  url.search = "";
  return {
    ok: true,
    url: url.toString(),
    slug: slugFromUrl(url.toString()),
    sourceType: "pirate-wires",
    sourceName: "Pirate Wires",
  };
}

function isConverted(article: PirateArticle, manifest: LibraryManifest): boolean {
  const slug = article.slug ?? slugFromUrl(article.url);
  return manifest.items.some(
    (item) =>
      item.slug === slug ||
      item.sourceUrl === article.url ||
      Boolean(item.canonicalUrl && article.canonicalUrl && item.canonicalUrl === article.canonicalUrl),
  );
}

function pendingTitle(validation: Extract<ArticleUrlValidation, { ok: true }>): string {
  if (validation.sourceType === "x") {
    return "X Article";
  }
  if (validation.sourceType === "wsj") {
    return titleFromWsjSlug(validation.slug);
  }
  return titleFromSlug(validation.slug);
}

function titleFromSlug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ") || "Article";
}

async function resolveOpenSubstackUrl(
  url: string,
  resolver?: (url: string) => Promise<string>,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  try {
    const resolved = resolver
      ? await resolver(url)
      : (await fetch(url, { redirect: "follow" })).url;
    return { ok: true, url: resolved };
  } catch {
    return { ok: false, error: "Could not resolve the Substack share URL." };
  }
}

function sourceForUrl(
  url: URL,
): { sourceType: ArticleSourceType; sourceName: string } | undefined {
  if (url.hostname === "piratewires.com" || url.hostname === "www.piratewires.com") {
    return { sourceType: "pirate-wires", sourceName: "Pirate Wires" };
  }
  if (url.hostname === "piratewires.substack.com") {
    return { sourceType: "pirate-wires", sourceName: "Pirate Wires" };
  }
  if (url.hostname === "www.hyperdimensional.co" || url.hostname === "hyperdimensional.co") {
    return { sourceType: "substack", sourceName: "Hyperdimensional" };
  }
  if (url.hostname.endsWith(".substack.com")) {
    return { sourceType: "substack", sourceName: titleFromSlug(url.hostname.split(".")[0] ?? "Substack") };
  }
  return undefined;
}

function canonicalArticleUrl(url: URL, sourceType: ArticleSourceType): string {
  const next = new URL(url.toString());
  next.hash = "";
  next.search = "";
  if (sourceType === "pirate-wires" && next.hostname === "piratewires.substack.com") {
    next.hostname = "www.piratewires.com";
  }
  if (next.hostname === "hyperdimensional.co") {
    next.hostname = "www.hyperdimensional.co";
  }
  return next.toString();
}

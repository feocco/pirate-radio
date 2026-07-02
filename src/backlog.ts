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

function isConverted(article: PirateArticle, manifest: LibraryManifest): boolean {
  const slug = article.slug ?? slugFromUrl(article.url);
  return manifest.items.some((item) => item.slug === slug || item.sourceUrl === article.url);
}

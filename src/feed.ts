import { cleanText } from "./extractor.js";
import { filterVoiceExcludedArticles } from "./articleFilters.js";
import { slugFromUrl } from "./slug.js";

export type ArticleSourceType = "pirate-wires" | "substack" | "x";
export type ArticleFeedSourceType = Exclude<ArticleSourceType, "x">;

export interface ArticleFeedConfig {
  id: string;
  name: string;
  type: ArticleFeedSourceType;
  url: string;
}

export interface PirateArticle {
  id: string;
  title: string;
  url: string;
  author: string;
  publishedAt: string;
  description: string;
  sourceId?: string;
  slug?: string;
  sourceType?: ArticleSourceType;
  sourceName?: string;
  canonicalUrl?: string;
  heroImageOriginalUrl?: string;
  contentHtml?: string;
}

export const PIRATE_RSS_URL = "https://piratewires.substack.com/feed.xml";
export const HYPERDIMENSIONAL_RSS_URL = "https://www.hyperdimensional.co/feed";

export const DEFAULT_FEEDS: ArticleFeedConfig[] = [
  {
    id: "pirate-wires",
    name: "Pirate Wires",
    type: "pirate-wires",
    url: PIRATE_RSS_URL,
  },
  {
    id: "hyperdimensional",
    name: "Hyperdimensional",
    type: "substack",
    url: HYPERDIMENSIONAL_RSS_URL,
  },
];

export async function fetchPirateFeed(feedUrl = PIRATE_RSS_URL): Promise<PirateArticle[]> {
  return fetchArticleFeed({
    id: "pirate-wires",
    name: "Pirate Wires",
    type: "pirate-wires",
    url: feedUrl,
  });
}

export async function fetchArticleFeeds(feeds: ArticleFeedConfig[] = DEFAULT_FEEDS): Promise<PirateArticle[]> {
  const articleGroups = await Promise.all(feeds.map((feed) => fetchArticleFeed(feed)));
  return articleGroups
    .flat()
    .sort((left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt));
}

export async function fetchArticleFeed(feed: ArticleFeedConfig): Promise<PirateArticle[]> {
  const response = await fetch(feed.url, {
    headers: {
      accept: "application/rss+xml, application/xml, text/xml",
      "user-agent": "pirate-radio/0.1",
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${feed.name} feed: ${response.status} ${response.statusText}`);
  }
  return parseArticleFeed(await response.text(), feed);
}

export function parsePirateFeed(xml: string): PirateArticle[] {
  return parseArticleFeed(xml, {
    id: "pirate-wires",
    name: "Pirate Wires",
    type: "pirate-wires",
    url: PIRATE_RSS_URL,
  });
}

export function parseArticleFeed(xml: string, feed: ArticleFeedConfig): PirateArticle[] {
  const articles = Array.from(xml.matchAll(/<item>([\s\S]*?)<\/item>/g), (match) => parseFeedItem(match[1], feed))
    .filter((item): item is PirateArticle => item !== null)
    .map((item) => ({ ...item, slug: slugFromUrl(item.url) }));
  return feed.type === "pirate-wires" ? filterVoiceExcludedArticles(articles) : articles;
}

export function detectNewArticles(
  articles: PirateArticle[],
  seenIds: ReadonlySet<string>,
): PirateArticle[] {
  return articles.filter((article) => !seenIds.has(article.id));
}

function parseFeedItem(itemXml: string, feed: ArticleFeedConfig): PirateArticle | null {
  const title = pickTag(itemXml, "title");
  const url = pickTag(itemXml, "link");
  const guid = pickTag(itemXml, "guid") || url;

  if (!title || !url || !guid) {
    return null;
  }

  return {
    id: guid,
    title,
    url,
    author: pickTag(itemXml, "dc:creator") || "",
    publishedAt: pickTag(itemXml, "pubDate") || "",
    description: pickTag(itemXml, "description") || "",
    sourceId: feed.id,
    sourceType: feed.type,
    sourceName: feed.name,
    canonicalUrl: url,
    heroImageOriginalUrl: pickEnclosureUrl(itemXml),
    contentHtml: stripCdata(rawTag(itemXml, "content:encoded")),
  };
}

function pickTag(xml: string, tagName: string): string {
  const value = rawTag(xml, tagName);
  return cleanText(stripCdata(value));
}

function rawTag(xml: string, tagName: string): string {
  const escapedTag = tagName.replace(":", "\\:");
  return xml.match(new RegExp(`<${escapedTag}[^>]*>([\\s\\S]*?)<\\/${escapedTag}>`))?.[1] ?? "";
}

function pickEnclosureUrl(xml: string): string | undefined {
  const tag = xml.match(/<enclosure\b[^>]*>/i)?.[0];
  if (!tag) {
    return undefined;
  }
  return tag.match(/\burl\s*=\s*("([^"]*)"|'([^']*)')/i)?.[2] ?? tag.match(/\burl\s*=\s*("([^"]*)"|'([^']*)')/i)?.[3];
}

function stripCdata(value: string): string {
  return value.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");
}

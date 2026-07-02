import { cleanText } from "./extractor.js";
import { filterVoiceExcludedArticles } from "./articleFilters.js";
import { slugFromUrl } from "./slug.js";

export interface PirateArticle {
  id: string;
  title: string;
  url: string;
  author: string;
  publishedAt: string;
  description: string;
  slug?: string;
}

export const PIRATE_RSS_URL = "https://piratewires.substack.com/feed.xml";

export async function fetchPirateFeed(feedUrl = PIRATE_RSS_URL): Promise<PirateArticle[]> {
  const response = await fetch(feedUrl, {
    headers: {
      accept: "application/rss+xml, application/xml, text/xml",
      "user-agent": "pirate-radio/0.1",
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch Pirate Wires feed: ${response.status} ${response.statusText}`);
  }
  return parsePirateFeed(await response.text());
}

export function parsePirateFeed(xml: string): PirateArticle[] {
  const articles = Array.from(xml.matchAll(/<item>([\s\S]*?)<\/item>/g), (match) => parseFeedItem(match[1]))
    .filter((item): item is PirateArticle => item !== null)
    .map((item) => ({ ...item, slug: slugFromUrl(item.url) }));
  return filterVoiceExcludedArticles(articles);
}

export function detectNewArticles(
  articles: PirateArticle[],
  seenIds: ReadonlySet<string>,
): PirateArticle[] {
  return articles.filter((article) => !seenIds.has(article.id));
}

function parseFeedItem(itemXml: string): PirateArticle | null {
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
  };
}

function pickTag(xml: string, tagName: string): string {
  const escapedTag = tagName.replace(":", "\\:");
  const value = xml.match(new RegExp(`<${escapedTag}[^>]*>([\\s\\S]*?)<\\/${escapedTag}>`))?.[1] ?? "";
  return cleanText(stripCdata(value));
}

function stripCdata(value: string): string {
  return value.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");
}

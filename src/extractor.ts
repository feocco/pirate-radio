import type { Story, StoryContentBlock, StoryContentBlockType } from "./types.js";

const BLOCKED_TEXT_PATTERNS = [
  /subscribe/i,
  /privacy policy/i,
  /terms/i,
  /sign in/i,
  /log in/i,
  /share this/i,
  /type your email/i,
  /reader-supported publication/i,
  /^comments?$/i,
];

export function extractStoryFromHtml(html: string, sourceUrl: string): Story {
  const article = extractBodyContainerHtml(html);
  const title =
    cleanText(metaContent(html, "property", "og:title") ?? "") ||
    cleanText(firstMatch(html, /<h1\b[^>]*>([\s\S]*?)<\/h1>/i) ?? "") ||
    cleanText(firstMatch(html, /<title\b[^>]*>([\s\S]*?)<\/title>/i) ?? "");

  if (!title) {
    throw new Error("Could not find a story title on the page.");
  }

  const bodyHtml = article
    .replace(/<header\b[^>]*>[\s\S]*?<\/header>/gi, "")
    .replace(/<aside\b[^>]*>[\s\S]*?<\/aside>/gi, "")
    .replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+\bdata-component-name=["']SubscribeWidget["'][\s\S]*?<\/div>/gi, "")
    .replace(/<[^>]+\bclass=["'][^"']*(?:comments|subscribe-widget|subscription-widget)[^"']*["'][\s\S]*?<\/div>/gi, "");

  const contentBlocks = Array.from(
    bodyHtml.matchAll(/<(p|h2|h3|h4|li|blockquote)\b[^>]*>([\s\S]*?)<\/\1>/gi),
    (match): StoryContentBlock | undefined => {
      const text = cleanText(match[2] ?? "");
      if (!text || isBlockedText(text)) {
        return undefined;
      }
      return { type: blockType(match[1] ?? "p"), text };
    },
  ).filter((block): block is StoryContentBlock => Boolean(block));

  if (contentBlocks.length === 0) {
    throw new Error("Could not find story body text on the page.");
  }

  const sectionTitles = contentBlocks
    .filter((block) => block.type === "heading")
    .map((block) => block.text);
  const text = contentBlocks.map((block) => block.text).join("\n\n");

  return {
    sourceUrl,
    title,
    tagline: extractTagline(html),
    heroImageOriginalUrl: extractHeroImageUrl(html, sourceUrl),
    sectionTitles,
    contentBlocks,
    text,
    wordCount: countWords(text),
    characterCount: text.length,
    extractedAt: new Date().toISOString(),
  };
}

function blockType(tagName: string): StoryContentBlockType {
  const tag = tagName.toLowerCase();
  if (tag === "h2" || tag === "h3") {
    return "heading";
  }
  if (tag === "h4") {
    return "heading";
  }
  if (tag === "li") {
    return "list";
  }
  if (tag === "blockquote") {
    return "quote";
  }
  return "paragraph";
}

function extractTagline(html: string): string | undefined {
  return (
    extractHeroExcerpt(html) ||
    cleanText(metaContent(html, "property", "og:description") ?? "") ||
    cleanText(metaContent(html, "name", "description") ?? "")
  );
}

function extractHeroExcerpt(html: string): string | undefined {
  const match = html.match(
    /<(?:div|p)\b(?=[^>]*class=["'][^"']*article_excerpt[^"']*["'])[^>]*>([\s\S]*?)<\/(?:div|p)>/i,
  );
  return match?.[1] ? cleanText(match[1]) : undefined;
}

function extractHeroImageUrl(html: string, sourceUrl: string): string | undefined {
  const coverImageTag = Array.from(html.matchAll(/<img\b[^>]*>/gi), (match) => match[0]).find((tag) =>
    (attributeValue(tag, "class") ?? "").includes("cover-image"),
  );
  const fallback =
    (coverImageTag ? attributeValue(coverImageTag, "currentSrc") ?? attributeValue(coverImageTag, "src") : undefined) ??
    metaContent(html, "property", "og:image") ??
    metaContent(html, "name", "twitter:image");
  if (!fallback) {
    return undefined;
  }
  const absoluteUrl = new URL(decodeHtml(fallback), sourceUrl).toString();
  return unwrapNextImageUrl(absoluteUrl);
}

function metaContent(html: string, attributeName: "name" | "property", expectedValue: string): string | undefined {
  const tag = Array.from(html.matchAll(/<meta\b[^>]*>/gi), (match) => match[0]).find(
    (candidate) => attributeValue(candidate, attributeName) === expectedValue,
  );
  return tag ? attributeValue(tag, "content") : undefined;
}

function unwrapNextImageUrl(imageUrl: string): string {
  try {
    const url = new URL(imageUrl);
    const nested = url.searchParams.get("url");
    if (nested) {
      return decodeHtml(nested);
    }
  } catch {
    return imageUrl;
  }
  return imageUrl;
}

function attributeValue(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i"));
  return match?.[2] ?? match?.[3];
}

export function cleanText(value: string): string {
  return decodeHtml(stripTags(value))
    .replace(/\s+/g, " ")
    .trim();
}

function extractBodyContainerHtml(html: string): string {
  return (
    firstMatch(
      html,
      /<section\b(?=[^>]*class=["'][^"']*article_postBody[^"']*["'])[^>]*>([\s\S]*?)<\/section>/i,
    ) ??
    htmlFromClassSlice(html, "available-content") ??
    htmlFromClassSlice(html, "body markup") ??
    firstMatch(
      html,
      /<div\b(?=[^>]*class=["'][^"']*richText[^"']*["'])[^>]*>([\s\S]*?)<\/div>/i,
    ) ??
    firstMatch(html, /<article\b[^>]*>([\s\S]*?)<\/article>/i) ??
    html
  );
}

function firstMatch(value: string, pattern: RegExp): string | undefined {
  return value.match(pattern)?.[1];
}

function htmlFromClassSlice(html: string, className: string): string | undefined {
  const classMatcher = new RegExp(`<[^>]+\\bclass=["'][^"']*${escapeRegExp(className)}[^"']*["'][^>]*>`, "i");
  const match = classMatcher.exec(html);
  if (!match) {
    return undefined;
  }
  const stopPatterns = [
    /<div\b[^>]*class=["'][^"']*comments[^"']*["']/i,
    /<section\b[^>]*class=["'][^"']*comments[^"']*["']/i,
    /<\/article>/i,
    /<\/body>/i,
  ];
  const rest = html.slice(match.index);
  const stop = stopPatterns
    .map((pattern) => pattern.exec(rest)?.index)
    .filter((index): index is number => typeof index === "number" && index > 0)
    .sort((left, right) => left - right)[0];
  return stop ? rest.slice(0, stop) : rest;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, " ");
}

function decodeHtml(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&rsquo;/g, "'")
    .replace(/&ldquo;/g, '"')
    .replace(/&rdquo;/g, '"')
    .replace(/&mdash;/g, "-")
    .replace(/&ndash;/g, "-");
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function isBlockedText(text: string): boolean {
  return BLOCKED_TEXT_PATTERNS.some((pattern) => pattern.test(text));
}

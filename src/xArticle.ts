import type { Story, StoryContentBlock } from "./types.js";

const X_API_BASE_URL = "https://api.x.com";
const X_HOSTNAMES = new Set([
  "x.com",
  "www.x.com",
  "mobile.x.com",
  "twitter.com",
  "www.twitter.com",
  "mobile.twitter.com",
]);

interface XArticlePayload {
  data?: {
    author_id?: string;
    article?: {
      cover_media?: string;
      plain_text?: string;
      preview_text?: string;
      title?: string;
    };
  };
  includes?: {
    media?: Array<{
      media_key?: string;
      preview_image_url?: string;
      url?: string;
    }>;
    users?: Array<{
      id?: string;
      name?: string;
      username?: string;
    }>;
  };
}

export interface XPostUrl {
  canonicalUrl: string;
  postId: string;
}

export interface ExtractXArticleOptions {
  bearerToken?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export function isXHostname(hostname: string): boolean {
  return X_HOSTNAMES.has(hostname.toLowerCase());
}

export function parseXPostUrl(url: URL): XPostUrl | undefined {
  if (!isXHostname(url.hostname)) {
    return undefined;
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 3 || parts[1] !== "status" || !/^\d{1,19}$/.test(parts[2] ?? "")) {
    return undefined;
  }
  const canonical = new URL(`https://x.com/${parts[0]}/status/${parts[2]}`);
  return { canonicalUrl: canonical.toString(), postId: parts[2] };
}

/**
 * Fetch an X Article through the official Post lookup API.
 *
 * Requires an app-only bearer token supplied through `X_API_BEARER_TOKEN` or
 * `options.bearerToken`. Ordinary X posts without an Article are rejected.
 */
export async function extractXArticleFromUrl(
  sourceUrl: string,
  options: ExtractXArticleOptions = {},
): Promise<Story> {
  const parsedUrl = parseXPostUrl(new URL(sourceUrl));
  if (!parsedUrl) {
    throw new Error("Enter an X post URL with a /username/status/id path.");
  }
  const bearerToken = options.bearerToken ?? process.env.X_API_BEARER_TOKEN;
  if (!bearerToken) {
    throw new Error("X_API_BEARER_TOKEN is required to convert X Articles.");
  }

  const endpoint = new URL(`/2/tweets/${parsedUrl.postId}`, X_API_BASE_URL);
  endpoint.searchParams.set("tweet.fields", "article,author_id");
  endpoint.searchParams.set("expansions", "article.cover_media,author_id");
  endpoint.searchParams.set("media.fields", "url,preview_image_url");
  endpoint.searchParams.set("user.fields", "name,username");
  const response = await (options.fetchImpl ?? fetch)(endpoint, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${bearerToken}`,
      "user-agent": "pirate-radio/0.1",
    },
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error("X API authentication failed. Check X_API_BEARER_TOKEN.");
  }
  if (response.status === 429) {
    throw new Error("X API rate limit exceeded. Try the conversion again later.");
  }
  if (!response.ok) {
    throw new Error(`Could not load X Article: ${response.status} ${response.statusText}`);
  }

  const payload = await response.json() as XArticlePayload;
  const article = payload.data?.article;
  if (!article) {
    throw new Error("The X post does not contain an Article.");
  }
  const title = article.title?.trim();
  const text = normalizeArticleText(article.plain_text ?? "");
  if (!title) {
    throw new Error("X returned an Article without a title.");
  }
  if (!text) {
    throw new Error("X returned an Article without readable text.");
  }

  const contentBlocks: StoryContentBlock[] = text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => ({ type: "paragraph", text: paragraph }));
  const cover = payload.includes?.media?.find(
    (media) => media.media_key === article.cover_media,
  );
  const authorAccount = payload.includes?.users?.find(
    (user) => user.id === payload.data?.author_id,
  );
  const author = authorAccount?.name?.trim() || (
    authorAccount?.username?.trim() ? `@${authorAccount.username.trim()}` : undefined
  );

  return {
    sourceUrl: parsedUrl.canonicalUrl,
    title,
    author,
    tagline: article.preview_text?.trim() || undefined,
    heroImageOriginalUrl: cover?.url ?? cover?.preview_image_url,
    contentBlocks,
    text,
    wordCount: text.split(/\s+/).length,
    characterCount: text.length,
    extractedAt: (options.now?.() ?? new Date()).toISOString(),
  };
}

function normalizeArticleText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

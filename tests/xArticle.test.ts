import { describe, expect, test, vi } from "vitest";
import { extractXArticleFromUrl, parseXPostUrl } from "../src/xArticle.js";

const ARTICLE_URL = "https://x.com/demishassabis/status/2076957440109625718";
const TITLE = "A Framework for Frontier AI and the Dawning of a New Age";
const FIRST_SENTENCE = "This is a pivotal moment in human history.";
const LAST_SENTENCE = "By safely stewarding AGI into the world, we can enter a new golden age of scientific discovery and progress, and usher in a bright future of incredible human flourishing.";

describe("X Article extraction", () => {
  test("normalizes current and legacy X post URLs", () => {
    expect(parseXPostUrl(new URL(`${ARTICLE_URL}?s=20`))).toEqual({
      canonicalUrl: ARTICLE_URL,
      postId: "2076957440109625718",
    });
    expect(
      parseXPostUrl(new URL("https://mobile.twitter.com/demishassabis/status/2076957440109625718/photo/1")),
    ).toEqual({
      canonicalUrl: ARTICLE_URL,
      postId: "2076957440109625718",
    });
  });

  test("maps the official API article payload into a Story", async () => {
    let requestedUrl = "";
    let requestedInit: RequestInit | undefined;
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      requestedUrl = String(input);
      requestedInit = init;
      return new Response(JSON.stringify({
        data: {
          article: {
            cover_media: "3_2076946366647971840",
            plain_text: `${FIRST_SENTENCE}\n\nA middle paragraph.\n\n${LAST_SENTENCE}`,
            preview_text: FIRST_SENTENCE,
            title: TITLE,
          },
        },
        includes: {
          media: [{
            media_key: "3_2076946366647971840",
            type: "photo",
            url: "https://pbs.twimg.com/media/HNLLt2GXMAAAPF0.jpg",
          }],
        },
      }), { status: 200 });
    });

    const story = await extractXArticleFromUrl(ARTICLE_URL, {
      bearerToken: "test-bearer-token",
      fetchImpl,
      now: () => new Date("2026-07-14T20:00:00.000Z"),
    });

    expect(story).toMatchObject({
      sourceUrl: ARTICLE_URL,
      title: TITLE,
      tagline: FIRST_SENTENCE,
      heroImageOriginalUrl: "https://pbs.twimg.com/media/HNLLt2GXMAAAPF0.jpg",
      contentBlocks: [
        { type: "paragraph", text: FIRST_SENTENCE },
        { type: "paragraph", text: "A middle paragraph." },
        { type: "paragraph", text: LAST_SENTENCE },
      ],
      extractedAt: "2026-07-14T20:00:00.000Z",
    });
    expect(story.text.startsWith(FIRST_SENTENCE)).toBe(true);
    expect(story.text.endsWith(LAST_SENTENCE)).toBe(true);
    expect(story.wordCount).toBe(story.text.split(/\s+/).length);
    expect(story.characterCount).toBe(story.text.length);

    expect(requestedUrl).toContain("/2/tweets/2076957440109625718");
    expect(requestedUrl).toContain("tweet.fields=article");
    expect(new Headers(requestedInit?.headers).get("authorization")).toBe("Bearer test-bearer-token");
  });

  test("requires the bearer token", async () => {
    await expect(
      extractXArticleFromUrl(ARTICLE_URL, { bearerToken: "" }),
    ).rejects.toThrow("X_API_BEARER_TOKEN is required");
  });

  test("rejects ordinary X posts without an Article", async () => {
    await expect(
      extractXArticleFromUrl(ARTICLE_URL, {
        bearerToken: "test-bearer-token",
        fetchImpl: async () => new Response(
          JSON.stringify({ data: { id: "2076957440109625718" } }),
          { status: 200 },
        ),
      }),
    ).rejects.toThrow("does not contain an Article");
  });

  test("returns actionable authentication and rate-limit errors", async () => {
    await expect(
      extractXArticleFromUrl(ARTICLE_URL, {
        bearerToken: "bad-token",
        fetchImpl: async () => new Response("", { status: 401 }),
      }),
    ).rejects.toThrow("X API authentication failed");
    await expect(
      extractXArticleFromUrl(ARTICLE_URL, {
        bearerToken: "test-bearer-token",
        fetchImpl: async () => new Response("", { status: 429 }),
      }),
    ).rejects.toThrow("X API rate limit exceeded");
  });
});

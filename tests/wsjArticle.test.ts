import { describe, expect, test } from "vitest";
import {
  parseWsjArticleUrl,
  titleFromWsjSlug,
  validateWsjAccess,
  WsjAuthRequiredError,
} from "../src/wsjArticle.js";

const ARTICLE_URL = "https://www.wsj.com/tech/steve-jobs-apple-next-cia-161b65f9";

describe("WSJ article URLs", () => {
  test("canonicalizes share URLs and modern section paths", () => {
    expect(
      parseWsjArticleUrl(
        new URL(`${ARTICLE_URL}?st=NWWds1&reflink=desktopwebshare_permalink`),
      ),
    ).toEqual({
      canonicalUrl: ARTICLE_URL,
      slug: "steve-jobs-apple-next-cia-161b65f9",
    });
    expect(parseWsjArticleUrl(new URL("https://wsj.com/articles/fed-signals-rate-cuts-1420234648"))).toEqual({
      canonicalUrl: "https://www.wsj.com/articles/fed-signals-rate-cuts-1420234648",
      slug: "fed-signals-rate-cuts-1420234648",
    });
    expect(titleFromWsjSlug("steve-jobs-apple-next-cia-161b65f9")).toBe("Steve Jobs Apple Next Cia");
  });

  test("rejects section fronts, video, and live coverage", () => {
    expect(parseWsjArticleUrl(new URL("https://www.wsj.com/tech"))).toBeUndefined();
    expect(parseWsjArticleUrl(new URL("https://www.wsj.com/tech/ai"))).toBeUndefined();
    expect(parseWsjArticleUrl(new URL("https://www.wsj.com/video/tech/clip-123"))).toBeUndefined();
    expect(parseWsjArticleUrl(new URL("https://www.wsj.com/livecoverage/fed-meeting"))).toBeUndefined();
  });
});

describe("WSJ access checks", () => {
  test("rejects public preview pages before returning truncated article text", () => {
    expect(() =>
      validateWsjAccess({
        pageText: "Subscribe Sign In Already a subscriber? Sign in to WSJ",
        articleWordCount: 92,
        profileDir: "/data/playwright-profile",
      }),
    ).toThrow(WsjAuthRequiredError);
  });

  test("accepts subscriber sessions with full article text", () => {
    expect(() =>
      validateWsjAccess({
        pageText: "Markets Log Out Customer Center",
        articleWordCount: 1840,
        profileDir: "/data/playwright-profile",
        cookies: [{ name: "djcs_session" }],
      }),
    ).not.toThrow();
  });

  test("rejects a session cookie that still shows a truncated paywall snippet", () => {
    expect(() =>
      validateWsjAccess({
        pageText: "Already a subscriber? Sign in to continue reading this article.",
        articleWordCount: 80,
        profileDir: "/data/playwright-profile",
        cookies: [{ name: "djcs_session" }],
      }),
    ).toThrow(WsjAuthRequiredError);
  });
});

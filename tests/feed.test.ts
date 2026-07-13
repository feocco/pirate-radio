import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { detectNewArticles, parseArticleFeed, parsePirateFeed } from "../src/feed.js";

describe("Pirate Wires RSS monitor", () => {
  test("parses title, url, author, publish date, description, and guid", async () => {
    const xml = await readFile("tests/fixtures/pirate-feed.xml", "utf8");

    const articles = parsePirateFeed(xml);

    expect(articles).toHaveLength(1);
    expect(articles[0]).toMatchObject({
      id: "https://piratewires.substack.com/p/inside-microns-attempts",
      title: "Inside Micron's Attempts",
      url: "https://piratewires.substack.com/p/inside-microns-attempts",
      author: "Ryan Hassan",
      publishedAt: "Mon, 22 Jun 2026 17:07:10 GMT",
      description: "following nonsense regulations",
    });
  });

  test("detects unseen articles without re-notifying seen items", async () => {
    const xml = await readFile("tests/fixtures/pirate-feed.xml", "utf8");
    const articles = parsePirateFeed(xml);
    const seen = new Set<string>();

    expect(detectNewArticles(articles, seen)).toEqual([articles[0]]);
  });

  test("excludes Three Morning Takes articles from the voice feed", () => {
    const articles = parsePirateFeed(`
      <rss><channel>
        <item>
          <title>Monday: Three Morning Takes</title>
          <link>https://piratewires.substack.com/p/friday-three-morning-takes-84a</link>
          <guid>https://piratewires.substack.com/p/friday-three-morning-takes-84a</guid>
          <pubDate>Mon, 22 Jun 2026 09:45:52 GMT</pubDate>
          <description>short takes</description>
        </item>
        <item>
          <title>A Regular Article</title>
          <link>https://piratewires.substack.com/p/a-regular-article</link>
          <guid>https://piratewires.substack.com/p/a-regular-article</guid>
          <pubDate>Mon, 22 Jun 2026 10:45:52 GMT</pubDate>
          <description>full story</description>
        </item>
      </channel></rss>
    `);

    expect(articles.map((article) => article.title)).toEqual(["A Regular Article"]);
  });
});

describe("multi-source RSS monitor", () => {
  test("parses Hyperdimensional Substack feed items with source metadata", async () => {
    const xml = await readFile("tests/fixtures/hyperdimensional-feed.xml", "utf8");

    const articles = parseArticleFeed(xml, {
      id: "hyperdimensional",
      name: "Hyperdimensional",
      type: "substack",
      url: "https://www.hyperdimensional.co/feed",
    });

    expect(articles).toHaveLength(1);
    expect(articles[0]).toMatchObject({
      id: "https://www.hyperdimensional.co/p/what-should-be-done",
      title: "What Should Be Done",
      url: "https://www.hyperdimensional.co/p/what-should-be-done",
      author: "Dean W. Ball",
      publishedAt: "Fri, 26 Jun 2026 11:45:17 GMT",
      description: "How to get past improvised model licensing",
      sourceType: "substack",
      sourceName: "Hyperdimensional",
      slug: "what-should-be-done",
      heroImageOriginalUrl: "https://substackcdn.com/image/fetch/hero.png",
    });
    expect(articles[0].contentHtml).toContain("First real body paragraph");
  });

  test("does not apply Pirate Wires Three Morning Takes exclusion to other sources", () => {
    const articles = parseArticleFeed(
      `<rss><channel><item><title>Three Morning Takes</title><link>https://www.hyperdimensional.co/p/three-morning-takes</link><guid>https://www.hyperdimensional.co/p/three-morning-takes</guid></item></channel></rss>`,
      {
        id: "hyperdimensional",
        name: "Hyperdimensional",
        type: "substack",
        url: "https://www.hyperdimensional.co/feed",
      },
    );

    expect(articles.map((article) => article.title)).toEqual(["Three Morning Takes"]);
  });
});

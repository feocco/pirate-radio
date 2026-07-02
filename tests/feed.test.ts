import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { detectNewArticles, parsePirateFeed } from "../src/feed.js";

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

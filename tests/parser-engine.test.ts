import { describe, expect, test } from "vitest";
import { ParserRunError, runParser, toStory } from "../src/parsers/engine.js";
import { checkInvariants } from "../src/parsers/invariants.js";
import { parseParserSpec } from "../src/parsers/spec.js";

const pageUrl = "https://example.com/posts/one";
const now = new Date("2026-04-05T06:07:08.000Z");

function specFor(overrides: Record<string, unknown> = {}) {
  const raw: Record<string, unknown> = {
    schema: "pirate-radio/parser-spec@1",
    id: "example-news",
    displayName: "Example News",
    hosts: ["news.example"],
    paths: { prefixes: ["/does-not-match/"] },
    title: {
      from: [{ select: "h1" }, { select: 'meta[property="og:title"]', attr: "content" }],
    },
    byline: {
      from: [{ select: "p.byline" }],
      cleanup: [{ op: "stripPrefix", value: "By ", caseInsensitive: true }],
    },
    publishedAt: { from: [{ select: 'meta[property="article:published_time"]', attr: "content" }] },
    heroImage: { from: [{ select: 'meta[property="og:image"]', attr: "content" }] },
    body: {
      root: "article",
      remove: [".byline", ".subscribe"],
      stopAt: [".comments"],
      blocks: [
        { select: "h2", as: "heading" },
        { select: "p", as: "paragraph" },
        { select: "li", as: "list" },
        { select: "blockquote", as: "quote" },
        { select: "img", as: "image" },
      ],
    },
    ...overrides,
  };
  for (const key of Object.keys(raw)) {
    if (raw[key] === undefined) {
      delete raw[key];
    }
  }
  return parseParserSpec(raw);
}

const articleHtml = `<!doctype html>
<html>
  <head>
    <meta property="og:title" content="OG Title">
    <meta name="author" content="Meta Author">
    <meta property="article:published_time" content="2026-01-02T03:04:05Z">
    <meta property="og:image" content="/images/hero.png">
    <style>.x { color: red; secretStyle }</style>
    <template><p>Hidden template</p></template>
  </head>
  <body>
    <article>
      <h1>  Visible   Title </h1>
      <p class="byline">By Ada Lovelace</p>
      <p>Fish &amp; chips.</p>
      <h2>Section <em>One</em></h2>
      <p>Second<br>paragraph.</p>
      <ul><li>Item one</li></ul>
      <blockquote>A   quote</blockquote>
      <p>Hello <script>secretToken()</script> world</p>
      <img src="inline.png" alt="An inline">
      <p class="subscribe">Subscribe now</p>
      <div class="comments"><p>A comment.</p></div>
    </article>
  </body>
</html>`;

describe("runParser", () => {
  test("extracts fields and body without applying host or path filters", () => {
    const spec = specFor();
    const parsed = runParser(spec, articleHtml, pageUrl);

    expect(parsed).toEqual({
      title: "Visible Title",
      byline: "Ada Lovelace",
      publishedAt: "2026-01-02T03:04:05Z",
      heroImageUrl: "https://example.com/images/hero.png",
      blocks: [
        { kind: "paragraph", text: "Fish & chips." },
        { kind: "heading", text: "Section One" },
        { kind: "paragraph", text: "Second paragraph." },
        { kind: "list", text: "Item one" },
        { kind: "quote", text: "A quote" },
        { kind: "paragraph", text: "Hello world" },
      ],
      images: [{ src: "https://example.com/posts/inline.png", alt: "An inline" }],
    });
    expect(JSON.stringify(parsed)).not.toContain("secretToken");
    expect(JSON.stringify(parsed)).not.toContain("secretStyle");
    expect(JSON.stringify(parsed)).not.toContain("Hidden template");
    expect(JSON.stringify(parsed)).not.toContain("Subscribe now");
    expect(JSON.stringify(parsed)).not.toContain("A comment");
    expect(JSON.stringify(parsed.blocks)).not.toContain("Ada Lovelace");
    expect(runParser(spec, articleHtml, pageUrl)).toEqual(parsed);
    expect(spec.hosts).toEqual(["news.example"]);
  });

  test("uses the first source that is non-empty after cleanup", () => {
    const spec = specFor({
      title: {
        from: [{ select: "h1" }, { select: 'meta[property="og:title"]', attr: "content" }],
        cleanup: [{ op: "stripPrefix", value: "Visible Title" }],
      },
    });

    const parsed = runParser(spec, articleHtml, pageUrl);

    expect(parsed.title).toBe("OG Title");
  });

  test("keeps title text that looks like a path, and resolves hero and srcset urls", () => {
    const spec = specFor({
      title: { from: [{ select: "h1" }] },
      heroImage: { from: [{ select: "img.hero", attr: "srcset" }] },
      body: {
        root: "article",
        blocks: [
          { select: "p", as: "paragraph" },
          { select: "img.figure", as: "image" },
        ],
      },
    });
    const html = `<article>
      <h1>news/story</h1>
      <img class="hero" srcset="/a.png 480w, /b.png 800w">
      <p>Body</p>
      <img class="figure" src="pic.png">
    </article>`;

    const parsed = runParser(spec, html, pageUrl);

    expect(parsed.title).toBe("news/story");
    expect(parsed.heroImageUrl).toBe("https://example.com/a.png");
    expect(parsed.images).toEqual([{ src: "https://example.com/posts/pic.png" }]);
  });

  test("applies cleanup in order and does not treat replaceExact as a substring edit", () => {
    const spec = specFor({
      byline: undefined,
      title: {
        from: [{ select: "h1" }],
        cleanup: [
          { op: "stripPrefix", value: "By ", caseInsensitive: true },
          { op: "stripSuffix", value: " | Site", caseInsensitive: true },
          { op: "replaceExact", from: "Title", to: "Headline" },
        ],
      },
      body: {
        root: "article",
        blocks: [
          { select: "p", as: "paragraph" },
          { select: "img", as: "image" },
        ],
        cleanup: [{ op: "stripPrefix", value: "Site:" }],
      },
    });
    const html = `<article>
      <h1>by Title | site</h1>
      <p>Site: Hello</p>
      <p>Site:</p>
      <p>Hellothere</p>
      <img src="x.png" alt="Site: Chart">
    </article>`;

    const parsed = runParser(spec, html, pageUrl);

    expect(parsed.title).toBe("Headline");
    expect(parsed.blocks.map((block) => block.text)).toEqual(["Hello", "Hellothere"]);
    expect(parsed.images).toEqual([{ src: "https://example.com/posts/x.png", alt: "Site: Chart" }]);
  });

  test("replaceExact leaves a different case unchanged", () => {
    const spec = specFor({
      title: {
        from: [{ select: "h1" }],
        cleanup: [{ op: "replaceExact", from: "Title", to: "Headline" }],
      },
    });

    expect(runParser(spec, "<article><h1>title</h1><p>Body</p></article>", pageUrl).title).toBe("title");
  });

  test("drops blocks by the text match after cleanup and keeps the rest", () => {
    const spec = specFor({
      byline: undefined,
      body: {
        root: "article",
        blocks: [
          { select: "p", as: "paragraph" },
          { select: "img", as: "image" },
        ],
        cleanup: [{ op: "stripPrefix", value: "Sponsor: " }],
        dropBlocksWhere: [
          { equals: "Buy now" },
          { startsWith: "Subscribe" },
          { contains: "subscribe", caseInsensitive: true },
          { equals: "Advertisement" },
        ],
      },
    });
    const html = `<article>
      <h1>Title</h1>
      <p>Sponsor: Buy now</p>
      <p>Subscribe to us</p>
      <p>Please subscribe now</p>
      <p>Buy now please</p>
      <p>The real story</p>
      <img src="ad.png" alt="Advertisement">
      <img src="chart.png" alt="A chart">
    </article>`;

    const parsed = runParser(spec, html, pageUrl);

    expect(parsed.blocks.map((block) => block.text)).toEqual(["Buy now please", "The real story"]);
    expect(parsed.images).toEqual([{ src: "https://example.com/posts/chart.png", alt: "A chart" }]);
  });

  test("removes subtrees before stopAt, and stopAt drops the match and everything after it", () => {
    const spec = specFor({
      byline: undefined,
      body: {
        root: "article",
        remove: [".promo"],
        stopAt: [".cutoff"],
        blocks: [{ select: "p", as: "paragraph" }],
      },
    });
    const html = `<article>
      <h1>Title</h1>
      <p>Keep</p>
      <aside class="promo"><div class="cutoff">inside promo</div><p>promo text</p></aside>
      <section>
        <p>Also keep</p>
        <div class="cutoff">End</div>
        <p>Drop inside</p>
      </section>
      <p>Drop after</p>
    </article>`;

    const parsed = runParser(spec, html, pageUrl);

    expect(parsed.blocks.map((block) => block.text)).toEqual(["Keep", "Also keep"]);
  });

  test("lets the outermost text block win and still collects an image inside it", () => {
    const spec = specFor({
      byline: undefined,
      body: {
        root: "article",
        blocks: [
          { select: "div.wrap", as: "paragraph" },
          { select: "p", as: "paragraph" },
          { select: "img", as: "image" },
        ],
      },
    });
    const html = `<article>
      <h1>Title</h1>
      <div class="wrap"><p>Inner</p><img src="pic.png" alt="Pic"></div>
    </article>`;

    const parsed = runParser(spec, html, pageUrl);

    expect(parsed.blocks).toEqual([{ kind: "paragraph", text: "Inner" }]);
    expect(parsed.images).toEqual([{ src: "https://example.com/posts/pic.png", alt: "Pic" }]);
  });

  test("matches child combinators, :not, and :first-of-type", () => {
    const spec = specFor({
      byline: undefined,
      body: {
        root: "article",
        blocks: [
          { select: "article > p:not(.ad)", as: "paragraph" },
          { select: "h2:first-of-type", as: "heading" },
        ],
      },
    });
    const html = `<article>
      <h1>Title</h1>
      <p class="ad">Ad</p>
      <p>Direct</p>
      <div><p>Nested</p></div>
      <h2>First</h2>
      <h2>Second</h2>
    </article>`;

    const parsed = runParser(spec, html, pageUrl);

    expect(parsed.blocks).toEqual([
      { kind: "paragraph", text: "Direct" },
      { kind: "heading", text: "First" },
    ]);
  });

  test("collapses non-breaking spaces", () => {
    const spec = specFor({ byline: undefined, body: { root: "article", blocks: [{ select: "p", as: "paragraph" }] } });
    const parsed = runParser(spec, "<article><h1>Title</h1><p>Hello&nbsp;world</p></article>", pageUrl);
    expect(parsed.blocks).toEqual([{ kind: "paragraph", text: "Hello world" }]);
  });

  test("requires the body root to match exactly one element", () => {
    const spec = specFor();
    expect(() => runParser(spec, "<div><p>No article</p></div>", pageUrl)).toThrow(ParserRunError);
    expect(() => runParser(spec, "<div><p>No article</p></div>", pageUrl)).toThrow(/matched 0/);
    expect(() => runParser(spec, "<article></article><article></article>", pageUrl)).toThrow(/matched 2/);
  });

  test("requires an absolute http(s) page url", () => {
    const spec = specFor();
    const html = "<article><h1>Title</h1><p>Body</p></article>";
    expect(() => runParser(spec, html, "example.com/posts/one")).toThrow(ParserRunError);
    expect(() => runParser(spec, html, "ftp://example.com/a")).toThrow(/http/);
    const parsed = runParser(spec, html, "http://example.com/posts/one");
    expect(parsed.title).toBe("Title");
  });

  test("does not copy script element source into the article", () => {
    const spec = specFor({
      byline: undefined,
      body: {
        root: "article",
        blocks: [
          { select: "script", as: "paragraph" },
          { select: "p", as: "paragraph" },
        ],
      },
    });
    const parsed = runParser(
      spec,
      "<article><h1>Title</h1><script>secretToken()</script><p>Visible</p></article>",
      pageUrl,
    );

    expect(parsed.blocks).toEqual([{ kind: "paragraph", text: "Visible" }]);
    expect(JSON.stringify(parsed)).not.toContain("secretToken");
  });
});

describe("toStory", () => {
  test("maps text blocks onto a story and omits missing author, hero, and headings", () => {
    const spec = specFor();
    const parsed = runParser(spec, articleHtml, pageUrl);
    const story = toStory(parsed, pageUrl, now);

    const text = [
      "Fish & chips.",
      "Section One",
      "Second paragraph.",
      "Item one",
      "A quote",
      "Hello world",
    ].join("\n\n");
    expect(story).toEqual({
      sourceUrl: pageUrl,
      title: "Visible Title",
      author: "Ada Lovelace",
      heroImageOriginalUrl: "https://example.com/images/hero.png",
      sectionTitles: ["Section One"],
      contentBlocks: [
        { type: "paragraph", text: "Fish & chips." },
        { type: "heading", text: "Section One" },
        { type: "paragraph", text: "Second paragraph." },
        { type: "list", text: "Item one" },
        { type: "quote", text: "A quote" },
        { type: "paragraph", text: "Hello world" },
      ],
      text,
      wordCount: 13,
      characterCount: text.length,
      extractedAt: "2026-04-05T06:07:08.000Z",
    });
    expect(story).not.toHaveProperty("publishedAt");
    expect(story).not.toHaveProperty("images");
    expect(story.text).not.toContain("inline.png");
  });

  test("omits the author and hero when the parser did not find them", () => {
    const spec = specFor({
      byline: undefined,
      heroImage: undefined,
      body: { root: "article", blocks: [{ select: "p", as: "paragraph" }] },
    });
    const story = toStory(
      runParser(spec, "<article><h1>Title</h1><p>Only body</p></article>", pageUrl),
      pageUrl,
      now,
    );

    expect(story.title).toBe("Title");
    expect(story.text).toBe("Only body");
    expect(story.wordCount).toBe(2);
    expect(story).not.toHaveProperty("author");
    expect(story).not.toHaveProperty("heroImageOriginalUrl");
    expect(story).not.toHaveProperty("sectionTitles");
    expect(story.extractedAt).toBe(now.toISOString());
  });
});

describe("checkInvariants", () => {
  test("accepts the extracted article", () => {
    expect(checkInvariants(runParser(specFor(), articleHtml, pageUrl))).toEqual([]);
  });

  test("reports an empty title and an empty body", () => {
    const spec = specFor({
      title: { from: [{ select: "h1" }] },
      byline: undefined,
      body: { root: "article", blocks: [{ select: "p", as: "paragraph" }] },
    });
    const parsed = runParser(spec, "<article><h1> </h1><p> </p></article>", pageUrl);

    expect(parsed.title).toBe("");
    expect(parsed.blocks).toEqual([]);
    expect(checkInvariants(parsed)).toEqual([
      { code: "empty_title", detail: expect.stringContaining("title") },
      { code: "empty_body", detail: expect.stringContaining("body") },
    ]);
  });

  test("flags tag-shaped text and escaped markup as raw html", () => {
    const spec = specFor({
      byline: undefined,
      body: { root: "article", blocks: [{ select: "p", as: "paragraph" }] },
    });
    const tagged = runParser(spec, "<article><h1>Title</h1><p>See &lt;b&gt;x&lt;/b&gt;</p></article>", pageUrl);
    const escaped = runParser(spec, "<article><h1>Title</h1><p>See &amp;lt;b&amp;gt;</p></article>", pageUrl);

    expect(checkInvariants(tagged)).toEqual([
      { code: "raw_html", detail: expect.stringContaining("blocks[0]") },
    ]);
    expect(checkInvariants(escaped)).toEqual([
      { code: "raw_html", detail: expect.stringContaining("blocks[0]") },
    ]);
    expect(checkInvariants(tagged)[0]?.code).not.toBe("script_text");
  });

  test("flags javascript urls and script tags without flagging ordinary prose", () => {
    const spec = specFor({
      byline: undefined,
      heroImage: { from: [{ select: "meta[name=image]", attr: "content" }] },
      body: {
        root: "article",
        blocks: [
          { select: "p", as: "paragraph" },
          { select: "img", as: "image" },
        ],
      },
    });
    const parsed = runParser(
      spec,
      `<article>
        <h1>Title</h1>
        <meta name="image" content="javascript:alert(1)">
        <p>The word javascript is ordinary.</p>
        <img src="javascript:alert(2)" alt="chart">
      </article>`,
      pageUrl,
    );

    expect(checkInvariants(parsed).map((issue) => issue.code)).toEqual(["script_text", "script_text"]);
    expect(JSON.stringify(checkInvariants(parsed))).toContain("heroImageUrl");
    expect(JSON.stringify(checkInvariants(parsed))).toContain("images[0].src");

    const scriptTag = runParser(
      spec,
      "<article><h1>Title</h1><p>Before &lt;script&gt;alert(1)&lt;/script&gt;</p></article>",
      pageUrl,
    );
    expect(checkInvariants(scriptTag).map((issue) => issue.code)).toEqual(["script_text", "raw_html"]);
  });

  test("does not flag a comparison that uses a less-than sign", () => {
    const spec = specFor({
      byline: undefined,
      body: { root: "article", blocks: [{ select: "p", as: "paragraph" }] },
    });
    const parsed = runParser(spec, "<article><h1>Title</h1><p>a &lt; b</p></article>", pageUrl);
    expect(parsed.blocks[0]?.text).toBe("a < b");
    expect(checkInvariants(parsed)).toEqual([]);
  });
});

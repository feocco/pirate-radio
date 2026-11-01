import { describe, expect, test } from "vitest";
import { parseParserSpec, ParserSpecError, parserSpecLimits } from "../src/parsers/spec.js";

function rawSpec(overrides: Record<string, unknown> = {}) {
  return {
    schema: "pirate-radio/parser-spec@1",
    id: "example-news",
    displayName: "Example News",
    hosts: ["example.com"],
    title: { from: [{ select: "h1" }] },
    body: {
      root: "article",
      blocks: [{ select: "p", as: "paragraph" }],
    },
    ...overrides,
  };
}

function expectSpecError(raw: unknown): ParserSpecError {
  try {
    parseParserSpec(raw);
  } catch (error) {
    expect(error).toBeInstanceOf(ParserSpecError);
    return error as ParserSpecError;
  }
  throw new Error("expected ParserSpecError");
}

function expectIssue(error: ParserSpecError, path: string, message: string) {
  expect(error.issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path, message: expect.stringContaining(message) }),
    ]),
  );
}

describe("parseParserSpec", () => {
  test("parses a full v1 spec, preserves selectors, and freezes the result", () => {
    const raw = rawSpec({
      displayName: "Déjà News",
      paths: { prefixes: ["/p/"] },
      byline: {
        from: [{ select: ".byline" }],
        cleanup: [{ op: "stripPrefix", value: "By ", caseInsensitive: true }],
      },
      publishedAt: { from: [{ select: "time", attr: "datetime" }] },
      heroImage: { from: [{ select: 'meta[property="og:image"]', attr: "content" }] },
      body: {
        root: "article",
        remove: [".ad"],
        stopAt: [".comments"],
        blocks: [
          { select: "h2", as: "heading" },
          { select: "p:not(.ad)", as: "paragraph" },
          { select: "li", as: "list" },
          { select: "blockquote", as: "quote" },
          { select: "img", as: "image" },
        ],
        dropBlocksWhere: [{ contains: "subscribe", caseInsensitive: true }],
        cleanup: [
          { op: "stripSuffix", value: " | Site" },
          { op: "replaceExact", from: "Hello", to: "Hi" },
        ],
      },
    });
    const clone = structuredClone(raw);

    const spec = parseParserSpec(raw);

    expect(raw).toEqual(clone);
    expect(spec).toMatchObject({
      schema: "pirate-radio/parser-spec@1",
      id: "example-news",
      displayName: "Déjà News",
      hosts: ["example.com"],
      paths: { prefixes: ["/p/"] },
    });
    expect(spec.body.blocks[1].select).toBe("p:not(.ad)");
    expect(spec.body.root).toBe("article");
    expect(Object.isFrozen(spec)).toBe(true);
    expect(Object.isFrozen(spec.hosts)).toBe(true);
    expect(Object.isFrozen(spec.body)).toBe(true);
    expect(Object.isFrozen(spec.body.blocks)).toBe(true);
  });

  test("locks the schema caps from the phase 1 design", () => {
    expect(parserSpecLimits).toEqual({
      id: 64,
      displayName: 80,
      hosts: 4,
      hostname: 253,
      pathPrefixes: 8,
      pathPrefixLength: 128,
      selector: 160,
      fieldSources: 8,
      cleanups: 8,
      textValue: 200,
      remove: 16,
      stopAt: 8,
      blocks: 16,
      dropBlocks: 16,
    });
  });

  test("accepts the allowlisted selector grammar", () => {
    const selectors = [
      "article",
      "h1",
      "#main",
      ".post-body",
      "div#main.story",
      "meta[property]",
      'meta[property="og:title"]',
      'a[rel~="author"]',
      'a[href^="https://"]',
      'img[src*="hero"]',
      "article p",
      "article > p",
      "h1, h2",
      "p:not(.ad)",
      "p:not([data-ad])",
      "p:not(:first-of-type)",
      "h2:first-of-type",
      "p:nth-of-type(n)",
      "p:nth-of-type(2n+1)",
      "p:nth-of-type(2n + 1)",
      "p:nth-of-type(odd)",
      "p:nth-of-type(3)",
      "p:nth-of-type(-n+3)",
      "article > div.post p:first-of-type",
    ];

    for (const select of selectors) {
      const spec = parseParserSpec(
        rawSpec({ body: { root: "article", blocks: [{ select, as: "paragraph" }] } }),
      );
      expect(spec.body.blocks[0].select).toBe(select);
    }
  });

  test("accepts a selector of exactly 160 characters and each allowed attribute", () => {
    const select = `p.${"a".repeat(158)}`;
    expect(select.length).toBe(parserSpecLimits.selector);
    expect(() =>
      parseParserSpec(rawSpec({ body: { root: "article", blocks: [{ select, as: "paragraph" }] } })),
    ).not.toThrow();

    for (const attr of ["content", "datetime", "src", "srcset", "href", "alt", "title"] as const) {
      expect(() => parseParserSpec(rawSpec({ title: { from: [{ select: "meta", attr }] } }))).not.toThrow();
    }
  });

  test("accepts four hosts and the boundary counts for lists", () => {
    expect(() =>
      parseParserSpec(
        rawSpec({
          hosts: ["a.example", "b.example", "c.example", "d.example"],
          paths: { prefixes: Array.from({ length: parserSpecLimits.pathPrefixes }, (_, index) => `/p${index}/`) },
          title: {
            from: Array.from({ length: parserSpecLimits.fieldSources }, () => ({ select: "h1" })),
            cleanup: Array.from({ length: parserSpecLimits.cleanups }, () => ({
              op: "stripPrefix",
              value: "By ",
            })),
          },
          body: {
            root: "article",
            remove: Array.from({ length: parserSpecLimits.remove }, (_, index) => `.r${index}`),
            stopAt: Array.from({ length: parserSpecLimits.stopAt }, (_, index) => `.s${index}`),
            blocks: Array.from({ length: parserSpecLimits.blocks }, () => ({ select: "p", as: "paragraph" })),
            dropBlocksWhere: Array.from({ length: parserSpecLimits.dropBlocks }, (_, index) => ({
              equals: `drop${index}`,
            })),
          },
        }),
      ),
    ).not.toThrow();
  });

  test.each([
    ["Example", "kebab-case"],
    ["example_news", "kebab-case"],
    ["-example", "kebab-case"],
    ["example-", "kebab-case"],
    ["example--news", "kebab-case"],
    ["example news", "kebab-case"],
  ])("rejects id %s", (id, message) => {
    expectIssue(expectSpecError(rawSpec({ id })), "id", message);
  });

  test("rejects an id longer than 64 characters", () => {
    expectIssue(expectSpecError(rawSpec({ id: `a${"b".repeat(64)}` })), "id", "64");
  });

  test("rejects a schema other than parser-spec@1", () => {
    expectIssue(expectSpecError(rawSpec({ schema: "pirate-radio/parser-spec@2" })), "schema", "pirate-radio/parser-spec@1");
  });

  test("rejects unknown keys instead of carrying executable fields", () => {
    const error = expectSpecError(rawSpec({ pattern: ".*", code: "process.exit()" }));
    expectIssue(error, "pattern", "unknown key");
    expectIssue(error, "code", "unknown key");
  });

  test("rejects a display name that is empty, padded, too long, or tag-shaped", () => {
    expectIssue(expectSpecError(rawSpec({ displayName: "" })), "displayName", "displayName");
    expectIssue(expectSpecError(rawSpec({ displayName: " Example" })), "displayName", "whitespace");
    expectIssue(expectSpecError(rawSpec({ displayName: "x".repeat(81) })), "displayName", "80");
    expectIssue(expectSpecError(rawSpec({ displayName: "<Example>" })), "displayName", "displayName");
  });

  test("rejects hosts that are not canonical lowercase hostnames", () => {
    expectIssue(expectSpecError(rawSpec({ hosts: [] })), "hosts", "at least 1");
    expectIssue(
      expectSpecError(rawSpec({ hosts: ["a.example", "b.example", "c.example", "d.example", "e.example"] })),
      "hosts",
      "at most 4",
    );
    expectIssue(expectSpecError(rawSpec({ hosts: ["www.example.com"] })), "hosts[0]", "www.");
    expectIssue(expectSpecError(rawSpec({ hosts: ["Example.com"] })), "hosts[0]", "lowercase hostname");
    expectIssue(expectSpecError(rawSpec({ hosts: ["example.com:443"] })), "hosts[0]", "lowercase hostname");
    expectIssue(expectSpecError(rawSpec({ hosts: ["example.com/news"] })), "hosts[0]", "lowercase hostname");
    expectIssue(expectSpecError(rawSpec({ hosts: ["127.0.0.1"] })), "hosts[0]", "lowercase hostname");
    expectIssue(expectSpecError(rawSpec({ hosts: ["example.com", "example.com"] })), "hosts[1]", "duplicate");
    expectIssue(expectSpecError(rawSpec({ hosts: ["a".repeat(254)] })), "hosts[0]", "253");
  });

  test("rejects path prefixes that are not site-relative paths", () => {
    expectIssue(expectSpecError(rawSpec({ paths: { prefixes: [] } })), "paths.prefixes", "at least 1");
    expectIssue(expectSpecError(rawSpec({ paths: { prefixes: ["news"] } })), "paths.prefixes[0]", "start with /");
    expectIssue(expectSpecError(rawSpec({ paths: { prefixes: ["/a?b=1"] } })), "paths.prefixes[0]", "start with /");
    expectIssue(expectSpecError(rawSpec({ paths: { prefixes: ["/a#b"] } })), "paths.prefixes[0]", "start with /");
    expectIssue(expectSpecError(rawSpec({ paths: { prefixes: ["/a/../b"] } })), "paths.prefixes[0]", "start with /");
    expectIssue(expectSpecError(rawSpec({ paths: { prefixes: ["/a", "/a"] } })), "paths.prefixes[1]", "duplicate");
    expectIssue(expectSpecError(rawSpec({ paths: { prefixes: ["/ok"], pattern: ".*" } })), "paths.pattern", "unknown key");
    expectIssue(
      expectSpecError(
        rawSpec({
          paths: { prefixes: Array.from({ length: parserSpecLimits.pathPrefixes + 1 }, (_, index) => `/p${index}`) },
        }),
      ),
      "paths.prefixes",
      "at most 8",
    );
  });

  test.each([
    [":has(img)", ":has"],
    [":contains(Subscribe)", ":contains"],
    [":is(p)", ":is"],
    [":where(p)", ":where"],
    ["p:nth-child(2)", ":nth-child"],
    ["p:first-child", ":first-child"],
    ["p:nth-of-type(n of p)", "An+B"],
    ["p + p", ">"],
    ["p ~ p", ">"],
    ["*", "universal"],
    ["::before", "pseudo-element"],
    ['[href$=".pdf"]', "~="],
    ['[href|="en"]', "~="],
    ['[href!="x"]', "~="],
    ['[href="x" i]', "case"],
    ["svg|a", "namespace"],
    ["p:not(div.foo)", "simple selector"],
    ["p:not(div p)", "simple selector"],
    [":not(:not(p))", "simple selector"],
    ["", "empty"],
    [`p.${"a".repeat(159)}`, "160"],
  ])("rejects selector %s", (select, message) => {
    const error = expectSpecError(
      rawSpec({ body: { root: "article", blocks: [{ select, as: "paragraph" }] } }),
    );
    expectIssue(error, "body.blocks[0].select", message);
  });

  test("rejects disallowed attributes, block kinds, and text-match shapes", () => {
    expectIssue(
      expectSpecError(rawSpec({ title: { from: [{ select: "meta", attr: "innerHTML" }] } })),
      "title.from[0].attr",
      "content, datetime, src, srcset, href, alt, title",
    );
    expectIssue(
      expectSpecError(rawSpec({ body: { root: "article", blocks: [{ select: "p", as: "html" }] } })),
      "body.blocks[0].as",
      "paragraph, heading, list, quote, image",
    );
    expectIssue(
      expectSpecError(rawSpec({ body: { root: "article", blocks: [{ select: "p", as: "paragraph" }], dropBlocksWhere: [{ pattern: ".*" }] } })),
      "body.dropBlocksWhere[0]",
      "equals, startsWith, or contains",
    );
    expectIssue(
      expectSpecError(
        rawSpec({
          body: {
            root: "article",
            blocks: [{ select: "p", as: "paragraph" }],
            dropBlocksWhere: [{ equals: "A", contains: "B" }],
          },
        }),
      ),
      "body.dropBlocksWhere[0]",
      "equals, startsWith, or contains",
    );
    expectIssue(
      expectSpecError(rawSpec({ title: { from: [{ select: "h1" }], cleanup: [{ op: "replaceRegex", from: "a", to: "b" }] } })),
      "title.cleanup[0].op",
      "stripPrefix, stripSuffix, or replaceExact",
    );
  });

  test("rejects empty required lists and overlong text rules", () => {
    expectIssue(expectSpecError(rawSpec({ title: { from: [] } })), "title.from", "at least 1");
    expectIssue(
      expectSpecError(rawSpec({ body: { root: "article", blocks: [] } })),
      "body.blocks",
      "at least 1",
    );
    expectIssue(
      expectSpecError(rawSpec({ title: { from: [{ select: "h1" }], cleanup: [{ op: "stripPrefix", value: "" }] } })),
      "title.cleanup[0].value",
      "empty",
    );
    expectIssue(
      expectSpecError(
        rawSpec({
          title: { from: [{ select: "h1" }], cleanup: [{ op: "stripPrefix", value: "x".repeat(201) }] },
        }),
      ),
      "title.cleanup[0].value",
      "200",
    );
    expectIssue(expectSpecError(rawSpec({ body: { blocks: [{ select: "p", as: "paragraph" }] } })), "body.root", "root");
  });

  test("reports every issue instead of stopping at the first", () => {
    const error = expectSpecError({
      ...rawSpec({ hosts: ["www.example.com", "example.com", "example.com"] }),
      extra: true,
    });
    expectIssue(error, "hosts[0]", "www.");
    expectIssue(error, "hosts[2]", "duplicate");
    expectIssue(error, "extra", "unknown key");
    expect(error.issues.length).toBeGreaterThanOrEqual(3);
  });

  test.each([null, [], "spec", 4])("rejects non-object input %s", (raw) => {
    expectIssue(expectSpecError(raw), "$", "JSON object");
  });
});

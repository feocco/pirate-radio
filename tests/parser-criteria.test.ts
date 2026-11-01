import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { runParser, toStory } from "../src/parsers/engine.js";
import { checkInvariants } from "../src/parsers/invariants.js";
import {
  criteriaDigest,
  evaluateCriteria,
  parseParserCriteria,
  CriteriaError,
  type AcceptanceGate,
  type CriteriaExample,
  type ParserCriteriaV1,
} from "../src/parsers/criteria.js";
import { parseParserSpec, type ParserSpecV1 } from "../src/parsers/spec.js";

const submissionId = "11111111-1111-4111-8111-111111111111";
const pageUrl = "https://news.example/posts/harbor";
const rawSnapshotSha256 = "ab".repeat(32);
const title = "Harbor Report";
const firstWords = ["Alpha", "bravo", "charlie", "delta", "echo"] as const;
const lastWords = ["omega", "psi", "chi", "phi", "upsilon"] as const;
const phrases = ["middle phrase one", "middle phrase two"] as const;
const lead = "Alpha bravo charlie delta echo";
const heading = "middle phrase one";
const tailText = "lives here and a < b stays prose then middle phrase two follows before omega psi chi phi upsilon";
const tailHtml = "lives here and a &lt; b stays prose then middle phrase two follows before omega psi chi phi upsilon";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function article(options: { title?: string; lead?: string; heading?: string; tail?: string; byline?: string; publishedAt?: string; hero?: string; imageSrc?: string; extra?: string } = {}): string {
  const byline = options.byline ?? "Ada Lovelace";
  const publishedAt = options.publishedAt ?? "2026-01-02T03:04:05Z";
  const hero = options.hero ?? "/images/hero.png";
  const imageSrc = options.imageSrc ?? "/images/figure.png";
  return `<!doctype html>
<html>
  <head><meta property="og:image" content="${hero}"></head>
  <body>
    <article>
      <h1>${options.title ?? title}</h1>
      <p class="byline">${byline}</p>
      <time datetime="${publishedAt}">January 2</time>
      <script>secretToken()</script>
      <p>${options.lead ?? lead}</p>
      <h2>${options.heading ?? heading}</h2>
      <p>${options.tail ?? tailHtml}</p>
      <img src="${imageSrc}" alt="A chart">
      ${options.extra ?? ""}
    </article>
  </body>
</html>`;
}

function spec(overrides: Record<string, unknown> = {}): ParserSpecV1 {
  return parseParserSpec({
    schema: "pirate-radio/parser-spec@1",
    id: "example-news",
    displayName: "Example News",
    hosts: ["news.example"],
    title: { from: [{ select: "h1" }] },
    byline: { from: [{ select: "p.byline" }] },
    publishedAt: { from: [{ select: "time", attr: "datetime" }] },
    heroImage: { from: [{ select: 'meta[property="og:image"]', attr: "content" }] },
    body: {
      root: "article",
      remove: [".byline"],
      blocks: [
        { select: "h2", as: "heading" },
        { select: "p", as: "paragraph" },
        { select: "img", as: "image" },
      ],
    },
    ...overrides,
  });
}

function exampleFor(html: string, overrides: Partial<CriteriaExample> = {}): CriteriaExample {
  const fixture = `fixtures/${sha256(html)}.html`;
  return {
    submissionId,
    url: pageUrl,
    rawSnapshotSha256,
    title,
    firstWords: [...firstWords],
    lastWords: [...lastWords],
    phrases: [...phrases],
    ...overrides,
    fixture: overrides.fixture ?? fixture,
  };
}

function criteriaFor(examples: CriteriaExample[], overrides: Record<string, unknown> = {}): ParserCriteriaV1 {
  return parseParserCriteria({
    schema: "pirate-radio/parser-criteria@1",
    parserId: "example-news",
    host: "news.example",
    digest: criteriaDigest(examples),
    examples,
    ...overrides,
  });
}

function filesFor(entries: Array<[string, string]>): (path: string) => string {
  const files = new Map(entries);
  return (path) => {
    const html = files.get(path);
    if (html === undefined) throw new Error(`missing fixture ${path}`);
    return html;
  };
}

function expectCriteriaError(raw: unknown): CriteriaError {
  try {
    parseParserCriteria(raw);
  } catch (error) {
    expect(error).toBeInstanceOf(CriteriaError);
    return error as CriteriaError;
  }
  throw new Error("expected CriteriaError");
}

function expectOnlyGate(report: ReturnType<typeof evaluateCriteria>, gate: AcceptanceGate, detail: string) {
  expect(report.gates.map((row) => row.gate)).toEqual([
    "title",
    "first_words",
    "last_words",
    "phrases_ordered",
    "no_script_or_raw_html",
  ]);
  for (const row of report.gates) {
    if (row.gate === gate) {
      expect(row).toEqual({ example: 0, gate, ok: false, detail });
    } else {
      expect(row).toEqual({ example: 0, gate: row.gate, ok: true });
    }
  }
}

describe("parseParserCriteria", () => {
  test("accepts one example and digests the normalized examples", () => {
    const html = article();
    const collapsed = exampleFor(html, { title: "Harbor Report" });
    const parsed = parseParserCriteria({
      schema: "pirate-radio/parser-criteria@1",
      parserId: "example-news",
      host: "news.example",
      digest: criteriaDigest([collapsed]),
      examples: [{ ...collapsed, title: "Harbor   Report" }],
    });

    expect(parsed.examples[0]?.title).toBe("Harbor Report");
    expect(parsed.digest).toBe(criteriaDigest(parsed.examples));
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.examples[0]?.firstWords)).toBe(true);

    const canonical = JSON.stringify([
      {
        firstWords: [...firstWords],
        fixture: collapsed.fixture,
        lastWords: [...lastWords],
        phrases: [...phrases],
        rawSnapshotSha256,
        submissionId,
        title,
        url: pageUrl,
      },
    ]);
    expect(parsed.digest).toBe(createHash("sha256").update(canonical).digest("hex"));
  });

  test("rejects a digest, host, fixture, or example shape that is not the human pin", () => {
    const html = article();
    const example = exampleFor(html);
    const base = {
      schema: "pirate-radio/parser-criteria@1",
      parserId: "example-news",
      host: "news.example",
      digest: criteriaDigest([example]),
      examples: [example],
    };

    expect(expectCriteriaError({ ...base, digest: "ab".repeat(32) }).issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "digest" })]),
    );
    expect(expectCriteriaError({ ...base, wordCount: 10 }).issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "wordCount" })]),
    );
    expect(expectCriteriaError({ ...base, examples: [] }).issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "examples" })]),
    );
    expect(expectCriteriaError({ ...base, examples: [example, example, example, example] }).issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "examples" })]),
    );
    expect(expectCriteriaError({ ...base, host: "www.news.example" }).issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "host" })]),
    );
    expect(
      expectCriteriaError({
        ...base,
        examples: [{ ...example, url: "https://other.example/posts/harbor" }],
        digest: criteriaDigest([{ ...example, url: "https://other.example/posts/harbor" }]),
      }).issues,
    ).toEqual(expect.arrayContaining([expect.objectContaining({ path: "examples[0].url" })]));
    expect(
      expectCriteriaError({
        ...base,
        examples: [{ ...example, url: "https://user:pass@news.example/posts/harbor" }],
      }).issues,
    ).toEqual(expect.arrayContaining([expect.objectContaining({ path: "examples[0].url" })]));
    expect(
      expectCriteriaError({
        ...base,
        examples: [{ ...example, fixture: "fixtures/not-a-hash.html" }],
      }).issues,
    ).toEqual(expect.arrayContaining([expect.objectContaining({ path: "examples[0].fixture" })]));
    expect(
      expectCriteriaError({
        ...base,
        examples: [{ ...example, phrases: ["middle phrase one"] }],
        digest: criteriaDigest([{ ...example, phrases: ["middle phrase one"] }]),
      }).issues,
    ).toEqual(expect.arrayContaining([expect.objectContaining({ path: "examples[0].phrases" })]));
    expect(
      expectCriteriaError({
        ...base,
        examples: [{ ...example, phrases: ["one two", "middle phrase two"] }],
      }).issues,
    ).toEqual(expect.arrayContaining([expect.objectContaining({ path: "examples[0].phrases[0]" })]));
    expect(
      expectCriteriaError({
        ...base,
        examples: [{ ...example, phrases: ["middle phrase one", "middle phrase one"] }],
      }).issues,
    ).toEqual(expect.arrayContaining([expect.objectContaining({ path: "examples[0].phrases" })]));
    expect(
      expectCriteriaError({
        ...base,
        examples: [{ ...example, firstWords: ["Alpha bravo", "charlie", "delta", "echo", "foxtrot"] }],
      }).issues,
    ).toEqual(expect.arrayContaining([expect.objectContaining({ path: "examples[0].firstWords[0]" })]));
  });

  test("accepts three phrases and three examples", () => {
    const html = article();
    const third = "stays prose then";
    const one = exampleFor(html, { phrases: [...phrases, third] });
    const two = { ...one, submissionId: "22222222-2222-4222-8222-222222222222" };
    const three = { ...one, submissionId: "33333333-3333-4333-8333-333333333333" };
    const parsed = criteriaFor([one, two, three]);
    expect(parsed.examples).toHaveLength(3);
    expect(parsed.examples[0]?.phrases).toEqual([...phrases, third]);
  });
});

describe("evaluateCriteria", () => {
  test("passes the five gates for one example and reports story metadata", () => {
    const html = article();
    const example = exampleFor(html);
    const parsedSpec = spec();
    const report = evaluateCriteria(parsedSpec, criteriaFor([example]), filesFor([[example.fixture, html]]));
    const story = toStory(
      {
        title,
        byline: "Ada Lovelace",
        publishedAt: "2026-01-02T03:04:05Z",
        heroImageUrl: "https://news.example/images/hero.png",
        blocks: [
          { kind: "paragraph", text: lead },
          { kind: "heading", text: heading },
          { kind: "paragraph", text: tailText },
        ],
        images: [{ src: "https://news.example/images/figure.png", alt: "A chart" }],
      },
      pageUrl,
      new Date(0),
    );

    expect(report.gates).toEqual([
      { example: 0, gate: "title", ok: true },
      { example: 0, gate: "first_words", ok: true },
      { example: 0, gate: "last_words", ok: true },
      { example: 0, gate: "phrases_ordered", ok: true },
      { example: 0, gate: "no_script_or_raw_html", ok: true },
    ]);
    expect(report.metadata).toEqual([
      {
        author: "Ada Lovelace",
        publishedAt: "2026-01-02T03:04:05Z",
        heroImageUrl: "https://news.example/images/hero.png",
        wordCount: story.wordCount,
        characterCount: story.characterCount,
        imageCount: 1,
      },
    ]);
    expect(story.wordCount).toBe(27);
    expect(story.text).toBe([lead, heading, tailText].join("\n\n"));
    expect(JSON.stringify(report)).not.toContain("secretToken");
    expect(report.metadata[0]?.wordCount).toBe(story.wordCount);
    expect(report.metadata[0]?.characterCount).toBe(story.characterCount);
  });

  test("fails title only when the extracted title differs", () => {
    const html = article({ title: "Harbor Notes" });
    const example = exampleFor(html);
    const report = evaluateCriteria(spec(), criteriaFor([example]), filesFor([[example.fixture, html]]));
    expectOnlyGate(report, "title", 'expected "Harbor Report", extracted "Harbor Notes"');
    expect(report.metadata[0]?.author).toBe("Ada Lovelace");
  });

  test("fails first_words only when the first five body words differ", () => {
    const html = article({ lead: "Alfa bravo charlie delta echo" });
    const example = exampleFor(html);
    const report = evaluateCriteria(spec(), criteriaFor([example]), filesFor([[example.fixture, html]]));
    expectOnlyGate(
      report,
      "first_words",
      'expected "Alpha bravo charlie delta echo", extracted "Alfa bravo charlie delta echo"',
    );
  });

  test("fails last_words only when the last five body words differ", () => {
    const html = article({
      tail: "lives here and a &lt; b stays prose then middle phrase two follows before omega psi chi phi upsilonx",
    });
    const example = exampleFor(html);
    const report = evaluateCriteria(spec(), criteriaFor([example]), filesFor([[example.fixture, html]]));
    expectOnlyGate(
      report,
      "last_words",
      'expected "omega psi chi phi upsilon", extracted "omega psi chi phi upsilonx"',
    );
  });

  test("fails phrases_ordered when the phrases are out of order or not strictly between the anchors", () => {
    const html = article();
    const swapped = exampleFor(html, { phrases: ["middle phrase two", "middle phrase one"] });
    const swappedReport = evaluateCriteria(spec(), criteriaFor([swapped]), filesFor([[swapped.fixture, html]]));
    expectOnlyGate(
      swappedReport,
      "phrases_ordered",
      'phrase 2 "middle phrase one" is not between the anchors in order',
    );

    const anchored = exampleFor(html, { phrases: ["Alpha bravo charlie", "middle phrase two"] });
    const anchoredReport = evaluateCriteria(spec(), criteriaFor([anchored]), filesFor([[anchored.fixture, html]]));
    expectOnlyGate(
      anchoredReport,
      "phrases_ordered",
      'phrase 1 "Alpha bravo charlie" is not between the anchors in order',
    );

    const trailing = exampleFor(html, { phrases: ["follows before omega", "middle phrase one"] });
    const trailingReport = evaluateCriteria(spec(), criteriaFor([trailing]), filesFor([[trailing.fixture, html]]));
    expectOnlyGate(
      trailingReport,
      "phrases_ordered",
      'phrase 1 "follows before omega" is not between the anchors in order',
    );

    const friendHtml = article({
      heading: "someone two three",
      tail: "lives in the middle here before omega psi chi phi upsilon",
    });
    const friend = exampleFor(friendHtml, { phrases: ["one two three", "lives in the"] });
    const friendReport = evaluateCriteria(spec(), criteriaFor([friend]), filesFor([[friend.fixture, friendHtml]]));
    expectOnlyGate(friendReport, "phrases_ordered", 'phrase 1 "one two three" is not between the anchors in order');

    const wholeWords = exampleFor(friendHtml, { phrases: ["two three lives", "in the middle"] });
    const wholeReport = evaluateCriteria(spec(), criteriaFor([wholeWords]), filesFor([[wholeWords.fixture, friendHtml]]));
    expect(wholeReport.gates.find((row) => row.gate === "phrases_ordered")).toEqual({
      example: 0,
      gate: "phrases_ordered",
      ok: true,
    });
  });

  test("fails no_script_or_raw_html when the title or a block contains script or raw HTML", () => {
    const scriptHtml = article({
      tail: "lives here and a &lt; b stays prose javascript:alert(1) then middle phrase two follows before omega psi chi phi upsilon",
    });
    const scriptExample = exampleFor(scriptHtml);
    const scriptReport = evaluateCriteria(spec(), criteriaFor([scriptExample]), filesFor([[scriptExample.fixture, scriptHtml]]));
    expectOnlyGate(scriptReport, "no_script_or_raw_html", "blocks[2] contains script content");

    const rawTail = "lives here and a &lt; b stays prose &amp;lt;b&amp;gt; then middle phrase two follows before omega psi chi phi upsilon";
    const rawHtml = article({ tail: rawTail });
    const rawExample = exampleFor(rawHtml);
    const rawReport = evaluateCriteria(spec(), criteriaFor([rawExample]), filesFor([[rawExample.fixture, rawHtml]]));
    expectOnlyGate(rawReport, "no_script_or_raw_html", "blocks[2] contains raw HTML");

    const titled = article({ title: "Harbor &lt;script&gt;" });
    const titledExample = exampleFor(titled, { title: "Harbor <script>" });
    const titledReport = evaluateCriteria(spec(), criteriaFor([titledExample]), filesFor([[titledExample.fixture, titled]]));
    expectOnlyGate(
      titledReport,
      "no_script_or_raw_html",
      "title contains script content; title contains raw HTML",
    );
  });

  test("reports author, date, hero, and counts without turning them into gates", () => {
    const html = article({
      byline: "javascript:alert(2)",
      publishedAt: "javascript:alert(4)",
      hero: "javascript:alert(1)",
      imageSrc: "javascript:alert(3)",
    });
    const example = exampleFor(html);
    const parsedSpec = spec();
    const report = evaluateCriteria(parsedSpec, criteriaFor([example]), filesFor([[example.fixture, html]]));
    const bareHtml = article({
      byline: "",
      publishedAt: "",
      hero: "",
      imageSrc: "",
      extra: "",
    }).replace("<img src=\"\" alt=\"A chart\">", "");
    const bare = exampleFor(bareHtml);
    const bareReport = evaluateCriteria(
      spec({ byline: undefined, publishedAt: undefined, heroImage: undefined }),
      criteriaFor([bare]),
      filesFor([[bare.fixture, bareHtml]]),
    );

    const parsed = runParser(parsedSpec, html, pageUrl);
    expect(checkInvariants(parsed).map((issue) => issue.code)).toContain("script_text");
    expect(report.gates.every((row) => row.ok)).toBe(true);
    expect(report.metadata[0]).toMatchObject({
      author: "javascript:alert(2)",
      publishedAt: "javascript:alert(4)",
      heroImageUrl: "javascript:alert(1)",
      imageCount: 1,
    });
    expect(bareReport.gates.every((row) => row.ok)).toBe(true);
    expect(bareReport.metadata[0]).toEqual({
      wordCount: report.metadata[0]?.wordCount,
      characterCount: report.metadata[0]?.characterCount,
      imageCount: 0,
    });
    expect(bareReport.metadata[0]).not.toHaveProperty("author");
    expect(bareReport.metadata[0]).not.toHaveProperty("publishedAt");
    expect(bareReport.metadata[0]).not.toHaveProperty("heroImageUrl");
    expect(report.gates.map((row) => row.gate)).not.toContain("word_count");
    expect(report.gates.map((row) => row.gate)).not.toContain("author");
  });

  test("evaluates each example and rejects a fixture that is not the named bytes", () => {
    const firstHtml = article();
    const secondHtml = article({ title: "Second Report" });
    const first = exampleFor(firstHtml);
    const second = exampleFor(secondHtml, {
      submissionId: "22222222-2222-4222-8222-222222222222",
      title: "Second Report",
    });
    const calls: string[] = [];
    const report = evaluateCriteria(spec(), criteriaFor([first, second]), (path) => {
      calls.push(path);
      return path === first.fixture ? firstHtml : secondHtml;
    });

    expect(calls).toEqual([first.fixture, second.fixture]);
    expect(report.gates.filter((row) => row.example === 0).every((row) => row.ok)).toBe(true);
    expect(report.gates.filter((row) => row.example === 1).every((row) => row.ok)).toBe(true);
    expect(report.metadata).toHaveLength(2);
    expect(report.metadata[1]?.author).toBe("Ada Lovelace");

    expect(() =>
      evaluateCriteria(spec(), criteriaFor([first]), () => `${firstHtml}\n<!-- swapped -->`),
    ).toThrow(CriteriaError);
    expect(() => evaluateCriteria(spec(), criteriaFor([first]), () => firstHtml)).not.toThrow();

    const huge = "a".repeat(1_000_001);
    expect(() => evaluateCriteria(spec(), criteriaFor([exampleFor(huge)]), () => huge)).toThrow(/1000000/);
  });

  test("rejects a criteria file that does not belong to the spec", () => {
    const html = article();
    const example = exampleFor(html);
    const read = filesFor([[example.fixture, html]]);
    const other = criteriaFor([example], { parserId: "other-news", digest: criteriaDigest([example]) });
    expect(() => evaluateCriteria(spec(), other, read)).toThrow(/parserId/);

    const wide = spec({ hosts: ["news.example", "wires.example"] });
    const movedExamples = [{ ...example, url: "https://wires.example/posts/harbor" }];
    const moved = parseParserCriteria({
      schema: "pirate-radio/parser-criteria@1",
      parserId: "example-news",
      host: "wires.example",
      digest: criteriaDigest(movedExamples),
      examples: movedExamples,
    });
    expect(() => evaluateCriteria(spec(), moved, read)).toThrow(/spec\.hosts/);
    expect(evaluateCriteria(wide, moved, read).gates.every((row) => row.ok)).toBe(true);
  });

  test("lets a parser mismatch surface instead of turning it into a passing gate", () => {
    const html = "<div><p>No article</p></div>";
    const example = exampleFor(html);
    expect(() => evaluateCriteria(spec(), criteriaFor([example]), filesFor([[example.fixture, html]]))).toThrow(
      /matched 0/,
    );
    expect(() => evaluateCriteria(spec(), criteriaFor([example]), () => {
      throw new Error("missing fixture");
    })).toThrow(/missing fixture/);
  });
});

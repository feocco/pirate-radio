import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { evaluateCriteria, parseParserCriteria } from "../src/parsers/criteria.js";
import { runParser } from "../src/parsers/engine.js";
import { parseParserSpec } from "../src/parsers/spec.js";

const domainDir = "src/parsers/domains/first-things";
const articleUrl = "https://firstthings.com/voyages-to-the-end-of-the-world/";
const title = "Voyages to the End of the World";
const firstWords = ["Francis", "Bacon", "dreamed", "of", "abolishing"];
const lastWords = ["have", "faith", "that", "he", "will."];
const phrases = ["might warn off potential invaders.", "confronting a dragon representing Satan"];
const filler = "redacted";

describe("First Things acceptance example", () => {
  test("the redacted fixture passes the five gates and keeps only the pinned words", () => {
    const criteria = parseParserCriteria(JSON.parse(readFileSync(join(domainDir, "criteria.json"), "utf8")));
    expect(criteria.parserId).toBe("first-things");
    expect(criteria.host).toBe("firstthings.com");
    expect(criteria.examples).toHaveLength(1);

    const example = criteria.examples[0];
    expect(example?.url).toBe(articleUrl);
    expect(example?.title).toBe(title);
    expect(example?.firstWords).toEqual(firstWords);
    expect(example?.lastWords).toEqual(lastWords);
    expect(example?.phrases).toEqual(phrases);
    expect(example?.fixture).toMatch(/^fixtures\/[0-9a-f]{64}\.html$/);
    expect(example?.rawSnapshotSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(example?.rawSnapshotSha256).not.toBe(example?.fixture.slice("fixtures/".length, -".html".length));

    const names = readdirSync(domainDir).sort();
    expect(names).toEqual(["criteria.json", "fixtures"]);
    expect(existsSync(join(domainDir, "parser.json"))).toBe(false);
    const fixtureNames = readdirSync(join(domainDir, "fixtures"));
    expect(fixtureNames).toEqual([example?.fixture.slice("fixtures/".length)]);

    const html = readFileSync(join(domainDir, example?.fixture ?? ""), "utf8");
    expect(Buffer.byteLength(html)).toBeLessThan(2000);
    expect(createHash("sha256").update(html).digest("hex")).toBe(
      example?.fixture.slice("fixtures/".length, -".html".length),
    );
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/javascript:/i);
    expect(html).not.toContain("&lt;");

    const spec = parseParserSpec({
      schema: "pirate-radio/parser-spec@1",
      id: "first-things",
      displayName: "First Things",
      hosts: ["firstthings.com"],
      title: { from: [{ select: "h1" }] },
      body: {
        root: "article",
        blocks: [{ select: "p", as: "paragraph" }],
      },
    });
    const report = evaluateCriteria(spec, criteria, (path) => {
      expect(path).toBe(example?.fixture);
      return html;
    });
    expect(report.gates).toEqual([
      { example: 0, gate: "title", ok: true },
      { example: 0, gate: "first_words", ok: true },
      { example: 0, gate: "last_words", ok: true },
      { example: 0, gate: "phrases_ordered", ok: true },
      { example: 0, gate: "no_script_or_raw_html", ok: true },
    ]);
    expect(report.metadata[0]).not.toHaveProperty("author");
    expect(report.metadata[0]?.wordCount).toBeLessThan(40);

    const parsed = runParser(spec, html, articleUrl);
    const allowed = new Set([filler, ...firstWords, ...lastWords, ...phrases.flatMap((phrase) => phrase.split(" "))]);
    const words = parsed.blocks.flatMap((block) => block.text.split(/\s+/).filter(Boolean));
    expect(words.filter((word) => !allowed.has(word))).toEqual([]);
    expect(parsed.title).toBe(title);
  });
});

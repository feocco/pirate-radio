import { describe, expect, test } from "vitest";
import {
  buildCloudExtractPrompt,
  classifyUnsupportedHttpsArticleUrl,
  cursorApiKeyFromEnv,
  normalizeExtractAnchors,
  parseCloudExtractArtifact,
  pickStoryArtifactPath,
} from "../src/cloudExtract.js";

describe("cloud extract contract", () => {
  test("classifies an unsupported https article URL as cloud-extract", () => {
    expect(
      classifyUnsupportedHttpsArticleUrl("https://darioamodei.com/post/we-must-pace-the-frontier?utm=1#comments"),
    ).toEqual({
      ok: true,
      url: "https://darioamodei.com/post/we-must-pace-the-frontier",
      slug: "we-must-pace-the-frontier",
      sourceType: "cloud-extract",
      sourceName: "darioamodei.com",
    });
  });

  test("rejects http, bare hosts, and X URLs from the unsupported-host classifier", () => {
    expect(classifyUnsupportedHttpsArticleUrl("http://darioamodei.com/post/we-must-pace-the-frontier")).toEqual({
      ok: false,
      error: "Enter an https article URL.",
    });
    expect(classifyUnsupportedHttpsArticleUrl("https://darioamodei.com/")).toEqual({
      ok: false,
      error: "Enter an article URL with a path.",
    });
    expect(classifyUnsupportedHttpsArticleUrl("https://x.com/demishassabis")).toEqual({
      ok: false,
      error: "Enter an X post URL with a /username/status/id path.",
    });
    expect(classifyUnsupportedHttpsArticleUrl("not a url")).toEqual({
      ok: false,
      error: "Enter a valid URL.",
    });
  });

  test("parses a Story artifact and ignores invented counts", () => {
    const parsed = parseCloudExtractArtifact(
      {
        title: "We Must Pace the Frontier",
        author: "Dario Amodei",
        text: "First sentence.\n\nLast sentence.",
        sourceUrl: "https://evil.example/wrong",
        characterCount: 1,
        wordCount: 1,
        extractedAt: "2026-09-13T00:00:00.000Z",
        selectors: ["article", "main .post"],
      },
      "https://darioamodei.com/post/we-must-pace-the-frontier",
    );

    expect(parsed.story).toMatchObject({
      title: "We Must Pace the Frontier",
      author: "Dario Amodei",
      sourceUrl: "https://darioamodei.com/post/we-must-pace-the-frontier",
      text: "First sentence.\n\nLast sentence.",
      wordCount: 4,
      characterCount: "First sentence.\n\nLast sentence.".length,
      extractedAt: "2026-09-13T00:00:00.000Z",
    });
    expect(parsed.selectors).toEqual(["article", "main .post"]);
  });

  test("requires first and last sentence anchors when provided", () => {
    const raw = {
      title: "Pacing",
      text: "Alpha start. Middle. Omega end.",
      sourceUrl: "https://darioamodei.com/post/we-must-pace-the-frontier",
      characterCount: 10,
      wordCount: 2,
      extractedAt: "2026-09-13T00:00:00.000Z",
    };
    expect(() =>
      parseCloudExtractArtifact(raw, "https://darioamodei.com/post/we-must-pace-the-frontier", {
        firstSentence: "Alpha start.",
        lastSentence: "Omega end.",
      }),
    ).not.toThrow();
    expect(() =>
      parseCloudExtractArtifact(raw, "https://darioamodei.com/post/we-must-pace-the-frontier", {
        firstSentence: "Wrong start.",
      }),
    ).toThrow("Cloud extract did not begin at the requested first sentence.");
  });

  test("builds a prompt that names the URL, artifact path, and anchors", () => {
    const prompt = buildCloudExtractPrompt({
      url: "https://darioamodei.com/post/we-must-pace-the-frontier",
      anchors: {
        firstSentence: "I think we should pace.",
        lastSentence: "That is the work.",
      },
    });

    expect(prompt).toContain("https://darioamodei.com/post/we-must-pace-the-frontier");
    expect(prompt).toContain("artifacts/story.json");
    expect(prompt).toContain("I think we should pace.");
    expect(prompt).toContain("That is the work.");
    expect(prompt).toContain("Exclude comments, subscribe widgets, related posts, and nav chrome.");
  });

  test("reads CURSOR_API_KEY and picks a story.json artifact", () => {
    expect(cursorApiKeyFromEnv({ CURSOR_API_KEY: "  crsr_test  " })).toBe("crsr_test");
    expect(cursorApiKeyFromEnv({})).toBeUndefined();
    expect(
      pickStoryArtifactPath([
        { path: "notes.txt" },
        { path: "artifacts/other.json" },
        { path: "artifacts/story.json" },
      ]),
    ).toBe("artifacts/story.json");
  });

  test("normalizes optional sentence anchors", () => {
    expect(normalizeExtractAnchors({ firstSentence: "  Hello.  ", lastSentence: "   " })).toEqual({
      firstSentence: "Hello.",
    });
    expect(normalizeExtractAnchors({})).toBeUndefined();
  });
});

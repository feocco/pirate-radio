import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test, vi } from "vitest";
import { extractStoryFromUrl } from "../src/browser.js";
import {
  buildCloudExtractPrompt,
  classifyUnsupportedHttpsArticleUrl,
  cursorApiKeyFromEnv,
  extractStoryViaCloud,
  MISSING_CURSOR_API_KEY_MESSAGE,
  normalizeExtractAnchors,
  parseCloudExtractArtifact,
  pickStoryArtifactPath,
  type CloudAgentFactory,
} from "../src/cloudExtract.js";
import { createInitialState, handleArticleDecision } from "../src/workflow.js";

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

function mockCloudAgent(artifact: unknown): CloudAgentFactory {
  return vi.fn(async () => ({
    send: vi.fn(async () => ({
      wait: async () => ({ status: "finished" as const }),
    })),
    listArtifacts: async () => [{ path: "artifacts/story.json" }],
    downloadArtifact: async () => Buffer.from(JSON.stringify(artifact)),
    close: vi.fn(),
  }));
}

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

  test("fails closed when CURSOR_API_KEY is missing", async () => {
    await expect(
      extractStoryViaCloud({ url: "https://darioamodei.com/post/we-must-pace-the-frontier" }),
    ).rejects.toThrow(MISSING_CURSOR_API_KEY_MESSAGE);
  });

  test("launches a no-repo agent, downloads the Story artifact, and writes a library item", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pirate-cloud-extract-"));
    const sourceUrl = "https://darioamodei.com/post/we-must-pace-the-frontier";
    const createAgent = mockCloudAgent({
      title: "We Must Pace the Frontier",
      author: "Dario Amodei",
      text: "I think we should pace.\n\nThat is the work.",
      sourceUrl,
      characterCount: 99,
      wordCount: 99,
      extractedAt: "2026-09-13T12:00:00.000Z",
    });

    const story = await extractStoryFromUrl(sourceUrl, {
      firstSentence: "I think we should pace.",
      lastSentence: "That is the work.",
      apiKey: "crsr_test",
      createAgent,
    });

    expect(createAgent).toHaveBeenCalledWith({
      apiKey: "crsr_test",
      cloud: { repos: [] },
    });
    expect(story).toMatchObject({
      title: "We Must Pace the Frontier",
      author: "Dario Amodei",
      sourceUrl,
      text: "I think we should pace.\n\nThat is the work.",
    });

    const state = createInitialState();
    state.pending["we-must-pace-the-frontier"] = {
      id: sourceUrl,
      title: "We Must Pace The Frontier",
      url: sourceUrl,
      author: "",
      publishedAt: "",
      description: "Queued from pasted darioamodei.com URL.",
      slug: "we-must-pace-the-frontier",
      sourceType: "cloud-extract",
      sourceName: "darioamodei.com",
      canonicalUrl: sourceUrl,
    };

    const result = await handleArticleDecision({
      decision: "accept",
      slug: "we-must-pace-the-frontier",
      state,
      libraryDir: tempDir,
      readArticle: async () => story,
      synthesize: async ({ outputPath }) => {
        await mkdir(dirname(outputPath), { recursive: true });
        await writeFile(outputPath, Buffer.from("mock mp3"));
        return { provider: "mock", outputPath, estimatedCostUsd: 0.01 };
      },
    });

    expect(result.status).toBe("accepted");
    expect(result.libraryItem).toMatchObject({
      sourceType: "cloud-extract",
      sourceName: "darioamodei.com",
      sourceUrl,
      canonicalUrl: sourceUrl,
      title: "We Must Pace the Frontier",
      author: "Dario Amodei",
    });
  });

  test("fails closed when the cloud agent run errors", async () => {
    const createAgent: CloudAgentFactory = async () => ({
      send: async () => ({
        wait: async () => ({ status: "error", error: { message: "agent exploded" } }),
      }),
      listArtifacts: async () => [],
      downloadArtifact: async () => Buffer.from(""),
      close: vi.fn(),
    });

    await expect(
      extractStoryViaCloud(
        { url: "https://darioamodei.com/post/we-must-pace-the-frontier" },
        { apiKey: "crsr_test", createAgent },
      ),
    ).rejects.toThrow("agent exploded");
  });
});

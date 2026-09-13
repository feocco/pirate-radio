import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test, vi } from "vitest";
import { extractStoryFromUrl } from "../src/browser.js";
import {
  buildCloudExtractPrompt,
  classifyUnsupportedHttpsArticleUrl,
  CLOUD_EXTRACT_TIMEOUT_MESSAGE,
  cloudExtractSlug,
  cursorApiKeyFromEnv,
  decodeArtifactBytes,
  extractStoryViaCloud,
  MISSING_CURSOR_API_KEY_MESSAGE,
  normalizeExtractAnchors,
  parseCloudExtractArtifact,
  pickStoryArtifactPath,
  type CloudAgentFactory,
} from "../src/cloudExtract.js";
import { appendLibraryItem, readLibraryManifest } from "../src/library.js";
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
    downloadArtifact: async () => new Uint8Array(Buffer.from(JSON.stringify(artifact))),
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
      slug: "darioamodei-com-we-must-pace-the-frontier",
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
    const slug = cloudExtractSlug(sourceUrl);
    state.pending[slug] = {
      id: sourceUrl,
      title: "We Must Pace The Frontier",
      url: sourceUrl,
      author: "",
      publishedAt: "",
      description: "Queued from pasted darioamodei.com URL.",
      slug,
      sourceType: "cloud-extract",
      sourceName: "darioamodei.com",
      canonicalUrl: sourceUrl,
    };

    const result = await handleArticleDecision({
      decision: "accept",
      slug,
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
      slug,
      sourceType: "cloud-extract",
      sourceName: "darioamodei.com",
      sourceUrl,
      canonicalUrl: sourceUrl,
      title: "We Must Pace the Frontier",
      author: "Dario Amodei",
    });
    expect(result.libraryItem?.audioUrl).toBe(`/audio/${slug}.mp3`);
  });

  test("keeps a namespaced cloud-extract slug so it does not overwrite a last-segment library item", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pirate-cloud-extract-"));
    const existingAudio = join(tempDir, "audio", "we-must-pace-the-frontier.mp3");
    await mkdir(dirname(existingAudio), { recursive: true });
    await writeFile(existingAudio, Buffer.from("existing mp3"));
    await appendLibraryItem(tempDir, {
      slug: "we-must-pace-the-frontier",
      title: "Pirate Wires original",
      sourceUrl: "https://www.piratewires.com/p/we-must-pace-the-frontier",
      sourceType: "pirate-wires",
      sourceName: "Pirate Wires",
      canonicalUrl: "https://www.piratewires.com/p/we-must-pace-the-frontier",
      publishedAt: "Mon, 22 Jun 2026 17:07:10 GMT",
      generatedAt: "2026-06-23T01:00:00.000Z",
      audioPath: existingAudio,
      jsonPath: join(tempDir, "stories", "we-must-pace-the-frontier.json"),
      textPath: join(tempDir, "text", "we-must-pace-the-frontier.txt"),
      estimatedCostUsd: 0.01,
      wordCount: 2,
      characterCount: 10,
    });

    const sourceUrl = "https://darioamodei.com/post/we-must-pace-the-frontier";
    const slug = cloudExtractSlug(sourceUrl);
    const state = createInitialState();
    state.pending[slug] = {
      id: sourceUrl,
      title: "We Must Pace The Frontier",
      url: sourceUrl,
      author: "",
      publishedAt: "",
      description: "Queued from pasted darioamodei.com URL.",
      slug,
      sourceType: "cloud-extract",
      sourceName: "darioamodei.com",
      canonicalUrl: sourceUrl,
    };

    await handleArticleDecision({
      decision: "accept",
      slug,
      state,
      libraryDir: tempDir,
      readArticle: async () => ({
        sourceUrl,
        title: "We Must Pace the Frontier",
        text: "I think we should pace.",
        wordCount: 5,
        characterCount: 23,
        extractedAt: "2026-09-13T12:00:00.000Z",
      }),
      synthesize: async ({ outputPath }) => {
        await mkdir(dirname(outputPath), { recursive: true });
        await writeFile(outputPath, Buffer.from("cloud mp3"));
        return { provider: "mock", outputPath, estimatedCostUsd: 0.01 };
      },
    });

    const manifest = await readLibraryManifest(tempDir);
    expect(manifest.items.map((item) => item.slug).sort()).toEqual([
      "darioamodei-com-we-must-pace-the-frontier",
      "we-must-pace-the-frontier",
    ]);
    expect(manifest.items.find((item) => item.slug === "we-must-pace-the-frontier")?.title).toBe(
      "Pirate Wires original",
    );
  });

  test("fails closed when the cloud agent run errors", async () => {
    const createAgent: CloudAgentFactory = async () => ({
      send: async () => ({
        wait: async () => ({ status: "error", error: { message: "agent exploded" } }),
      }),
      listArtifacts: async () => [],
      downloadArtifact: async () => new Uint8Array(),
      close: vi.fn(),
    });

    await expect(
      extractStoryViaCloud(
        { url: "https://darioamodei.com/post/we-must-pace-the-frontier" },
        { apiKey: "crsr_test", createAgent },
      ),
    ).rejects.toThrow("agent exploded");
  });

  test("decodes Uint8Array artifact bytes as UTF-8 instead of comma-joined values", () => {
    const json = '{"title":"Pacing"}';
    const bytes = new Uint8Array(Buffer.from(json));
    expect(String(bytes)).toContain(",");
    expect(decodeArtifactBytes(bytes)).toBe(json);
    expect(decodeArtifactBytes(Buffer.from(json))).toBe(json);
  });

  test("namespaces cloud-extract slugs by host", () => {
    expect(cloudExtractSlug("https://darioamodei.com/post/we-must-pace-the-frontier")).toBe(
      "darioamodei-com-we-must-pace-the-frontier",
    );
    expect(cloudExtractSlug("https://example.com/p/test-story")).toBe("example-com-test-story");
    expect(cloudExtractSlug("https://www.example.com/p/test-story")).toBe("example-com-test-story");
  });

  test("fails closed when the cloud agent wait exceeds the timeout", async () => {
    const close = vi.fn();
    const createAgent: CloudAgentFactory = async () => ({
      send: async () => ({
        wait: () => new Promise(() => {}),
      }),
      listArtifacts: async () => [],
      downloadArtifact: async () => new Uint8Array(),
      close,
    });

    await expect(
      extractStoryViaCloud(
        { url: "https://darioamodei.com/post/we-must-pace-the-frontier" },
        { apiKey: "crsr_test", createAgent, timeoutMs: 20 },
      ),
    ).rejects.toThrow(CLOUD_EXTRACT_TIMEOUT_MESSAGE);
    expect(close).toHaveBeenCalled();
  });

  test("fails closed when agent create or send hangs before wait", async () => {
    await expect(
      extractStoryViaCloud(
        { url: "https://darioamodei.com/post/we-must-pace-the-frontier" },
        { apiKey: "crsr_test", createAgent: () => new Promise(() => {}), timeoutMs: 20 },
      ),
    ).rejects.toThrow(CLOUD_EXTRACT_TIMEOUT_MESSAGE);

    const close = vi.fn();
    await expect(
      extractStoryViaCloud(
        { url: "https://darioamodei.com/post/we-must-pace-the-frontier" },
        {
          apiKey: "crsr_test",
          timeoutMs: 20,
          createAgent: async () => ({
            send: () => new Promise(() => {}),
            listArtifacts: async () => [],
            downloadArtifact: async () => new Uint8Array(),
            close,
          }),
        },
      ),
    ).rejects.toThrow(CLOUD_EXTRACT_TIMEOUT_MESSAGE);
    expect(close).toHaveBeenCalled();
  });
});

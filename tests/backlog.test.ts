import { describe, expect, test, vi } from "vitest";
import {
  buildBacklogItems,
  findBacklogArticle,
  queueBacklogConversion,
  queueBacklogUrlConversion,
  validateArticleUrl,
} from "../src/backlog.js";
import type { PirateArticle } from "../src/feed.js";
import type { LibraryManifest } from "../src/library.js";
import { createInitialState } from "../src/state.js";

const articles: PirateArticle[] = [
  {
    id: "https://piratewires.substack.com/p/converted-story",
    title: "Converted Story",
    url: "https://piratewires.substack.com/p/converted-story",
    author: "Pirate Staff",
    publishedAt: "Fri, 26 Jun 2026 13:04:07 GMT",
    description: "Already converted.",
    slug: "converted-story",
    sourceType: "pirate-wires",
    sourceName: "Pirate Wires",
  },
  {
    id: "https://piratewires.substack.com/p/unconverted-story",
    title: "Unconverted Story",
    url: "https://piratewires.substack.com/p/unconverted-story",
    author: "Pirate Staff",
    publishedAt: "Thu, 25 Jun 2026 13:04:07 GMT",
    description: "Needs audio.",
    slug: "unconverted-story",
    sourceType: "pirate-wires",
    sourceName: "Pirate Wires",
  },
  {
    id: "https://piratewires.substack.com/p/friday-three-morning-takes-84a",
    title: "Monday: Three Morning Takes",
    url: "https://piratewires.substack.com/p/friday-three-morning-takes-84a",
    author: "Pirate Staff",
    publishedAt: "Mon, 22 Jun 2026 09:45:52 GMT",
    description: "Short takes.",
    slug: "friday-three-morning-takes-84a",
    sourceType: "pirate-wires",
    sourceName: "Pirate Wires",
  },
];

const manifest: LibraryManifest = {
  version: 1,
  updatedAt: "2026-06-26T13:05:00.000Z",
  items: [
    {
      slug: "converted-story",
      title: "Converted Story",
      sourceUrl: "https://www.piratewires.com/p/converted-story",
      publishedAt: "Fri, 26 Jun 2026 13:04:07 GMT",
      generatedAt: "2026-06-26T13:05:00.000Z",
      audioPath: "/data/library/audio/converted-story.mp3",
      audioUrl: "/audio/converted-story.mp3",
      jsonPath: "/data/library/stories/converted-story.json",
      textPath: "/data/library/text/converted-story.txt",
      estimatedCostUsd: 0.01,
      wordCount: 1000,
      characterCount: 6000,
      audioBytes: 1024,
    },
  ],
};

describe("backlog", () => {
  test("marks feed articles as converted and processing from library and service state", () => {
    const items = buildBacklogItems({
      articles,
      manifest,
      processingSlugs: new Set(["unconverted-story"]),
    });

    expect(items).toEqual([
      expect.objectContaining({
        slug: "converted-story",
        title: "Converted Story",
        converted: true,
        processing: false,
        sourceName: "Pirate Wires",
      }),
      expect.objectContaining({
        slug: "unconverted-story",
        title: "Unconverted Story",
        converted: false,
        processing: true,
      }),
    ]);
    expect(items.map((item) => item.title)).not.toContain("Monday: Three Morning Takes");
  });

  test("finds backlog articles by slug", () => {
    expect(findBacklogArticle(articles, "unconverted-story")?.title).toBe("Unconverted Story");
    expect(findBacklogArticle(articles, "friday-three-morning-takes-84a")).toBeUndefined();
    expect(findBacklogArticle(articles, "missing-story")).toBeUndefined();
  });

  test("queueing a backlog conversion records pending state and starts work once", async () => {
    const state = createInitialState();
    const processingSlugs = new Set<string>();
    const writeState = vi.fn(async () => {});
    let finishConversion: () => void = () => {};
    const startConversion = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishConversion = resolve;
        }),
    );

    const result = await queueBacklogConversion({
      slug: "unconverted-story",
      articles,
      manifest,
      state,
      statePath: "/tmp/state.json",
      processingSlugs,
      writeState,
      startConversion,
    });
    const duplicate = await queueBacklogConversion({
      slug: "unconverted-story",
      articles,
      manifest,
      state,
      statePath: "/tmp/state.json",
      processingSlugs,
      writeState,
      startConversion,
    });

    expect(result).toEqual({ ok: true, status: "queued" });
    expect(duplicate).toEqual({ ok: true, status: "processing" });
    expect(state.pending["unconverted-story"]).toEqual(articles[1]);
    expect(state.seen[articles[1].id]).toEqual(articles[1]);
    expect(writeState).toHaveBeenCalledTimes(1);
    expect(startConversion).toHaveBeenCalledTimes(1);
    finishConversion();
  });

  test("queueing clears stale approved state when no library item exists", async () => {
    const state = createInitialState();
    state.approved[articles[1].id] = {
      article: articles[1],
      decidedAt: "2026-06-26T13:05:00.000Z",
    };

    await queueBacklogConversion({
      slug: "unconverted-story",
      articles,
      manifest,
      state,
      statePath: "/tmp/state.json",
      processingSlugs: new Set(),
      writeState: vi.fn(async () => {}),
      startConversion: vi.fn(async () => {}),
    });

    expect(state.approved[articles[1].id]).toBeUndefined();
    expect(state.pending["unconverted-story"]).toEqual(articles[1]);
  });

  test("queueing an already converted article does not start work", async () => {
    const startConversion = vi.fn(async () => {});

    const result = await queueBacklogConversion({
      slug: "converted-story",
      articles,
      manifest,
      state: createInitialState(),
      statePath: "/tmp/state.json",
      processingSlugs: new Set(),
      writeState: vi.fn(async () => {}),
      startConversion,
    });

    expect(result).toEqual({ ok: true, status: "converted" });
    expect(startConversion).not.toHaveBeenCalled();
  });

  test("queueing an unknown article returns missing", async () => {
    const result = await queueBacklogConversion({
      slug: "missing-story",
      articles,
      manifest,
      state: createInitialState(),
      statePath: "/tmp/state.json",
      processingSlugs: new Set(),
      writeState: vi.fn(async () => {}),
      startConversion: vi.fn(async () => {}),
    });

    expect(result).toEqual({ ok: false, status: "missing" });
  });

  test("validates known pasted article URLs", async () => {
    await expect(validateArticleUrl("https://www.piratewires.com/p/test-story")).resolves.toEqual({
      ok: true,
      url: "https://www.piratewires.com/p/test-story",
      slug: "test-story",
      sourceType: "pirate-wires",
      sourceName: "Pirate Wires",
    });
    await expect(validateArticleUrl("https://www.hyperdimensional.co/p/what-should-be-done")).resolves.toEqual({
      ok: true,
      url: "https://www.hyperdimensional.co/p/what-should-be-done",
      slug: "what-should-be-done",
      sourceType: "substack",
      sourceName: "Hyperdimensional",
    });
    await expect(
      validateArticleUrl("https://open.substack.com/pub/hyperdimensional/p/what-should-be-done", {
        resolveUrl: async () => "https://www.hyperdimensional.co/p/what-should-be-done?utm_source=share",
      }),
    ).resolves.toEqual({
      ok: true,
      url: "https://www.hyperdimensional.co/p/what-should-be-done",
      slug: "what-should-be-done",
      sourceType: "substack",
      sourceName: "Hyperdimensional",
    });
    await expect(
      validateArticleUrl("https://twitter.com/demishassabis/status/2076957440109625718?s=20"),
    ).resolves.toEqual({
      ok: true,
      url: "https://x.com/demishassabis/status/2076957440109625718",
      slug: "2076957440109625718",
      sourceType: "x",
      sourceName: "X",
    });
    await expect(
      validateArticleUrl(
        "https://www.wsj.com/tech/steve-jobs-apple-next-cia-161b65f9?st=NWWds1&reflink=desktopwebshare_permalink",
      ),
    ).resolves.toEqual({
      ok: true,
      url: "https://www.wsj.com/tech/steve-jobs-apple-next-cia-161b65f9",
      slug: "steve-jobs-apple-next-cia-161b65f9",
      sourceType: "wsj",
      sourceName: "WSJ",
    });
    await expect(validateArticleUrl("not a url")).resolves.toEqual({
      ok: false,
      error: "Enter a valid URL.",
    });
    await expect(validateArticleUrl("https://example.com/p/test-story")).resolves.toEqual({
      ok: false,
      error: "Enter a supported article URL from Pirate Wires, Substack, X, or WSJ.",
    });
    await expect(validateArticleUrl("https://x.com/demishassabis")).resolves.toEqual({
      ok: false,
      error: "Enter an X post URL with a /username/status/id path.",
    });
    await expect(validateArticleUrl("https://www.piratewires.com/about")).resolves.toEqual({
      ok: false,
      error: "Enter an article URL with a /p/story-slug path.",
    });
    await expect(validateArticleUrl("https://www.wsj.com/tech")).resolves.toEqual({
      ok: false,
      error: "Enter a WSJ article URL such as /section/headline-id or /articles/headline.",
    });
  });

  test("queueing a pasted URL records pending state and starts conversion", async () => {
    const state = createInitialState();
    const processingSlugs = new Set<string>();
    const writeState = vi.fn(async () => {});
    const startConversion = vi.fn(async () => {});

    const result = await queueBacklogUrlConversion({
      url: "https://www.piratewires.com/p/direct-story",
      manifest,
      state,
      statePath: "/tmp/state.json",
      processingSlugs,
      writeState,
      startConversion,
    });

    expect(result).toEqual({ ok: true, status: "queued", slug: "direct-story" });
    expect(state.pending["direct-story"]).toMatchObject({
      id: "https://www.piratewires.com/p/direct-story",
      url: "https://www.piratewires.com/p/direct-story",
      slug: "direct-story",
      sourceType: "pirate-wires",
      sourceName: "Pirate Wires",
    });
    expect(writeState).toHaveBeenCalledTimes(1);
    expect(startConversion).toHaveBeenCalledWith("direct-story");
  });

  test("queueing a pasted Substack URL records pending source metadata", async () => {
    const state = createInitialState();
    const processingSlugs = new Set<string>();
    const writeState = vi.fn(async () => {});
    const startConversion = vi.fn(async () => {});

    const result = await queueBacklogUrlConversion({
      url: "https://www.hyperdimensional.co/p/what-should-be-done",
      manifest,
      state,
      statePath: "/tmp/state.json",
      processingSlugs,
      writeState,
      startConversion,
    });

    expect(result).toEqual({ ok: true, status: "queued", slug: "what-should-be-done" });
    expect(state.pending["what-should-be-done"]).toMatchObject({
      id: "https://www.hyperdimensional.co/p/what-should-be-done",
      url: "https://www.hyperdimensional.co/p/what-should-be-done",
      slug: "what-should-be-done",
      sourceType: "substack",
      sourceName: "Hyperdimensional",
      description: "Queued from pasted Hyperdimensional URL.",
    });
  });

  test("queueing a pasted X Article URL records X source metadata", async () => {
    const state = createInitialState();
    const startConversion = vi.fn(async () => {});

    const result = await queueBacklogUrlConversion({
      url: "https://x.com/demishassabis/status/2076957440109625718?ref_src=twsrc",
      manifest,
      state,
      statePath: "/tmp/state.json",
      processingSlugs: new Set(),
      writeState: vi.fn(async () => {}),
      startConversion,
    });

    expect(result).toEqual({ ok: true, status: "queued", slug: "2076957440109625718" });
    expect(state.pending["2076957440109625718"]).toMatchObject({
      id: "https://x.com/demishassabis/status/2076957440109625718",
      url: "https://x.com/demishassabis/status/2076957440109625718",
      slug: "2076957440109625718",
      sourceType: "x",
      sourceName: "X",
      title: "X Article",
      description: "Queued from pasted X URL.",
    });
    expect(startConversion).toHaveBeenCalledWith("2076957440109625718");
  });

  test("queueing a pasted WSJ URL records WSJ source metadata", async () => {
    const state = createInitialState();
    const startConversion = vi.fn(async () => {});

    const result = await queueBacklogUrlConversion({
      url: "https://www.wsj.com/tech/steve-jobs-apple-next-cia-161b65f9?st=NWWds1",
      manifest,
      state,
      statePath: "/tmp/state.json",
      processingSlugs: new Set(),
      writeState: vi.fn(async () => {}),
      startConversion,
    });

    expect(result).toEqual({ ok: true, status: "queued", slug: "steve-jobs-apple-next-cia-161b65f9" });
    expect(state.pending["steve-jobs-apple-next-cia-161b65f9"]).toMatchObject({
      id: "https://www.wsj.com/tech/steve-jobs-apple-next-cia-161b65f9",
      url: "https://www.wsj.com/tech/steve-jobs-apple-next-cia-161b65f9",
      slug: "steve-jobs-apple-next-cia-161b65f9",
      sourceType: "wsj",
      sourceName: "WSJ",
      title: "Steve Jobs Apple Next Cia",
      description: "Queued from pasted WSJ URL.",
    });
    expect(startConversion).toHaveBeenCalledWith("steve-jobs-apple-next-cia-161b65f9");
  });

  test("queueing an unsupported URL reports a validation error", async () => {
    const result = await queueBacklogUrlConversion({
      url: "https://example.com/p/direct-story",
      manifest,
      state: createInitialState(),
      statePath: "/tmp/state.json",
      processingSlugs: new Set(),
      writeState: vi.fn(async () => {}),
      startConversion: vi.fn(async () => {}),
    });

    expect(result).toEqual({
      ok: false,
      status: "invalid_url",
      error: "Enter a supported article URL from Pirate Wires, Substack, X, or WSJ.",
    });
  });
});

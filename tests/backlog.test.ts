import { describe, expect, test, vi } from "vitest";
import { buildBacklogItems, findBacklogArticle, queueBacklogConversion } from "../src/backlog.js";
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
  },
  {
    id: "https://piratewires.substack.com/p/unconverted-story",
    title: "Unconverted Story",
    url: "https://piratewires.substack.com/p/unconverted-story",
    author: "Pirate Staff",
    publishedAt: "Thu, 25 Jun 2026 13:04:07 GMT",
    description: "Needs audio.",
    slug: "unconverted-story",
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
      }),
      expect.objectContaining({
        slug: "unconverted-story",
        title: "Unconverted Story",
        converted: false,
        processing: true,
      }),
    ]);
  });

  test("finds backlog articles by slug", () => {
    expect(findBacklogArticle(articles, "unconverted-story")?.title).toBe("Unconverted Story");
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
});

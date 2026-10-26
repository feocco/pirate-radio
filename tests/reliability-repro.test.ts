import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, onTestFinished, test, vi } from "vitest";
import type { PirateRadioConfig } from "../src/config.js";
import type { CreateSubmissionInput, PirateRadioDatabase } from "../src/database.js";
import type { PirateArticle } from "../src/feed.js";
import type { Submission, SubmissionStatus } from "../src/identity.js";
import type { ParsedPirateRadioAction } from "../src/notifications.js";
import type { TtsRequest, TtsResult } from "../src/tts/index.js";
import { FakeAuthenticator, MemoryStore } from "./support/fakes.js";
import { timeoutError } from "./support/timeouts.js";

const harness = vi.hoisted(() => ({
  servers: [] as Server[],
  articles: [] as PirateArticle[],
  onAction: undefined as ((action: ParsedPirateRadioAction) => Promise<void>) | undefined,
  extractionStarts: [] as string[],
  extractions: [] as Array<{
    url: string;
    resolve: (story: {
      sourceUrl: string;
      title: string;
      text: string;
      wordCount: number;
      characterCount: number;
      extractedAt: string;
    }) => void;
  }>,
  syntheses: [] as Array<{
    request: TtsRequest;
    resolve: (result: TtsResult) => void;
  }>,
  activeSyntheses: 0,
  maxActiveSyntheses: 0,
}));

vi.mock("node:http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:http")>();
  return {
    ...actual,
    createServer: (...args: Parameters<typeof actual.createServer>) => {
      const server = actual.createServer(...args);
      harness.servers.push(server);
      return server;
    },
  };
});

vi.mock("../src/feed.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/feed.js")>();
  return {
    ...actual,
    fetchArticleFeeds: vi.fn(async () => harness.articles),
  };
});

vi.mock("../src/browser.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/browser.js")>();
  return {
    ...actual,
    extractStoryFromUrl: vi.fn(
      (url: string) =>
        new Promise((resolve) => {
          harness.extractionStarts.push(url);
          harness.extractions.push({ url, resolve });
        }),
    ),
  };
});

vi.mock("../src/tts/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/tts/index.js")>();
  return {
    ...actual,
    createTtsProvider: vi.fn(() => ({
      synthesize: async (request: TtsRequest): Promise<TtsResult> => {
        harness.activeSyntheses += 1;
        harness.maxActiveSyntheses = Math.max(
          harness.maxActiveSyntheses,
          harness.activeSyntheses,
        );
        try {
          return await new Promise<TtsResult>((resolve) => {
            harness.syntheses.push({ request, resolve });
          });
        } finally {
          harness.activeSyntheses -= 1;
        }
      },
    })),
  };
});

vi.mock("../src/haActions.js", () => ({
  HomeAssistantActionListener: class {
    constructor(options: { onAction: (action: ParsedPirateRadioAction) => Promise<void> }) {
      harness.onAction = options.onAction;
    }
    async start(): Promise<void> {}
    stop(): void {}
  },
}));

const feedArticle: PirateArticle = {
  id: "https://local.invalid/p/feed-single-flight",
  title: "Feed Single Flight",
  url: "https://local.invalid/p/feed-single-flight",
  author: "Fixture",
  publishedAt: "Mon, 26 Oct 2026 00:00:00 GMT",
  description: "Local reliability fixture.",
  sourceId: "local",
  slug: "feed-single-flight",
  sourceType: "substack",
  sourceName: "Local",
};

const haArticle: PirateArticle = {
  ...feedArticle,
  id: "https://local.invalid/p/ha-single-flight",
  title: "HA Single Flight",
  url: "https://local.invalid/p/ha-single-flight",
  slug: "ha-single-flight",
};

const failedAutomatedArticle: PirateArticle = {
  ...feedArticle,
  id: "https://local.invalid/p/failed-automated-submission",
  title: "Failed Automated Submission",
  url: "https://local.invalid/p/failed-automated-submission",
  slug: "failed-automated-submission",
};

interface Gate {
  promise: Promise<void>;
  release: () => void;
  waiting: number;
}

function gate(): Gate {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release, waiting: 0 };
}

class RuntimeStore extends MemoryStore {
  createGate?: Gate;
  processingGate?: Gate;
  terminalGate?: Gate;
  rejectAutomatedSubmission = false;

  async migrate(): Promise<void> {}

  override async createSubmission(input: CreateSubmissionInput): Promise<Submission> {
    if (this.rejectAutomatedSubmission && input.type === "automated") {
      throw new Error("submission store unavailable");
    }
    await passGate(this.createGate);
    return super.createSubmission(input);
  }

  override async updateSubmission(
    id: string,
    status: SubmissionStatus,
    update?: { slug?: string; error?: string },
  ): Promise<void> {
    await passGate(status === "processing" ? this.processingGate : this.terminalGate);
    return super.updateSubmission(id, status, update);
  }

  statuses(slug: string, type: Submission["type"]): SubmissionStatus[] {
    return this.submissionRows
      .filter((row) => row.slug === slug && row.type === type)
      .map((row) => row.status);
  }
}

async function passGate(current?: Gate): Promise<void> {
  if (!current) return;
  current.waiting += 1;
  await current.promise;
}

let tempDir: string | undefined;

afterAll(async () => {
  for (const server of harness.servers) {
    server.closeAllConnections?.();
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

describe("runtime reliability reproduction", () => {
  test("shares conversion outcomes across supplied and missing submission IDs", async () => {
    harness.articles = [feedArticle, haArticle, failedAutomatedArticle];
    tempDir = await mkdtemp(join(tmpdir(), "pirate-reliability-repro-"));
    const store = new RuntimeStore();
    const config = reliabilityConfig(tempDir);
    const intervalSpy = vi
      .spyOn(globalThis, "setInterval")
      .mockImplementation((() => ({ unref() {} })) as unknown as typeof setInterval);
    const notified: Array<{ tag: string; statuses: SubmissionStatus[] }> = [];
    const { PirateRadioService } = await import("../src/server.js");
    const service = new PirateRadioService({
      config,
      database: store as unknown as PirateRadioDatabase,
      authenticator: new FakeAuthenticator(),
      notifier: {
        send: async (notification) => {
          const slug = notification.tag.replace(/^pirate-radio-(?:ready|failed)-/, "");
          notified.push({
            tag: notification.tag,
            statuses: store.submissionRows
              .filter((row) => row.slug === slug)
              .map((row) => row.status),
          });
        },
      },
    });
    await service.start();
    intervalSpy.mockRestore();

    const server = harness.servers.at(-1);
    expect(server).toBeDefined();
    await vi.waitFor(() => expect(server!.listening).toBe(true));
    const address = server!.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP server address");
    config.publicBaseUrl = `http://127.0.0.1:${address.port}`;

    const feedFirst = await post(`${config.publicBaseUrl}/queue/convert/feed-single-flight`, config);
    expect(feedFirst).toEqual({ ok: true, status: "queued" });
    await waitForExtraction(feedArticle.url, 1);
    const feedSecond = await post(`${config.publicBaseUrl}/queue/convert/feed-single-flight`, config);
    expect(feedSecond).toEqual({ ok: true, status: "processing" });
    await vi.waitFor(() => {
      expect(store.statuses("feed-single-flight", "feed")).toEqual(["processing", "processing"]);
    });
    await releaseExtractions(feedArticle.url);
    await waitForSynthesis("Feed Single Flight", 1);
    await releaseSyntheses("Feed Single Flight");
    await vi.waitFor(() => {
      expect(store.statuses("feed-single-flight", "feed")).toEqual(["succeeded", "succeeded"]);
    });
    expect(
      store.submissionRows.filter(
        (row) => row.slug === "feed-single-flight" && row.type === "automated",
      ),
    ).toHaveLength(0);

    const directUrl = "https://www.hyperdimensional.co/p/url-single-flight";
    const urlFirst = await post(`${config.publicBaseUrl}/queue/convert-url`, config, {
      url: directUrl,
    });
    expect(urlFirst).toEqual({ ok: true, status: "queued", slug: "url-single-flight" });
    await waitForExtraction(directUrl, 1);
    const urlSecond = await post(`${config.publicBaseUrl}/queue/convert-url`, config, {
      url: directUrl,
    });
    expect(urlSecond).toEqual({ ok: true, status: "processing", slug: "url-single-flight" });
    await vi.waitFor(() => {
      expect(store.statuses("url-single-flight", "url")).toEqual(["processing", "processing"]);
    });
    await releaseExtractions(directUrl);
    await waitForSynthesis("Url Single Flight", 1);
    await releaseSyntheses("Url Single Flight");
    await vi.waitFor(() => {
      expect(store.statuses("url-single-flight", "url")).toEqual(["succeeded", "succeeded"]);
    });
    expect(
      store.submissionRows.filter(
        (row) => row.slug === "url-single-flight" && row.type === "automated",
      ),
    ).toHaveLength(0);

    expect(harness.onAction).toBeDefined();
    const duplicateHaActions = [
      harness.onAction!({ decision: "accept", slug: "ha-single-flight" }),
      harness.onAction!({ decision: "accept", slug: "ha-single-flight" }),
    ];
    await waitForExtraction(haArticle.url, 1);
    const haRouteJoin = await post(`${config.publicBaseUrl}/queue/convert/ha-single-flight`, config);
    expect(haRouteJoin).toEqual({ ok: true, status: "processing" });
    await releaseExtractions(haArticle.url);
    await waitForSynthesis("Ha Single Flight", 1);
    expect(harness.maxActiveSyntheses).toBe(1);

    store.createGate = gate();
    store.terminalGate = gate();
    const lateJoin = post(`${config.publicBaseUrl}/queue/convert/ha-single-flight`, config);
    await vi.waitFor(() => expect(store.createGate!.waiting).toBe(1));
    await releaseSyntheses("Ha Single Flight");
    await vi.waitFor(() => expect(store.terminalGate!.waiting).toBe(2));
    store.processingGate = gate();
    store.createGate.release();
    expect(await lateJoin).toEqual({ ok: true, status: "processing" });
    expect(store.processingGate.waiting).toBe(1);
    store.terminalGate.release();
    await vi.waitFor(() => {
      expect(store.statuses("ha-single-flight", "automated")).toEqual(["succeeded"]);
    });
    await new Promise((resolve) => setImmediate(resolve));
    store.processingGate.release();
    await Promise.all(duplicateHaActions);

    const rows = store.submissionRows.map(({ type, status, slug }) => ({ type, status, slug }));

    expect(
      rows.filter((row) => row.slug === "feed-single-flight" && row.type === "feed"),
    ).toEqual([
      { type: "feed", status: "succeeded", slug: "feed-single-flight" },
      { type: "feed", status: "succeeded", slug: "feed-single-flight" },
    ]);
    expect(
      rows.filter((row) => row.slug === "url-single-flight" && row.type === "url"),
    ).toEqual([
      { type: "url", status: "succeeded", slug: "url-single-flight" },
      { type: "url", status: "succeeded", slug: "url-single-flight" },
    ]);
    expect(
      rows.filter((row) => row.slug === "ha-single-flight" && row.type === "automated"),
    ).toEqual([
      { type: "automated", status: "succeeded", slug: "ha-single-flight" },
    ]);
    expect(store.statuses("ha-single-flight", "feed")).toEqual(["succeeded", "succeeded"]);
    expect(notified).toEqual([
      { tag: "pirate-radio-ready-feed-single-flight", statuses: ["succeeded", "succeeded"] },
      { tag: "pirate-radio-ready-url-single-flight", statuses: ["succeeded", "succeeded"] },
      {
        tag: "pirate-radio-ready-ha-single-flight",
        statuses: ["succeeded", "succeeded", "succeeded"],
      },
    ]);
    expect(extractionCount(feedArticle.url)).toBe(1);
    expect(extractionCount(directUrl)).toBe(1);
    expect(extractionCount(haArticle.url)).toBe(1);
    expect(harness.maxActiveSyntheses).toBe(1);

    store.rejectAutomatedSubmission = true;
    await expect(
      harness.onAction!({ decision: "accept", slug: "failed-automated-submission" }),
    ).resolves.toBeUndefined();
    expect(extractionCount(failedAutomatedArticle.url)).toBe(0);
    expect(
      store.submissionRows.filter((row) => row.slug === "failed-automated-submission"),
    ).toHaveLength(0);
    expect(notified.at(-1)).toEqual({
      tag: "pirate-radio-failed-failed-automated-submission",
      statuses: [],
    });
  });

  test("a feed timeout during startup still rejects start", async () => {
    const { service, intervals, fetchArticleFeeds } = await pollService();
    fetchArticleFeeds.mockRejectedValueOnce(timeoutError());

    await expect(service.start()).rejects.toMatchObject({ name: "TimeoutError" });
    expect(intervals).not.toHaveBeenCalled();
  });

  test("a recurring poll timeout is logged instead of rejecting the interval", async () => {
    const { service, intervals, fetchArticleFeeds } = await pollService();
    const reason = timeoutError();
    fetchArticleFeeds.mockResolvedValueOnce([]).mockRejectedValueOnce(reason);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    onTestFinished(() => errors.mockRestore());

    await service.start();
    (intervals.mock.calls[0]?.[0] as () => void)();

    await vi.waitFor(() => {
      expect(errors).toHaveBeenCalledWith("[pirate-radio] poll failed", reason);
    });
  });
});

async function pollService() {
  const dir = await mkdtemp(join(tmpdir(), "pirate-poll-"));
  const intervals = vi
    .spyOn(globalThis, "setInterval")
    .mockReturnValue({ unref() {} } as unknown as ReturnType<typeof setInterval>);
  const { fetchArticleFeeds } = vi.mocked(await import("../src/feed.js"));
  onTestFinished(async () => {
    intervals.mockRestore();
    fetchArticleFeeds.mockReset();
    await rm(dir, { recursive: true, force: true });
  });
  const { PirateRadioService } = await import("../src/server.js");
  const service = new PirateRadioService({
    config: reliabilityConfig(dir),
    database: new RuntimeStore() as unknown as PirateRadioDatabase,
    authenticator: new FakeAuthenticator(),
    notifier: { send: async () => {} },
  });
  return { service, intervals, fetchArticleFeeds };
}

function reliabilityConfig(dir: string): PirateRadioConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    publicBaseUrl: "http://127.0.0.1",
    libraryDir: join(dir, "library"),
    statePath: join(dir, "state.json"),
    pollIntervalMs: 60_000,
    maxNotificationsPerPoll: 0,
    feedUrl: "https://local.invalid/feed.xml",
    feeds: [
      {
        id: "local",
        name: "Local",
        type: "substack",
        url: "https://local.invalid/feed.xml",
      },
    ],
    enableAlignment: false,
    databaseUrl: "postgres://unused/repro",
    oidcIssuer: "https://auth.invalid/application/o/pirate-radio/",
    oidcClientId: "repro",
    oidcClientSecret: "not-a-real-secret",
    oidcScopes: "openid profile email groups",
    memberGroup: "pirate-radio-users",
    adminGroup: "pirate-radio-admins",
    sessionLifetimeHours: 24,
  };
}

async function post(
  url: string,
  config: PirateRadioConfig,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      origin: config.publicBaseUrl,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return response.json();
}

async function waitForExtraction(url: string, count: number): Promise<void> {
  await vi.waitFor(() => {
    expect(harness.extractions.filter((item) => item.url === url)).toHaveLength(count);
  });
}

async function releaseExtractions(url: string): Promise<void> {
  const matching = harness.extractions.filter((item) => item.url === url);
  harness.extractions = harness.extractions.filter((item) => item.url !== url);
  for (const item of matching) {
    item.resolve({
      sourceUrl: url,
      title: titleFromUrl(url),
      text: "Fixture body text.",
      wordCount: 3,
      characterCount: 18,
      extractedAt: "2026-10-26T00:00:00.000Z",
    });
  }
}

async function waitForSynthesis(title: string, count: number): Promise<void> {
  await vi.waitFor(() => {
    expect(harness.syntheses.filter((item) => item.request.title === title)).toHaveLength(count);
  });
}

async function releaseSyntheses(title: string): Promise<void> {
  const matching = harness.syntheses.filter((item) => item.request.title === title);
  harness.syntheses = harness.syntheses.filter((item) => item.request.title !== title);
  for (const item of matching) {
    await mkdir(dirname(item.request.outputPath), { recursive: true });
    await writeFile(item.request.outputPath, Buffer.from("mock mp3"));
    item.resolve({
      provider: "mock",
      outputPath: item.request.outputPath,
      estimatedCostUsd: 0,
    });
  }
}

function extractionCount(url: string): number {
  return harness.extractionStarts.filter((startedUrl) => startedUrl === url).length;
}

function titleFromUrl(url: string): string {
  return new URL(url).pathname
    .split("/")
    .filter(Boolean)
    .at(-1)!
    .split("-")
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
}

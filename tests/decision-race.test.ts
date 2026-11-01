import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test, vi } from "vitest";
import type { PirateRadioConfig } from "../src/config.js";
import type { PirateRadioDatabase } from "../src/database.js";
import type { PirateArticle } from "../src/feed.js";
import type { TtsRequest, TtsResult } from "../src/tts/index.js";
import { readLibraryManifest } from "../src/library.js";
import type { PirateRadioState } from "../src/state.js";
import { FakeAuthenticator, MemoryStore } from "./support/fakes.js";

const harness = vi.hoisted(() => ({
  servers: [] as Server[],
  directories: [] as string[],
  synthesize: undefined as ((request: TtsRequest) => Promise<TtsResult>) | undefined,
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
    fetchArticleFeeds: vi.fn(async () => []),
  };
});

vi.mock("../src/browser.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/browser.js")>();
  return {
    ...actual,
    extractStoryFromUrl: vi.fn(async (url: string) => ({
      sourceUrl: url,
      title: "Race Window",
      text: "Body text for the decision race.",
      wordCount: 6,
      characterCount: 32,
      extractedAt: "2026-11-01T00:00:00.000Z",
    })),
  };
});

vi.mock("../src/tts/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/tts/index.js")>();
  return {
    ...actual,
    createTtsProvider: vi.fn(() => ({
      synthesize: (request: TtsRequest) => {
        if (!harness.synthesize) throw new Error("Missing synthesize gate");
        return harness.synthesize(request);
      },
    })),
  };
});

const article: PirateArticle = {
  id: "https://local.invalid/p/race-window",
  title: "Race Window",
  url: "https://local.invalid/p/race-window",
  author: "Fixture",
  publishedAt: "Sat, 01 Nov 2026 00:00:00 GMT",
  description: "Decision race fixture.",
  sourceId: "local",
  slug: "race-window",
  sourceType: "substack",
  sourceName: "Local",
};

afterAll(async () => {
  for (const server of harness.servers) {
    server.closeAllConnections?.();
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }
  await Promise.all(harness.directories.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("approve and skip decisions", () => {
  test("a skip during the accept speech window leaves the article skipped, not approved", async () => {
    const started = deferred<void>();
    const release = deferred<void>();
    let speechStarts = 0;
    harness.synthesize = async (request) => {
      speechStarts += 1;
      started.resolve();
      await release.promise;
      await mkdir(dirname(request.outputPath), { recursive: true });
      await writeFile(request.outputPath, Buffer.from("mock mp3"));
      return { provider: "mock", outputPath: request.outputPath, estimatedCostUsd: 0 };
    };
    const notifications: string[] = [];
    const { service, store, statePath, libraryDir } = await startService(async (notification) => {
      notifications.push(notification.tag);
    });

    const accept = service.decide(article.slug!, "accept");
    await started.promise;
    const joined = service.decide(article.slug!, "accept");
    await service.decide(article.slug!, "skip");
    release.resolve();
    await accept;
    await joined;

    const persisted = await readPersistedState(statePath);
    const manifest = await readLibraryManifest(libraryDir);
    expect({
      approved: Boolean(persisted.approved[article.id]),
      skipped: Boolean(persisted.skipped[article.id]),
      librarySlugs: manifest.items.map((item) => item.slug),
      notifications,
      submissionStatuses: store.submissionRows.map((row) => row.status),
      speechStarts,
    }).toEqual({
      approved: false,
      skipped: true,
      librarySlugs: [],
      notifications: [],
      submissionStatuses: ["failed"],
      speechStarts: 1,
    });
  });

  test("a skip after a finished accept replaces the persisted approval", async () => {
    harness.synthesize = async (request) => {
      await mkdir(dirname(request.outputPath), { recursive: true });
      await writeFile(request.outputPath, Buffer.from("mock mp3"));
      return { provider: "mock", outputPath: request.outputPath, estimatedCostUsd: 0 };
    };
    const { service, statePath, libraryDir } = await startService(async () => {});
    await service.decide(article.slug!, "accept");
    await service.decide(article.slug!, "skip");

    const persisted = await readPersistedState(statePath);
    const manifest = await readLibraryManifest(libraryDir);
    expect(persisted.approved[article.id]).toBeUndefined();
    expect(persisted.skipped[article.id]?.article.id).toBe(article.id);
    expect(manifest.items.map((item) => item.slug)).toEqual([article.slug]);
  });
});

class DecisionStore extends MemoryStore {
  async migrate(): Promise<void> {}
}

async function startService(send: (notification: { tag: string }) => Promise<void> | void) {
  const dir = await mkdtemp(join(tmpdir(), "pirate-decision-race-"));
  harness.directories.push(dir);
  const libraryDir = join(dir, "library");
  const statePath = join(dir, "state.json");
  const state: PirateRadioState = {
    initialized: true,
    initializedFeedIds: ["local"],
    seen: { [article.id]: article },
    pending: { [article.slug!]: article },
    approved: {},
    skipped: {},
  };
  await mkdir(libraryDir, { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  const intervalSpy = vi
    .spyOn(globalThis, "setInterval")
    .mockImplementation((() => ({ unref() {} })) as unknown as typeof setInterval);
  const { PirateRadioService } = await import("../src/server.js");
  const store = new DecisionStore();
  const service = new PirateRadioService({
    config: raceConfig(libraryDir, statePath),
    database: store as unknown as PirateRadioDatabase,
    authenticator: new FakeAuthenticator(),
    notifier: { send: async (notification) => { await send(notification); } },
  });
  try {
    await service.start();
  } finally {
    intervalSpy.mockRestore();
  }
  return { service, store, statePath, libraryDir };
}

function raceConfig(libraryDir: string, statePath: string): PirateRadioConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    publicBaseUrl: "http://127.0.0.1",
    libraryDir,
    statePath,
    pollIntervalMs: 60_000,
    maxNotificationsPerPoll: 0,
    feedUrl: "https://local.invalid/feed.xml",
    feeds: [{ id: "local", name: "Local", type: "substack", url: "https://local.invalid/feed.xml" }],
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

async function readPersistedState(statePath: string): Promise<PirateRadioState> {
  return JSON.parse(await readFile(statePath, "utf8")) as PirateRadioState;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import { writeAlignment } from "../src/alignment.js";
import { proposeHostAdapter, extractStoryViaCloud, type CloudAgentFactory } from "../src/cloudExtract.js";
import { resetCreditReporter } from "../src/credits.js";
import type { PirateRadioConfig } from "../src/config.js";
import type { PirateRadioDatabase } from "../src/database.js";
import { XaiTtsProvider } from "../src/tts/xai.js";
import type { Story } from "../src/types.js";
import { extractXArticleFromUrl } from "../src/xArticle.js";
import { FakeAuthenticator, MemoryStore } from "./support/fakes.js";

const TEAM_ID = "11111111-2222-4333-8444-555555555555";
const KEY = "sk-testkeytestkeytestkey";
const CURSOR_KEY = "crsr_test_secret_value";
const PERMISSION = "The caller does not have permission to execute the specified operation";
const CREDIT_SENTENCE =
  "has either used all available credits or reached its monthly spending limit. To continue making API requests, please purchase more credits or raise your spending limit.";
const XAI_CREDIT_BODY = JSON.stringify({
  code: PERMISSION,
  error: `Team ${TEAM_ID} ${CREDIT_SENTENCE} ${KEY}${"a".repeat(800)}`,
});
const GENERIC_XAI_BODY = JSON.stringify({ code: PERMISSION });
const NO_CREDITS_BODY = JSON.stringify({
  error: "Team team_abc12345 doesn't have any credits.",
});
const BROKER = "https://homelab.example.test";
const ARTICLE_URL = "https://x.com/demishassabis/status/2076957440109625718";
const SOURCE_URL = "https://darioamodei.com/post/we-must-pace-the-frontier";

const savedEnv = {
  homelabUrl: process.env.HOMELAB_FUNCTIONS_URL,
  homelabToken: process.env.HOMELAB_FUNCTIONS_TOKEN,
  xaiKey: process.env.XAI_API_KEY,
};

const harness = vi.hoisted(() => ({
  servers: [] as Server[],
  extractStory: vi.fn(async (_url: string, _options?: unknown): Promise<Story> => {
    throw new Error("extract unused");
  }),
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

vi.mock("../src/browser.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/browser.js")>();
  return {
    ...actual,
    extractStoryFromUrl: (...args: Parameters<typeof actual.extractStoryFromUrl>) => harness.extractStory(...args),
  };
});

vi.mock("../src/feed.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/feed.js")>();
  return {
    ...actual,
    fetchArticleFeeds: vi.fn(async () => []),
  };
});

afterEach(() => {
  restoreEnv("HOMELAB_FUNCTIONS_URL", savedEnv.homelabUrl);
  restoreEnv("HOMELAB_FUNCTIONS_TOKEN", savedEnv.homelabToken);
  restoreEnv("XAI_API_KEY", savedEnv.xaiKey);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  harness.extractStory.mockReset();
  harness.extractStory.mockRejectedValue(new Error("extract unused"));
  resetCreditReporter();
});

afterAll(async () => {
  for (const server of harness.servers) {
    server.closeAllConnections?.();
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }
});

describe("xAI credit exhaustion", () => {
  test("classifies a long 403 credit body before the log slice and reports it redacted", async () => {
    const logged: string[] = [];
    vi.spyOn(console, "error").mockImplementation((message?: unknown) => {
      logged.push(String(message));
    });
    const broker = installBroker();
    const timeouts = vi.spyOn(AbortSignal, "timeout");
    let ttsCalls = 0;
    const provider = new XaiTtsProvider({
      apiKey: "test-xai-key",
      retryDelaysMs: [0, 0],
      fetchImpl: async () => {
        ttsCalls += 1;
        return new Response(XAI_CREDIT_BODY, { status: 403 });
      },
    });

    const error = await provider.synthesize(speechRequest()).catch((caught: unknown) => caught);

    expect(XAI_CREDIT_BODY.indexOf("used all available credits")).toBeGreaterThan(120);
    expect(ttsCalls).toBe(1);
    expect(error).toMatchObject({
      name: "CreditExhaustedError",
      provider: "xai",
      status: 403,
      message: "paused: xAI out of credits",
    });
    const redacted = redactedBody(error);
    expect(redacted).toContain("used all available credits");
    expect(redacted).toContain("monthly spending limit");
    expect(redacted.length).toBeLessThanOrEqual(500);
    expect(redacted).not.toContain(TEAM_ID);
    expect(redacted).not.toContain(KEY);
    expect(broker.reports).toEqual([
      expect.objectContaining({
        provider: "xai",
        service: "pirate-radio",
        kind: "error",
        status: 403,
        body: redacted,
      }),
    ]);
    expect(broker.authorizations).toEqual(["Bearer test-token"]);
    expect(Date.parse(String(broker.reports[0]?.observed_at))).toBeGreaterThan(Date.now() - 60_000);
    const line = logged.find((entry) => entry.startsWith("xAI tts 403:"));
    expect(line).toBeDefined();
    expect(line).not.toContain("used all available credits");
    expect(line).not.toContain(TEAM_ID);
    expect(line!.slice("xAI tts 403: ".length).length).toBeLessThanOrEqual(120);
    expect(timeouts).toHaveBeenCalledWith(10_000);
  });

  test("does not retry a 429 that is out of credits", async () => {
    installBroker();
    let ttsCalls = 0;
    const provider = new XaiTtsProvider({
      apiKey: "test-xai-key",
      retryDelaysMs: [0, 0],
      fetchImpl: async () => {
        ttsCalls += 1;
        return new Response(`Team ${TEAM_ID} ${CREDIT_SENTENCE}`, { status: 429 });
      },
    });

    const error = await provider.synthesize(speechRequest()).catch((caught: unknown) => caught);

    expect(ttsCalls).toBe(1);
    expect(error).toMatchObject({
      name: "CreditExhaustedError",
      provider: "xai",
      status: 429,
      message: "paused: xAI out of credits",
    });
  });

  test("a 403 that only says the caller lacks permission stays a normal provider error", async () => {
    const broker = installBroker();
    let ttsCalls = 0;
    const provider = new XaiTtsProvider({
      apiKey: "test-xai-key",
      retryDelaysMs: [0, 0],
      fetchImpl: async () => {
        ttsCalls += 1;
        return new Response(GENERIC_XAI_BODY, { status: 403 });
      },
    });

    const error = await provider.synthesize(speechRequest()).catch((caught: unknown) => caught);

    expect(ttsCalls).toBe(1);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toMatchObject({ name: "CreditExhaustedError" });
    expect((error as Error).message).toBe("xAI tts failed (403)");
    expect(broker.reports).toEqual([]);
  });

  test("classifies a team that doesn't have any credits", async () => {
    const provider = new XaiTtsProvider({
      apiKey: "test-xai-key",
      fetchImpl: async () => new Response(NO_CREDITS_BODY, { status: 403 }),
    });

    const error = await provider.synthesize(speechRequest()).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ name: "CreditExhaustedError", provider: "xai", status: 403 });
    expect(redactedBody(error)).not.toContain("team_abc12345");
    expect(redactedBody(error)).toContain("doesn't have any credits");
  });

  test("a 500 that mentions credits stays retryable", async () => {
    installBroker();
    let ttsCalls = 0;
    const provider = new XaiTtsProvider({
      apiKey: "test-xai-key",
      retryDelaysMs: [0, 0],
      fetchImpl: async () => {
        ttsCalls += 1;
        return new Response(XAI_CREDIT_BODY, { status: 500 });
      },
    });

    const error = await provider.synthesize(speechRequest()).catch((caught: unknown) => caught);

    expect(ttsCalls).toBe(3);
    expect((error as Error).message).toBe("xAI tts failed (500)");
    expect(error).not.toMatchObject({ name: "CreditExhaustedError" });
  });

  test("a broker failure still surfaces the credit error and the next spoken article reports recovery", async () => {
    const broker = installBroker({ fail: true });
    let ttsCalls = 0;
    const provider = new XaiTtsProvider({
      apiKey: "test-xai-key",
      retryDelaysMs: [0, 0],
      fetchImpl: async () => {
        ttsCalls += 1;
        if (ttsCalls === 1) return new Response(XAI_CREDIT_BODY, { status: 403 });
        return new Response(Buffer.from("recovered-audio"), {
          status: 200,
          headers: { "Content-Type": "audio/mpeg" },
        });
      },
    });

    const error = await provider.synthesize(speechRequest()).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ name: "CreditExhaustedError", message: "paused: xAI out of credits" });
    await vi.waitFor(() => expect(broker.reports.map((report) => report.kind)).toEqual(["error"]));

    const dir = await mkdtemp(join(tmpdir(), "pirate-credit-recover-"));
    try {
      const result = await provider.synthesize({
        ...speechRequest(),
        outputPath: join(dir, "story.mp3"),
      });
      expect(result.provider).toBe("xai");
      await vi.waitFor(() => expect(broker.reports.map((report) => report.kind)).toEqual(["error", "success"]));
      expect(broker.reports[1]).toEqual({
        provider: "xai",
        service: "pirate-radio",
        kind: "success",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a successful xAI call does not report recovery when credits were never exhausted", async () => {
    const broker = installBroker();
    const dir = await mkdtemp(join(tmpdir(), "pirate-credit-ok-"));
    try {
      const provider = new XaiTtsProvider({
        apiKey: "test-xai-key",
        fetchImpl: async () =>
          new Response(Buffer.from("plain-audio"), {
            status: 200,
            headers: { "Content-Type": "audio/mpeg" },
          }),
      });
      await provider.synthesize({ ...speechRequest(), outputPath: join(dir, "story.mp3") });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(broker.reports).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("speech-to-text credit exhaustion", () => {
  test("alignment uses the same xAI credit error", async () => {
    installBroker();
    process.env.XAI_API_KEY = "test-xai-key";
    const dir = await mkdtemp(join(tmpdir(), "pirate-credit-align-"));
    const audioPath = join(dir, "story.mp3");
    await writeFile(audioPath, Buffer.from("audio"));
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/v1/credits/report")) {
        return new Response(null, { status: 204 });
      }
      expect(url).toBe("https://api.x.ai/v1/stt");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(XAI_CREDIT_BODY, { status: 403 });
    });

    try {
      const error = await writeAlignment({
        libraryDir: dir,
        slug: "story",
        audioPath,
      }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        name: "CreditExhaustedError",
        provider: "xai",
        status: 403,
        message: "paused: xAI out of credits",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("X API credit exhaustion", () => {
  test("a 402 spend response is an X credit error, not an authentication failure", async () => {
    const broker = installBroker();
    const error = await extractXArticleFromUrl(ARTICLE_URL, {
      bearerToken: "test-bearer-token",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            title: "CreditsDepleted",
            detail: `Account ${TEAM_ID} does not have any credits. Ref ${KEY}`,
          }),
          { status: 402 },
        ),
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: "CreditExhaustedError",
      provider: "x",
      status: 402,
      message: "paused: X out of credits",
    });
    expect((error as Error).message).not.toContain("authentication failed");
    expect(redactedBody(error)).not.toContain(TEAM_ID);
    expect(redactedBody(error)).not.toContain(KEY);
    expect(broker.reports[0]).toMatchObject({ provider: "x", service: "pirate-radio", kind: "error", status: 402 });
  });

  test("a 403 that names a spend cap is an X credit error", async () => {
    const error = await extractXArticleFromUrl(ARTICLE_URL, {
      bearerToken: "test-bearer-token",
      fetchImpl: async () =>
        new Response(JSON.stringify({ detail: "The app reached its spend cap." }), { status: 403 }),
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: "CreditExhaustedError",
      provider: "x",
      status: 403,
      message: "paused: X out of credits",
    });
  });

  test("a 403 without a spend or credits phrase stays an authentication failure", async () => {
    const broker = installBroker();
    await expect(
      extractXArticleFromUrl(ARTICLE_URL, {
        bearerToken: "bad-token",
        fetchImpl: async () => new Response(JSON.stringify({ detail: "Forbidden" }), { status: 403 }),
      }),
    ).rejects.toThrow("X API authentication failed");
    expect(broker.reports).toEqual([]);
  });
});

describe("Cursor usage limit", () => {
  test("a cloud extract usage limit becomes a Cursor credit error", async () => {
    const broker = installBroker();
    const createAgent: CloudAgentFactory = async () => ({
      send: async () => ({
        wait: async () => ({
          status: "error",
          error: { message: `Monthly additional usage limit reached. Ref ${CURSOR_KEY}.` },
        }),
      }),
      listArtifacts: async () => [],
      downloadArtifact: async () => new Uint8Array(),
      close: vi.fn(),
    });

    const error = await extractStoryViaCloud(
      { url: SOURCE_URL },
      { apiKey: "crsr_test", createAgent },
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: "CreditExhaustedError",
      provider: "cursor",
      message: "paused: Cursor out of credits",
    });
    expect(JSON.stringify(error)).not.toContain(CURSOR_KEY);
    expect(broker.reports[0]).toMatchObject({
      provider: "cursor",
      service: "pirate-radio",
      kind: "error",
    });
    expect(JSON.stringify(broker.reports[0])).not.toContain(CURSOR_KEY);
  });

  test("a thrown Cursor usage_limit_exceeded error uses the same credit error", async () => {
    const createAgent: CloudAgentFactory = async () => {
      const error = new Error("usage_limit_exceeded") as Error & { code?: string };
      error.code = "usage_limit_exceeded";
      throw error;
    };

    const error = await extractStoryViaCloud(
      { url: SOURCE_URL },
      { apiKey: "crsr_test", createAgent },
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: "CreditExhaustedError",
      provider: "cursor",
      message: "paused: Cursor out of credits",
    });
  });

  test("a host adapter agent that hits the usage limit throws the same credit error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pirate-credit-adapter-"));
    const createAgent: CloudAgentFactory = async () => {
      const error = new Error("Monthly additional usage limit reached.") as Error & { code?: string };
      error.code = "usage_limit_exceeded";
      throw error;
    };
    try {
      const error = await proposeHostAdapter({
        hostOrUrl: "darioamodei.com",
        libraryDir: dir,
        apiKey: "crsr_test",
        createAgent,
      }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        name: "CreditExhaustedError",
        provider: "cursor",
        message: "paused: Cursor out of credits",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("credit errors on the queue", () => {
  test("an xAI credit error skips the per-article failure push and records the pause reason", async () => {
    const result = await convertText(XAI_CREDIT_BODY, 403);
    expect(result.submission).toMatchObject({
      status: "failed",
      error: "paused: xAI out of credits",
    });
    expect(result.ttsCalls).toBe(1);
    expect(result.notifications).toEqual([]);
    expect(result.reports.map((report) => report.kind)).toEqual(["error"]);
    expect(result.reports[0]).toMatchObject({
      provider: "xai",
      service: "pirate-radio",
      kind: "error",
      status: 403,
    });
    expect(JSON.stringify(result.reports[0])).not.toContain(TEAM_ID);
    expect(JSON.stringify(result.reports[0])).not.toContain(KEY);
  });

  test("accepting a pending article skips the failure push, keeps the article pending, and can be accepted again", async () => {
    const slug = "credit-feed-story";
    const sourceUrl = "https://example.com/p/credit-feed-story";
    harness.extractStory.mockResolvedValue({
      sourceUrl,
      title: "Credit Feed Story",
      text: "Hello from the feed.",
      wordCount: 4,
      characterCount: 21,
      extractedAt: "2026-11-20T00:00:00.000Z",
    });
    const queue = await startQueue(XAI_CREDIT_BODY, 403, async (statePath) => {
      await mkdir(join(statePath, ".."), { recursive: true });
      await writeFile(statePath, JSON.stringify({
        initialized: true,
        initializedFeedIds: ["local"],
        seen: {},
        pending: {
          [slug]: {
            id: sourceUrl,
            title: "Credit Feed Story",
            url: sourceUrl,
            author: "",
            publishedAt: "",
            description: "",
            slug,
          },
        },
        approved: {},
        skipped: {},
      }));
    });
    try {
      const accept = async () => {
        const response = await fetch(`${queue.baseUrl}/simulate/accept/${slug}`, {
          method: "POST",
          headers: { origin: "http://127.0.0.1" },
        });
        expect(response.status).toBe(200);
      };
      await accept();
      await accept();

      const submissions = await fetch(`${queue.baseUrl}/submissions.json`);
      const payload = (await submissions.json()) as { items: Array<Record<string, unknown>> };
      const failed = payload.items.filter((item) => item.title === "Credit Feed Story");
      expect(failed).toHaveLength(2);
      expect(failed.every((item) => item.status === "failed" && item.error === "paused: xAI out of credits")).toBe(true);
      expect(queue.notifications).toEqual([]);
      expect(queue.ttsCalls()).toBe(2);
      const state = JSON.parse(await readFile(queue.statePath, "utf8")) as {
        pending: Record<string, unknown>;
        approved: Record<string, unknown>;
      };
      expect(state.pending[slug]).toMatchObject({ title: "Credit Feed Story" });
      expect(state.approved).toEqual({});
    } finally {
      await queue.stop();
    }
  });

  test("a generic xAI 403 still sends Pirate Radio Failed", async () => {
    const result = await convertText(GENERIC_XAI_BODY, 403);
    expect(result.submission).toMatchObject({
      status: "failed",
      error: "xAI tts failed (403)",
    });
    expect(result.notifications.map((notification) => notification.title)).toEqual(["Pirate Radio Failed"]);
    expect(result.reports).toEqual([]);
  });
});

function speechRequest() {
  return {
    title: "Story",
    text: "Body",
    outputPath: join(tmpdir(), "credit-story.mp3"),
    allowOverBudget: false,
  };
}

function redactedBody(error: unknown): string {
  return String((error as { redactedBody?: unknown }).redactedBody ?? "");
}

function installBroker(options: { fail?: boolean } = {}) {
  process.env.HOMELAB_FUNCTIONS_URL = BROKER;
  process.env.HOMELAB_FUNCTIONS_TOKEN = "test-token";
  const realFetch = globalThis.fetch;
  const reports: Array<Record<string, unknown>> = [];
  const authorizations: string[] = [];
  const stub: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost")) {
      return realFetch(input, init);
    }
    if (url === `${BROKER}/v1/credits/report`) {
      authorizations.push(String(new Headers(init?.headers).get("authorization")));
      reports.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      if (options.fail) throw new Error("broker down");
      return new Response(null, { status: 204 });
    }
    if (url.startsWith("https://api.x.ai/")) {
      return new Response(XAI_CREDIT_BODY, { status: 403 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  vi.stubGlobal("fetch", stub);
  return { reports, authorizations };
}

async function convertText(body: string, status: number) {
  const queue = await startQueue(body, status);
  try {
    const queued = await fetch(`${queue.baseUrl}/queue/convert-text`, {
      method: "POST",
      headers: {
        origin: "http://127.0.0.1",
        "content-type": "application/json",
      },
      body: JSON.stringify({ title: "Credit story", text: "Hello from the queue." }),
    });
    expect(await queued.json()).toMatchObject({ ok: true, status: "queued" });

    let submission: Record<string, unknown> | undefined;
    await vi.waitFor(async () => {
      const response = await fetch(`${queue.baseUrl}/submissions.json`);
      const payload = (await response.json()) as { items: Array<Record<string, unknown>> };
      submission = payload.items.find((item) => item.title === "Credit story");
      expect(submission?.status).toBe("failed");
      expect(queue.notifications.length + queue.reports.length).toBeGreaterThan(0);
    });
    return { submission, notifications: queue.notifications, reports: queue.reports, ttsCalls: queue.ttsCalls() };
  } finally {
    await queue.stop();
  }
}

async function startQueue(body: string, status: number, prepare?: (statePath: string) => Promise<void>) {
  process.env.HOMELAB_FUNCTIONS_URL = BROKER;
  process.env.HOMELAB_FUNCTIONS_TOKEN = "test-token";
  process.env.XAI_API_KEY = "test-xai-key";
  const realFetch = globalThis.fetch;
  const reports: Array<Record<string, unknown>> = [];
  let ttsCalls = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost")) {
      return realFetch(input, init);
    }
    if (url === `${BROKER}/v1/credits/report`) {
      reports.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return new Response(null, { status: 204 });
    }
    if (url.startsWith("https://api.x.ai/")) {
      ttsCalls += 1;
      return new Response(body, { status });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  const dir = await mkdtemp(join(tmpdir(), "pirate-credit-queue-"));
  const intervalSpy = vi
    .spyOn(globalThis, "setInterval")
    .mockImplementation((() => ({ unref() {} })) as unknown as typeof setInterval);
  const config = queueConfig(dir);
  await prepare?.(config.statePath);
  const { PirateRadioService } = await import("../src/server.js");
  const notifications: Array<{ title: string; message: string }> = [];
  const service = new PirateRadioService({
    config,
    database: new QueueStore() as unknown as PirateRadioDatabase,
    authenticator: new FakeAuthenticator(),
    notifier: {
      send: async (notification) => {
        notifications.push({ title: notification.title, message: notification.message });
      },
    },
  });
  const before = harness.servers.length;
  await service.start();
  const server = harness.servers[before];
  if (!server) throw new Error("Expected the queue server to start");
  await vi.waitFor(() => expect(server.listening).toBe(true));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    statePath: config.statePath,
    notifications,
    reports,
    ttsCalls: () => ttsCalls,
    stop: async () => {
      intervalSpy.mockRestore();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

class QueueStore extends MemoryStore {
  async migrate(): Promise<void> {}
}

function queueConfig(dir: string): PirateRadioConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    publicBaseUrl: "http://127.0.0.1",
    libraryDir: join(dir, "library"),
    statePath: join(dir, "state.json"),
    pollIntervalMs: 60_000,
    maxNotificationsPerPoll: 0,
    feedUrl: "https://local.invalid/feed.xml",
    feeds: [{ id: "local", name: "Local", type: "substack", url: "https://local.invalid/feed.xml" }],
    enableAlignment: false,
    databaseUrl: "postgres://unused/credits",
    oidcIssuer: "https://auth.invalid/application/o/pirate-radio/",
    oidcClientId: "credits",
    oidcClientSecret: "not-a-real-secret",
    oidcScopes: "openid profile email groups",
    memberGroup: "pirate-radio-users",
    adminGroup: "pirate-radio-admins",
    sessionLifetimeHours: 24,
    homelabFunctionsUrl: BROKER,
    homelabFunctionsToken: "test-token",
    cursorApiKey: "crsr_test",
  };
}

function restoreEnv(name: "HOMELAB_FUNCTIONS_URL" | "HOMELAB_FUNCTIONS_TOKEN" | "XAI_API_KEY", value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

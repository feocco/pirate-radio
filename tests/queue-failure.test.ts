import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test, vi } from "vitest";
import type { PirateRadioConfig } from "../src/config.js";
import type { PirateRadioDatabase } from "../src/database.js";
import { publicFailureReason } from "../src/notifications.js";
import { FakeAuthenticator, MemoryStore } from "./support/fakes.js";

const SOURCE_URL = "https://borretti.me/article/taking-ai-seriously";
const SECRET_IN_CURSOR_ERROR = "crsr_test_secret_value";
const CURSOR_API_KEY = "crsr_should_not_leak";

const harness = vi.hoisted(() => ({
  servers: [] as Server[],
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
    extractStoryFromUrl: vi.fn(async () => {
      const error = new Error(
        `Monthly additional usage limit reached. $200. Ref ${SECRET_IN_CURSOR_ERROR}.`,
      ) as Error & { code?: string };
      error.code = "usage_limit_exceeded";
      throw error;
    }),
  };
});

vi.mock("../src/tts/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/tts/index.js")>();
  return {
    ...actual,
    createTtsProvider: vi.fn(() => ({
      synthesize: async () => {
        throw new Error("tts should not run after a failed extract");
      },
    })),
  };
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

describe("public failure text", () => {
  test("keeps a short validation message and drops a key from any other message", () => {
    expect(publicFailureReason("Enter a valid URL.")).toBe("Enter a valid URL.");
    expect(publicFailureReason(new Error("Could not read the article crsr_other_secret."))).toBe(
      "Could not read the article.",
    );
  });
});

describe("failed URL conversion on the queue", () => {
  test("a cloud extract that hits the Cursor usage limit shows as Failed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pirate-queue-failure-"));
    const intervalSpy = vi
      .spyOn(globalThis, "setInterval")
      .mockImplementation((() => ({ unref() {} })) as unknown as typeof setInterval);
    const { PirateRadioService } = await import("../src/server.js");
    const store = new QueueStore();
    const config = queueConfig(dir);
    const notifications: string[] = [];
    const service = new PirateRadioService({
      config,
      database: store as unknown as PirateRadioDatabase,
      authenticator: new FakeAuthenticator(),
      notifier: {
        send: async (notification) => {
          notifications.push(notification.message);
        },
      },
    });
    try {
      await service.start();
      const server = harness.servers.at(-1);
      expect(server).toBeDefined();
      await vi.waitFor(() => expect(server!.listening).toBe(true));
      const address = server!.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP port");
      const baseUrl = `http://127.0.0.1:${address.port}`;

      const queued = await fetch(`${baseUrl}/queue/convert-url`, {
        method: "POST",
        headers: {
          origin: new URL(config.publicBaseUrl).origin,
          "content-type": "application/json",
        },
        body: JSON.stringify({ url: SOURCE_URL }),
      });
      expect(await queued.json()).toMatchObject({ ok: true, status: "queued" });

      let failed: Record<string, unknown> | undefined;
      await vi.waitFor(async () => {
        const response = await fetch(`${baseUrl}/submissions.json`);
        const body = (await response.json()) as { items: Array<Record<string, unknown>> };
        failed = body.items.find((item) => item.sourceUrl === SOURCE_URL);
        expect(failed).toMatchObject({
          status: "failed",
          error: "Cursor usage limit reached",
        });
      });
      expect(JSON.stringify(failed)).not.toContain(SECRET_IN_CURSOR_ERROR);
      expect(JSON.stringify(failed)).not.toContain(CURSOR_API_KEY);
      expect(notifications.join("\n")).toContain("Cursor usage limit reached");
      expect(notifications.join("\n")).not.toContain(SECRET_IN_CURSOR_ERROR);

      const page = await fetch(`${baseUrl}/queue`);
      const html = await page.text();
      const submissionsStart = html.indexOf('id="submissions"');
      const submissions = html.slice(submissionsStart, html.indexOf("</main>", submissionsStart));
      expect(submissions).toContain("Failed");
      expect(submissions).toContain("Cursor usage limit reached");
      expect(submissions).not.toContain(SECRET_IN_CURSOR_ERROR);
      expect(submissions).not.toContain(">queued<");
      expect(submissions).not.toMatch(/status[^<]{0,40}queued/i);
      expect(html).toContain("Failed.");
    } finally {
      intervalSpy.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

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
    databaseUrl: "postgres://unused/queue-failure",
    oidcIssuer: "https://auth.invalid/application/o/pirate-radio/",
    oidcClientId: "queue-failure",
    oidcClientSecret: "not-a-real-secret",
    oidcScopes: "openid profile email groups",
    memberGroup: "pirate-radio-users",
    adminGroup: "pirate-radio-admins",
    sessionLifetimeHours: 24,
    cursorApiKey: CURSOR_API_KEY,
  };
}

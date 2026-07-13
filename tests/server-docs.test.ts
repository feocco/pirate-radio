import { createServer } from "node:http";
import { afterEach, describe, expect, test } from "vitest";
import { createPirateRadioRequestHandler } from "../src/server.js";
import type { PirateRadioConfig } from "../src/config.js";

const baseConfig: PirateRadioConfig = {
  port: 0,
  host: "127.0.0.1",
  publicBaseUrl: "http://127.0.0.1:8123",
  libraryDir: "/tmp/pirate-radio-library",
  statePath: "/tmp/pirate-radio-state.json",
  pollIntervalMs: 60_000,
  maxNotificationsPerPoll: 1,
  feedUrl: "https://piratewires.substack.com/feed.xml",
  feeds: [{ id: "pirate-wires", name: "Pirate Wires", type: "pirate-wires", url: "https://piratewires.substack.com/feed.xml" }],
  enableAlignment: false,
};

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        }),
    ),
  );
});

async function startServer() {
  const handler = createPirateRadioRequestHandler({ config: baseConfig });
  const server = createServer((request, response) => {
    void handler(request, response);
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected an ephemeral TCP port");
  }
  return `http://127.0.0.1:${address.port}`;
}

describe("service docs endpoints", () => {
  test("GET /docs returns browser-friendly HTML that links to the OpenAPI document", async () => {
    const baseUrl = await startServer();

    const response = await fetch(`${baseUrl}/docs`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const body = await response.text();
    expect(body).toContain("<title>Pirate Radio API Docs</title>");
    expect(body).toContain('href="/openapi.json"');
    expect(body).toContain("<code>GET</code>");
    expect(body).toContain("<code>/health</code>");
  });

  test("GET /openapi.json returns an OpenAPI 3.1 document for the public service routes", async () => {
    const baseUrl = await startServer();

    const response = await fetch(`${baseUrl}/openapi.json`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as {
      openapi: string;
      info: { title: string };
      paths: Record<string, unknown>;
    };
    expect(body.openapi).toBe("3.1.0");
    expect(body.info.title).toBe("Pirate Radio API");
    expect(body.paths["/health"]).toBeDefined();
    expect(body.paths["/queue"]).toBeDefined();
    expect(body.paths["/queue.json"]).toBeDefined();
    expect(body.paths["/queue/convert/{slug}"]).toBeDefined();
    expect(body.paths["/progress/{slug}"]).toBeDefined();
    expect(body.paths["/docs"]).toBeDefined();
  });

  test("POST /backlog/convert-text validates large pasted text instead of failing body parsing", async () => {
    const baseUrl = await startServer();

    const response = await fetch(`${baseUrl}/backlog/convert-text`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Large Article", text: "x".repeat(60001) }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      status: "invalid_text",
      error: "Text must be 60,000 characters or less.",
    });
  });
});

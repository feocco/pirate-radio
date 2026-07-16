import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import type { PirateRadioConfig } from "../src/config.js";
import { appendLibraryItem, readLibraryManifest } from "../src/library.js";
import { createPirateRadioRequestHandler } from "../src/server.js";
import { FakeAuthenticator, MemoryStore, adminUser, memberUser } from "./support/fakes.js";

const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(async () => Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))));

async function testServer(principal = { user: memberUser, isAdmin: false }) {
  const libraryDir = await mkdtemp(join(tmpdir(), "pirate-radio-multi-"));
  await mkdir(join(libraryDir, "audio"), { recursive: true });
  await writeFile(join(libraryDir, "audio", "test.mp3"), "0123456789");
  const config: PirateRadioConfig = {
    port: 0, host: "127.0.0.1", publicBaseUrl: "https://pirate-radio.example.com",
    libraryDir, statePath: join(libraryDir, "state.json"), pollIntervalMs: 60_000,
    maxNotificationsPerPoll: 1, feedUrl: "https://example.com/feed.xml", feeds: [],
    enableAlignment: false, oidcScopes: "openid profile email groups", memberGroup: "pirate-radio-users",
    adminGroup: "pirate-radio-admins", sessionLifetimeHours: 24,
  };
  const store = new MemoryStore();
  const authenticator = new FakeAuthenticator(principal);
  const handler = createPirateRadioRequestHandler({ config, store, authenticator });
  const server = createServer((request, response) => void handler(request, response));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  return { baseUrl: `http://127.0.0.1:${address.port}`, config, store, authenticator };
}

describe("multi-user authorization and progress", () => {
  test("revokes the application session and redirects through OIDC logout", async () => {
    const runtime = await testServer();
    const response = await fetch(`${runtime.baseUrl}/auth/logout`, {
      method: "POST",
      headers: { origin: runtime.config.publicBaseUrl },
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("/end-session/");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  test("ignores spoofed identity headers and protects media", async () => {
    const runtime = await testServer();
    runtime.authenticator.principal = undefined;
    const response = await fetch(`${runtime.baseUrl}/audio/test.mp3`, { headers: { "x-auth-user": "admin", "x-forwarded-user": "admin" } });
    expect(response.status).toBe(401);
  });

  test("allows members but denies admin operations", async () => {
    const runtime = await testServer();
    expect((await fetch(`${runtime.baseUrl}/library.json`)).status).toBe(200);
    expect((await fetch(`${runtime.baseUrl}/admin`)).status).toBe(403);
    expect((await fetch(`${runtime.baseUrl}/simulate/accept/test`, { method: "POST", headers: { origin: runtime.config.publicBaseUrl } })).status).toBe(403);
  });

  test("allows only administrators to archive and delete a library article", async () => {
    const runtime = await testServer();
    const audioPath = join(runtime.config.libraryDir, "audio", "test.mp3");
    await appendLibraryItem(runtime.config.libraryDir, {
      slug: "test",
      title: "Test Article",
      sourceUrl: "https://example.com/test",
      audioPath,
      jsonPath: join(runtime.config.libraryDir, "stories", "test.json"),
      textPath: join(runtime.config.libraryDir, "text", "test.txt"),
      publishedAt: "2026-07-16T00:00:00.000Z",
      generatedAt: "2026-07-16T01:00:00.000Z",
      estimatedCostUsd: 0.01,
      wordCount: 2,
      characterCount: 12,
    });
    const path = `${runtime.baseUrl}/admin/articles/test/delete`;

    expect((await fetch(path, { method: "POST", headers: { origin: runtime.config.publicBaseUrl } })).status).toBe(403);
    expect((await readLibraryManifest(runtime.config.libraryDir)).items).toHaveLength(1);

    runtime.authenticator.principal = { user: adminUser, isAdmin: true };
    const response = await fetch(path, {
      method: "POST",
      headers: { origin: runtime.config.publicBaseUrl },
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");
    expect((await readLibraryManifest(runtime.config.libraryDir)).items).toHaveLength(0);
    expect((await fetch(path, { method: "POST", headers: { origin: runtime.config.publicBaseUrl } })).status).toBe(404);
  });

  test("rejects state-changing requests from a foreign or missing Origin", async () => {
    const runtime = await testServer({ user: adminUser, isAdmin: true });
    expect((await fetch(`${runtime.baseUrl}/progress/test`, { method: "PUT", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: JSON.stringify({ positionSeconds: 1 }) })).status).toBe(403);
    expect((await fetch(`${runtime.baseUrl}/progress/test`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ positionSeconds: 1 }) })).status).toBe(403);
  });

  test("isolates progress rows between two users", async () => {
    const runtime = await testServer();
    await fetch(`${runtime.baseUrl}/progress/test`, { method: "PUT", headers: { "content-type": "application/json", origin: runtime.config.publicBaseUrl }, body: JSON.stringify({ positionSeconds: 10, durationSeconds: 100 }) });
    runtime.authenticator.principal = { user: adminUser, isAdmin: true };
    expect((await fetch(`${runtime.baseUrl}/progress/test`)).status).toBe(404);
    await fetch(`${runtime.baseUrl}/progress/test`, { method: "PUT", headers: { "content-type": "application/json", origin: runtime.config.publicBaseUrl }, body: JSON.stringify({ positionSeconds: 20, durationSeconds: 100 }) });
    expect((await runtime.store.progress(memberUser.id, "test"))?.positionSeconds).toBe(10);
    expect((await runtime.store.progress(adminUser.id, "test"))?.positionSeconds).toBe(20);
  });

  test("completes at 95 percent or ended and never clears completion", async () => {
    const store = new MemoryStore();
    expect((await store.saveProgress(memberUser.id, "boundary", 94.9, 100)).completedAt).toBeUndefined();
    const completed = await store.saveProgress(memberUser.id, "boundary", 95, 100);
    expect(completed.completedAt).toBeDefined();
    expect((await store.saveProgress(memberUser.id, "boundary", 1, 100)).completedAt).toBe(completed.completedAt);
    expect((await store.saveProgress(adminUser.id, "ended", 1, 100, true)).completedAt).toBeDefined();
  });

  test("keeps submitter snapshots and current attribution after IdP access disappears", async () => {
    const store = new MemoryStore();
    const submission = await store.createSubmission({ slug: "test", type: "url", submittedBy: memberUser });
    await store.updateSubmission(submission.id, "succeeded");
    expect((await store.firstSuccessfulSubmitter("test"))?.username).toBe("member");
    expect((await store.submissions())[0].submittedByUsername).toBe("member");
  });
});

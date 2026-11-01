import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const repoRoot = join(import.meta.dirname, "..");
const stubPath = join(repoRoot, "tests/qa/network-stub.mjs");

interface ChildResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runWithStub(script: string, env: Record<string, string | undefined>): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", stubPath, "--input-type=module", "-e", script], {
      cwd: repoRoot,
      env: { PATH: process.env.PATH, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

const fetchAndReport = (url: string) => `
  try {
    const response = await fetch(${JSON.stringify(url)}, { headers: { authorization: "Bearer fake" } });
    console.log(JSON.stringify({ status: response.status, body: await response.text() }));
  } catch (error) {
    console.log(JSON.stringify({ error: String(error?.message ?? error) }));
  }
`;

describe("QA network stub preload", () => {
  const seen: Array<{ url: string; authorization?: string }> = [];
  let server: Server;
  let target: string;

  beforeAll(async () => {
    server = createServer((request: IncomingMessage, response) => {
      seen.push({ url: request.url ?? "", authorization: request.headers.authorization });
      response.end(`fixture:${request.url}`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    target = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const devEnv = () => ({
    PIRATE_RADIO_DEV_STACK: "1",
    PIRATE_RADIO_QA_ROUTES: JSON.stringify({ "https://api.x.ai": target }),
  });

  test("refuses to load outside the dev stack", async () => {
    const result = await runWithStub("console.log('loaded')", { PIRATE_RADIO_QA_ROUTES: "{}" });
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("loaded");
    expect(result.stderr).toContain("refusing to load");
  });

  test("refuses to load in production even with the dev flag", async () => {
    const result = await runWithStub("console.log('loaded')", { ...devEnv(), NODE_ENV: "production" });
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("loaded");
  });

  test("refuses a route whose target is not loopback", async () => {
    const result = await runWithStub("console.log('loaded')", {
      PIRATE_RADIO_DEV_STACK: "1",
      PIRATE_RADIO_QA_ROUTES: JSON.stringify({ "https://api.x.ai": "https://collector.example.com" }),
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("loaded");
    expect(result.stderr).toContain("must target loopback");
  });

  test("routes a configured origin to its loopback target with path, query, and headers", async () => {
    const result = await runWithStub(fetchAndReport("https://api.x.ai/v1/tts?voice=eve"), devEnv());
    expect(JSON.parse(result.stdout)).toEqual({ status: 200, body: "fixture:/v1/tts?voice=eve" });
    expect(seen.at(-1)).toEqual({ url: "/v1/tts?voice=eve", authorization: "Bearer fake" });
  });

  test("passes loopback requests through unchanged", async () => {
    const result = await runWithStub(fetchAndReport(`${target}/direct`), devEnv());
    expect(JSON.parse(result.stdout)).toEqual({ status: 200, body: "fixture:/direct" });
  });

  test("blocks unrouted external requests before they reach the network", async () => {
    const before = seen.length;
    const result = await runWithStub(fetchAndReport("https://example.com/leak"), devEnv());
    expect(JSON.parse(result.stdout).error).toContain("blocked external request to https://example.com/leak");
    expect(result.stderr).toContain("[qa-network] blocked https://example.com/leak");
    expect(seen.length).toBe(before);
  });
});

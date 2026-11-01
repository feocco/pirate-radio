import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type RequestListener, type Server } from "node:http";
import { get as httpsGet } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const QA_XAI_KEY = "qa-fake-xai-key";
export const UNSUPPORTED_SERVICE_TOKEN = "qa-unsupported-service-token";
export const QA_FIXTURE_ORIGIN = "http://pirate-radio-qa.substack.com";
export const DEFAULT_QA_DATABASE_URL = "postgres://pirate_radio:pirate_radio@127.0.0.1:5432/pirate_radio_qa";

const repoRoot = join(import.meta.dirname, "..", "..");
const READY_TIMEOUT_MS = 30_000;

export interface XaiRequest {
  authorization?: string;
  text: string;
}

export interface QaStack {
  baseUrl: string;
  libraryDir: string;
  xaiRequests: XaiRequest[];
  fixtureArticleUrl(slug: string): string;
  serveLog(): string;
  blockedRequests(): string[];
  stop(): Promise<void>;
}

interface LoggedProcess {
  child: ChildProcess;
  log: () => string;
  exited: Promise<number | null>;
}

export function silentMp3(seconds: number): Buffer {
  // MPEG-1 Layer III, 32 kbps, 44.1 kHz, mono. Zeroed side info decodes as silence.
  const frame = Buffer.alloc(104);
  frame.set([0xff, 0xfb, 0x10, 0xc4]);
  return Buffer.concat(Array.from({ length: Math.ceil((seconds * 44_100) / 1_152) }, () => frame));
}

export async function startQaStack(): Promise<QaStack> {
  const cli = join(repoRoot, "dist/src/cli.js");
  if (!existsSync(cli)) throw new Error("dist/src/cli.js is missing. Run `npm run build` (npm run qa does this).");

  const databaseUrl = process.env.PIRATE_RADIO_QA_DATABASE_URL ?? DEFAULT_QA_DATABASE_URL;
  const libraryDir = await mkdtemp(join(tmpdir(), "pirate-radio-qa-"));
  const articleHtml = await readFile(join(repoRoot, "tests/fixtures/qa-article.html"), "utf8");
  const feedXml = await readFile(join(repoRoot, "tests/fixtures/hyperdimensional-feed.xml"), "utf8");
  const xaiRequests: XaiRequest[] = [];
  const processes: LoggedProcess[] = [];
  const servers: Server[] = [];

  const stop = async () => {
    for (const { child } of processes) child.kill("SIGTERM");
    await Promise.all(processes.map(({ exited }) => exited));
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    await rm(libraryDir, { recursive: true, force: true });
  };

  try {
    const fixtureSite = await listen(servers, (request, response) => {
      const path = new URL(request.url ?? "/", "http://fixture").pathname;
      if (request.method === "GET" && /^\/p\/[a-z0-9-]+$/.test(path)) {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(articleHtml);
      } else if (request.method === "GET" && path === "/feed.xml") {
        response.writeHead(200, { "content-type": "application/rss+xml" }).end(feedXml);
      } else {
        response.writeHead(404).end("not found");
      }
    });

    const mockXai = await listen(servers, async (request, response) => {
      if (request.method !== "POST" || request.url !== "/v1/tts") {
        response.writeHead(404, { "content-type": "application/json" }).end('{"error":"mock xAI: unsupported route"}');
        return;
      }
      let body = "";
      for await (const chunk of request) body += chunk;
      xaiRequests.push({ authorization: request.headers.authorization, text: String(JSON.parse(body).text ?? "") });
      response.writeHead(200, { "content-type": "audio/mpeg" }).end(silentMp3(3));
    });

    const oidcPort = await freePort();
    const servePort = await freePort();
    const issuer = `https://localhost:${oidcPort}`;
    const baseUrl = `http://localhost:${servePort}`;
    const sharedEnv = {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? tmpdir(),
      NODE_ENV: "development",
      PIRATE_RADIO_DEV_STACK: "1",
      PIRATE_RADIO_DEV_DIR: libraryDir,
    };

    const oidc = spawnLogged(processes, "oidc", ["scripts/dev/local-oidc.mjs"], {
      ...sharedEnv,
      LOCAL_OIDC_HOST: "localhost",
      LOCAL_OIDC_PORT: String(oidcPort),
      LOCAL_OIDC_CLIENT_ID: "pirate-radio-qa",
      LOCAL_OIDC_SUBJECT: "qa-reader-subject",
      LOCAL_OIDC_USERNAME: "qa.reader",
      LOCAL_OIDC_NAME: "QA Reader",
      LOCAL_OIDC_EMAIL: "qa.reader@example.com",
    });
    await waitUntil("local OIDC issuer", oidc, () => httpsOk(`${issuer}/.well-known/openid-configuration`));

    const serve = spawnLogged(processes, "serve", ["--import", join(repoRoot, "tests/qa/network-stub.mjs"), cli, "serve"], {
      ...sharedEnv,
      DATABASE_URL: databaseUrl,
      SERVICE_HOST: "127.0.0.1",
      SERVICE_PORT: String(servePort),
      PIRATE_RADIO_PUBLIC_URL: baseUrl,
      PIRATE_RADIO_OIDC_ISSUER: issuer,
      PIRATE_RADIO_OIDC_CLIENT_ID: "pirate-radio-qa",
      PIRATE_RADIO_OIDC_CLIENT_SECRET: "qa-secret",
      PIRATE_RADIO_LIBRARY_DIR: libraryDir,
      PIRATE_RADIO_FEEDS: JSON.stringify([
        { id: "qa-fixture", name: "QA Fixture", type: "substack", url: `${fixtureSite}/feed.xml` },
      ]),
      PIRATE_RADIO_POLL_INTERVAL_MS: String(24 * 60 * 60 * 1000),
      PIRATE_RADIO_ENABLE_ALIGNMENT: "false",
      PWR_HEADLESS: "true",
      XAI_API_KEY: QA_XAI_KEY,
      PIRATE_RADIO_SERVICE_TOKEN: UNSUPPORTED_SERVICE_TOKEN,
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
      PIRATE_RADIO_QA_ROUTES: JSON.stringify({ [QA_FIXTURE_ORIGIN]: fixtureSite, "https://api.x.ai": mockXai }),
    });
    await waitUntil(
      "pirate-radio serve (needs Postgres and the pirate_radio_qa database from `bash scripts/dev/start.sh`)",
      serve,
      async () => (await fetch(`http://127.0.0.1:${servePort}/health`)).ok,
    );

    return {
      baseUrl,
      libraryDir,
      xaiRequests,
      fixtureArticleUrl: (slug) => `${QA_FIXTURE_ORIGIN}/p/${slug}`,
      serveLog: serve.log,
      blockedRequests: () => serve.log().split("\n").filter((line) => line.includes("[qa-network] blocked")),
      stop,
    };
  } catch (error) {
    const logs = processes.map(({ log }) => log()).join("\n");
    await stop();
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n--- stack logs ---\n${logs}`);
  }
}

function spawnLogged(processes: LoggedProcess[], name: string, args: string[], env: NodeJS.ProcessEnv): LoggedProcess {
  const child = spawn(process.execPath, args, { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const append = (chunk: Buffer) => (output += chunk.toString("utf8").replace(/^(?=.)/gm, `[${name}] `));
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  const processHandle = { child, log: () => output, exited };
  processes.push(processHandle);
  return processHandle;
}

async function waitUntil(label: string, target: LoggedProcess, ready: () => Promise<boolean>): Promise<void> {
  let exitCode: number | null | undefined;
  void target.exited.then((code) => (exitCode = code));
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exitCode !== undefined) throw new Error(`${label} exited with code ${exitCode} before it was ready.`);
    if (await ready().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${label} was not ready after ${READY_TIMEOUT_MS}ms.`);
}

function httpsOk(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    httpsGet(url, { rejectUnauthorized: false }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    }).on("error", () => resolve(false));
  });
}

async function listen(servers: Server[], handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

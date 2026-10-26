import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Locator } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { PirateRadioConfig } from "../src/config.js";
import { appendLibraryItem } from "../src/library.js";
import { createPirateRadioRequestHandler } from "../src/server.js";
import { FakeAuthenticator, MemoryStore, adminUser } from "./support/fakes.js";

const QUIET_MS = 3_000;

function silentMp3(seconds: number): Buffer {
  // MPEG-1 Layer III, 32 kbps, 44.1 kHz, mono. Zeroed side info decodes as silence.
  const frame = Buffer.alloc(104);
  frame.set([0xff, 0xfb, 0x10, 0xc4]);
  return Buffer.concat(Array.from({ length: Math.ceil((seconds * 44_100) / 1_152) }, () => frame));
}

async function shownSeconds(time: Locator): Promise<number> {
  const [minutes, seconds] = (await time.textContent())!.split(":").map(Number);
  return minutes * 60 + seconds;
}

describe.skipIf(!existsSync(chromium.executablePath()))("shared media player in Chromium", () => {
  const store = new MemoryStore();
  let browser: Browser;
  let baseUrl: string;
  let libraryDir: string;
  let server: ReturnType<typeof createServer>;

  beforeAll(async () => {
    libraryDir = await mkdtemp(join(tmpdir(), "pirate-radio-player-"));
    for (const dir of ["audio", "stories", "alignment"]) await mkdir(join(libraryDir, dir));
    for (const [index, title] of ["Alpha", "Bravo", "Charlie"].entries()) {
      const slug = title.toLowerCase();
      const path = (dir: string, extension: string) => join(libraryDir, dir, `${slug}.${extension}`);
      await writeFile(path("audio", "mp3"), silentMp3(60));
      await writeFile(path("stories", "json"), JSON.stringify({ title, text: "Body." }));
      await writeFile(path("alignment", "json"), JSON.stringify({ words: [] }));
      await appendLibraryItem(libraryDir, {
        slug, title, sourceName: "Fixture", sourceUrl: `https://example.com/${slug}`,
        audioPath: path("audio", "mp3"), jsonPath: path("stories", "json"), textPath: path("text", "txt"),
        alignmentPath: path("alignment", "json"), alignmentUrl: `/alignment/${slug}.json`, hasAlignment: true,
        publishedAt: "", generatedAt: `2026-01-0${index + 1}T00:00:00.000Z`,
        estimatedCostUsd: 0, wordCount: 1, characterCount: 5,
      });
    }
    store.progressRows.set(`${adminUser.id}:alpha`, { positionSeconds: 20, durationSeconds: 60, updatedAt: "2026-01-04T00:00:00.000Z" });
    store.progressRows.set(`${adminUser.id}:bravo`, { positionSeconds: 42, durationSeconds: 60, updatedAt: "2026-01-04T00:00:00.000Z" });
    const config = {
      host: "127.0.0.1", publicBaseUrl: "http://127.0.0.1", libraryDir, enableAlignment: false,
    } as PirateRadioConfig;
    const handler = createPirateRadioRequestHandler({ config, store, authenticator: new FakeAuthenticator() });
    server = createServer((request, response) => void handler(request, response));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = config.publicBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser?.close();
    await new Promise((resolve) => server?.close(resolve));
    await rm(libraryDir, { recursive: true, force: true });
  });

  async function open(path: string) {
    const page = await browser.newPage();
    const requests: Array<{ method: string; path: string; body: string | null }> = [];
    const errors: Error[] = [];
    page.on("request", (request) => {
      requests.push({ method: request.method(), path: new URL(request.url()).pathname, body: request.postData() });
    });
    page.on("pageerror", (error) => errors.push(error));
    await page.goto(baseUrl + path);
    const hits = (method: string, prefix: string) =>
      requests.filter((request) => request.method === method && request.path.startsWith(prefix)).length;
    const written = () =>
      requests.filter((request) => request.method === "PUT").map((request) => [request.path, JSON.parse(request.body!).positionSeconds]);
    return { page, requests, errors, hits, written };
  }

  test("untouched cards stay off the network and one played card resumes, then saves", { timeout: 40_000 }, async () => {
    const { page, requests, errors, hits, written } = await open("/");
    const toggles = page.locator(".item .shk-btn_toggle");
    const titles = page.locator(".item h2");
    const visibleToggles = () => toggles.evaluateAll((buttons) => buttons.filter((button) => button.checkVisibility()).length);
    const traffic = () => ({
      manifest: hits("GET", "/library.json"),
      audio: hits("GET", "/audio/"),
      reads: hits("GET", "/progress/"),
      writes: hits("PUT", "/progress/"),
    });
    const untouched = { manifest: 1, audio: 0, reads: 0, writes: 0 };
    const seededRows = structuredClone([...store.progressRows]);

    await toggles.nth(2).waitFor();
    await page.waitForTimeout(QUIET_MS);
    expect(await titles.allTextContents()).toEqual(["Charlie", "Bravo", "Alpha"]);
    expect(await visibleToggles()).toBe(3);
    expect(traffic(), "untouched load").toEqual(untouched);

    await page.selectOption("#sort-order", "title-asc");
    await page.waitForTimeout(QUIET_MS);
    expect(await titles.allTextContents()).toEqual(["Alpha", "Bravo", "Charlie"]);
    expect(await visibleToggles()).toBe(3);
    expect(traffic(), "untouched sort").toEqual(untouched);
    expect([...store.progressRows]).toEqual(seededRows);

    const bravo = page.locator(".item", { hasText: "Bravo" });
    await bravo.locator(".shk-btn_toggle").click();
    await expect.poll(() => shownSeconds(bravo.locator(".shk-time_now")), { timeout: 10_000 }).toBeGreaterThanOrEqual(43);
    await bravo.locator(".shk-btn_toggle").click();
    await expect.poll(() => written().length).toBeGreaterThan(0);
    const media = requests.filter((request) => /^\/(audio|progress)\//.test(request.path));
    expect(new Set(media.map((request) => request.path)), "only the played card").toEqual(new Set(["/audio/bravo.mp3", "/progress/bravo"]));
    expect(hits("GET", "/progress/")).toBe(1);
    expect(Math.min(...written().map(([, seconds]) => seconds)), "no pre-restore write").toBeGreaterThan(42);

    const pausedWrites = written().length;
    await page.selectOption("#sort-order", "generated-desc");
    await page.waitForTimeout(QUIET_MS);
    expect(written().length, "teardown saves the played card once").toBe(pausedWrites + 1);
    expect(written().every(([path, seconds]) => path === "/progress/bravo" && seconds > 42), "no teardown zero write").toBe(true);
    expect(store.progressRows.get(`${adminUser.id}:bravo`)!.positionSeconds).toBeGreaterThan(42);
    expect(store.progressRows.get(`${adminUser.id}:alpha`)!.positionSeconds).toBe(20);
    expect(errors).toEqual([]);
  });

  test("the article page still preloads metadata, saved progress, and alignment without writing", { timeout: 20_000 }, async () => {
    const { page, errors, hits } = await open("/article/alpha");
    await page.waitForTimeout(QUIET_MS);
    expect(hits("GET", "/audio/alpha.mp3")).toBeGreaterThan(0);
    expect(hits("GET", "/progress/alpha")).toBe(1);
    expect(hits("GET", "/alignment/alpha.json")).toBe(1);
    expect(hits("PUT", "/progress/")).toBe(0);
    expect(await page.textContent("#article-player .shk-time_now")).toBe("00:20");
    expect(await page.textContent("#article-player .shk-time_duration")).not.toBe("00:00");
    expect(errors).toEqual([]);
  });
});

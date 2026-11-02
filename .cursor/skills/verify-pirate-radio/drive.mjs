#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const expectedArticles = [
  {
    slug: "return-of-the-generalist-engineer",
    title: "The Quiet Return of the Generalist Engineer",
    opening: "For a decade the industry rewarded specialization.",
  },
  {
    slug: "regulators-discover-the-data-center",
    title: "Regulators Discover the Data Center",
  },
  {
    slug: "notes-on-shipping-audio",
    title: "Notes on Shipping Software That Reads Itself Aloud",
  },
];

const step = process.argv[2] ?? "all";
const knownSteps = new Set(["all", "health", "auth", "article", "queue"]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function loadState() {
  const statePath = path.join(root, "output/qa/verify/state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const url = new URL(state.publicUrl);
  assert(url.protocol === "http:" && url.hostname === "localhost", "publicUrl must be http://localhost:<port>");
  assert(Number(url.port) === state.servicePort, "publicUrl port does not match servicePort");
  assert(state.servicePort !== 8123 && state.oidcPort !== 9443, "refusing the shared dev ports");
  assert(state.databaseName === "pirate_radio_verify", "refusing unexpected database");
  assert(String(state.libraryDir).startsWith("/tmp/pirate-radio-verify-"), "refusing unexpected library");
  assert(String(state.evidenceDir).startsWith(path.join(root, "output/qa/verify") + path.sep), "refusing unexpected evidence dir");
  return state;
}

function assertSeedMatchesMap() {
  const specs = JSON.parse(readFileSync(path.join(root, "scripts/dev/seed-assets/articles.json"), "utf8"));
  const actual = specs.map((spec) => `${spec.slug}\t${spec.title}`).join("\n");
  const expected = expectedArticles.map((spec) => `${spec.slug}\t${spec.title}`).join("\n");
  assert(actual === expected, "scripts/dev/seed-assets/articles.json no longer matches the feature map");
  const generalist = specs[0];
  assert(generalist.text.startsWith(expectedArticles[0].opening), "generalist opening sentence changed");
}

function log(evidenceDir, line) {
  appendFileSync(path.join(evidenceDir, "drive.log"), `${line}\n`);
}

function writeJson(evidenceDir, name, value) {
  writeFileSync(path.join(evidenceDir, name), `${JSON.stringify(value, null, 2)}\n`);
}

async function healthHttp(state) {
  const healthResponse = await fetch(`${state.publicUrl}/health`);
  const healthText = await healthResponse.text();
  writeFileSync(path.join(state.evidenceDir, "health.json"), healthText.endsWith("\n") ? healthText : `${healthText}\n`);
  assert(healthResponse.status === 200, `GET /health status ${healthResponse.status}`);
  assert(JSON.parse(healthText).ok === true, "GET /health body was not ok");
  const lockedResponse = await fetch(`${state.publicUrl}/library.json`);
  const locked = await lockedResponse.json();
  writeJson(state.evidenceDir, "library-locked.json", locked);
  assert(lockedResponse.status === 401, `GET /library.json status ${lockedResponse.status}`);
  assert(locked.error === "authentication_required", "anonymous library error was not authentication_required");
  log(state.evidenceDir, "health 200");
  log(state.evidenceDir, "library-locked 401");
}

async function shotSignIn(page, state) {
  const response = await page.goto(`${state.publicUrl}/`, { waitUntil: "domcontentloaded" });
  assert(response?.status() === 401, `GET / status ${response?.status()}`);
  await page.getByRole("heading", { name: "Pirate Radio" }).waitFor();
  await page.getByRole("link", { name: "Sign in" }).waitFor();
  await page.screenshot({ path: path.join(state.evidenceDir, "sign-in.png"), fullPage: true });
  log(state.evidenceDir, "sign-in page");
}

async function signIn(page, state, alreadyThere) {
  if (!alreadyThere) await shotSignIn(page, state);
  await page.getByRole("link", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.origin === new URL(state.publicUrl).origin && url.pathname === "/");
  await page.getByRole("heading", { name: expectedArticles[0].title }).waitFor();
  log(state.evidenceDir, "signed in");
}

async function authChecks(page, state) {
  const meResponse = await page.request.get(`${state.publicUrl}/auth/me`);
  const me = await meResponse.json();
  writeJson(state.evidenceDir, "auth-me.json", me);
  assert(meResponse.status() === 200, `GET /auth/me status ${meResponse.status()}`);
  assert(me.username === "demo.reader", "username was not demo.reader");
  assert(me.isAdmin === true, "demo.reader was not admin");
  assert(me.groups?.includes("pirate-radio-users") && me.groups?.includes("pirate-radio-admins"), "groups missing member or admin");
  await page.locator("#account-menu summary").waitFor();
  await page.getByRole("link", { name: "Admin" }).waitFor();
  for (const article of expectedArticles) {
    await page.getByRole("heading", { name: article.title }).waitFor();
  }
  const generalist = page.locator(".item", { has: page.getByRole("heading", { name: expectedArticles[0].title }) });
  const custom = page.locator(".item", { has: page.getByRole("heading", { name: expectedArticles[2].title }) });
  assert(await generalist.locator("img.thumb").count() === 1, "generalist card has no image");
  assert(await custom.locator(".thumb.placeholder").count() === 1, "custom-text card has no placeholder");
  await page.locator("#source-filter").selectOption({ label: "Hyperdimensional" });
  await page.getByRole("heading", { name: expectedArticles[0].title }).waitFor();
  assert(await page.getByRole("heading", { name: expectedArticles[1].title }).count() === 0, "filter kept Regulators");
  assert(await page.getByRole("heading", { name: expectedArticles[2].title }).count() === 0, "filter kept custom text");
  await page.locator("#source-filter").selectOption({ label: "All sources" });
  for (const article of expectedArticles) {
    await page.getByRole("heading", { name: article.title }).waitFor();
  }
  const libraryResponse = await page.request.get(`${state.publicUrl}/library.json`);
  const library = await libraryResponse.json();
  writeJson(state.evidenceDir, "library.json", library);
  assert(libraryResponse.status() === 200, `GET /library.json status ${libraryResponse.status()}`);
  const slugs = library.items.map((item) => item.slug).sort();
  assert(JSON.stringify(slugs) === JSON.stringify(expectedArticles.map((article) => article.slug).sort()), "library.json slugs mismatch");
  await page.screenshot({ path: path.join(state.evidenceDir, "library.png"), fullPage: true });
  log(state.evidenceDir, "auth demo.reader");
  log(state.evidenceDir, "library 3");
}

async function articleChecks(page, state) {
  const audioWait = page.waitForResponse(
    (response) => {
      try {
        return new URL(response.url()).pathname === `/audio/${expectedArticles[0].slug}.mp3`;
      } catch {
        return false;
      }
    },
    { timeout: 15000 },
  );
  await page.getByRole("link", { name: expectedArticles[0].title }).click();
  await page.waitForURL((url) => url.pathname === `/article/${expectedArticles[0].slug}`);
  const audio = await audioWait;
  assert(audio.status() === 200 || audio.status() === 206, `audio status ${audio.status()}`);
  await page.locator(".article-hero h1").waitFor();
  assert((await page.locator(".article-hero h1").innerText()) === expectedArticles[0].title, "article h1 mismatch");
  assert((await page.locator(".article-meta").first().innerText()).includes("By Mara Whitfield"), "byline missing");
  assert((await page.locator("#story-body").innerText()).includes(expectedArticles[0].opening), "opening sentence missing");
  await page.locator("#article-player .shk-btn_toggle").waitFor();
  await page.waitForFunction(() => {
    const text = document.querySelector("#article-player .shk-time_duration")?.textContent?.trim() ?? "";
    return text.length > 0 && !/^(00:)?00:00$/.test(text);
  }, null, { timeout: 15000 });
  const progressResponse = await page.request.get(`${state.publicUrl}/progress/${expectedArticles[0].slug}`);
  const progress = await progressResponse.json();
  writeJson(state.evidenceDir, "progress.json", progress);
  assert(progressResponse.status() === 200, `progress status ${progressResponse.status()}`);
  assert(progress.positionSeconds === 100 && progress.durationSeconds === 100, "seeded progress mismatch");
  assert(typeof progress.completedAt === "string" && progress.completedAt.length > 0, "completedAt missing");
  const emptyResponse = await page.request.get(`${state.publicUrl}/progress/${expectedArticles[2].slug}`);
  const empty = await emptyResponse.json();
  assert(emptyResponse.status() === 404, `empty progress status ${emptyResponse.status()}`);
  assert(empty.error === "progress_not_found", "empty progress error mismatch");
  await page.screenshot({ path: path.join(state.evidenceDir, "article.png"), fullPage: true });
  log(state.evidenceDir, `article audio ${audio.status()}`);
  log(state.evidenceDir, "progress 100");
}

async function queueChecks(page, state) {
  await page.getByRole("link", { name: "Queue" }).click();
  await page.waitForURL((url) => url.pathname === "/queue");
  await page.locator("#article-url").waitFor();
  assert((await page.locator("#queue-url").innerText()) === "Convert URL", "Convert URL label mismatch");
  await page.locator("#custom-title").waitFor();
  await page.locator("#queue-text").waitFor();
  const micron = page.locator(".queue-row", { hasText: "Inside Micron's Attempts" });
  await micron.waitFor();
  assert(await micron.getByRole("button", { name: "Convert", exact: true }).count() === 1, "Micron row has no Convert button");
  assert(await page.getByText("Monday: Three Morning Takes").count() === 0, "filtered morning-takes row is visible");
  const submissions = page.locator("#submissions");
  await submissions.getByRole("heading", { name: expectedArticles[0].title }).waitFor();
  const submissionText = await submissions.innerText();
  assert(submissionText.includes("succeeded"), "seeded submission is not succeeded");
  assert(submissionText.includes("demo.reader"), "seeded submission is missing demo.reader");
  await page.screenshot({ path: path.join(state.evidenceDir, "queue.png"), fullPage: true });
  log(state.evidenceDir, "queue micron visible");
  log(state.evidenceDir, "queue convert not clicked");
}

async function withPage(state, fn) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    await fn(page);
  } finally {
    await browser.close();
  }
}

async function main() {
  assert(knownSteps.has(step), "usage: node .cursor/skills/verify-pirate-radio/drive.mjs all|health|auth|article|queue");
  const state = loadState();
  assertSeedMatchesMap();
  mkdirSync(state.evidenceDir, { recursive: true });
  if (step === "health" || step === "all") await healthHttp(state);
  if (step === "health") {
    await withPage(state, async (page) => {
      await shotSignIn(page, state);
    });
    return;
  }
  await withPage(state, async (page) => {
    await signIn(page, state, false);
    if (step === "all" || step === "auth") await authChecks(page, state);
    if (step === "all" || step === "article") await articleChecks(page, state);
    if (step === "all" || step === "queue") await queueChecks(page, state);
  });
}

main()
  .then(() => {
    const state = loadState();
    log(state.evidenceDir, `ok ${step}`);
  })
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    try {
      const state = loadState();
      mkdirSync(state.evidenceDir, { recursive: true });
      log(state.evidenceDir, `fail ${step} ${message}`);
    } catch {
      console.error(message);
    }
    console.error(message);
    process.exitCode = 1;
  });

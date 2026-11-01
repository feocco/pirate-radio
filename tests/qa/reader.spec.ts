import { expect, test } from "@playwright/test";
import { QA_XAI_KEY, startQaStack, UNSUPPORTED_SERVICE_TOKEN, type QaStack } from "./stack.js";

const TITLE = "Harbor Lights After Midnight";
const FIRST_PARAGRAPH = "The harbor lights flickered twice before the night shift began its slow walk along the pier.";
const LAST_PARAGRAPH = "By dawn the fog had lifted and the last ferry slipped quietly into its berth.";
const PROCESSING_TIMEOUT_MS = 60_000;

interface SubmissionRow {
  slug?: string;
  status: string;
  sourceUrl?: string;
  error?: string;
}

let stack: QaStack;

test.beforeAll(async () => {
  stack = await startQaStack();
});

test.afterAll(async () => {
  await stack?.stop();
});

test("a submitted fixture URL is processed and the reader renders title, text, and the shared player", async ({ page }) => {
  const slug = `harbor-lights-${Date.now().toString(36)}`;
  const articleUrl = stack.fixtureArticleUrl(slug);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto(`${stack.baseUrl}/auth/login?returnTo=/queue`);
  await expect(page).toHaveURL(`${stack.baseUrl}/queue`);

  await page.fill("#article-url", articleUrl);
  await page.click("#queue-url");
  await expect(page.locator("#url-status")).toHaveText(/^Queued\./);

  let submission: SubmissionRow | undefined;
  await expect
    .poll(
      async () => {
        const response = await page.request.get(`${stack.baseUrl}/submissions.json`);
        const { items } = (await response.json()) as { items: SubmissionRow[] };
        submission = items.find((item) => item.sourceUrl === articleUrl);
        return submission?.status;
      },
      { timeout: PROCESSING_TIMEOUT_MS, message: "submission reaches a terminal status" },
    )
    .toMatch(/^(succeeded|failed)$/);
  expect(submission, `submission error: ${submission?.error}\n${stack.serveLog()}`).toMatchObject({ status: "succeeded", slug });

  await page.goto(`${stack.baseUrl}/`);
  const card = page.locator(".item", { hasText: TITLE });
  await expect(card.locator(".shk-btn_toggle")).toBeVisible();

  const audioResponse = page.waitForResponse((response) => new URL(response.url()).pathname === `/audio/${slug}.mp3`);
  await card.locator(`a.readlink[href="/article/${slug}"]`).click();
  await expect(page).toHaveURL(`${stack.baseUrl}/article/${slug}`);

  await expect(page.locator(".article-hero h1")).toHaveText(TITLE);
  const body = page.locator("#story-body");
  await expect(body).toContainText(FIRST_PARAGRAPH);
  await expect(body).toContainText(LAST_PARAGRAPH);
  await expect(body).not.toContainText("reader comment");
  await expect(body).not.toContainText("Subscribe");

  const player = page.locator("#article-player");
  await expect(player.locator(".shk-btn_toggle")).toBeVisible();
  await expect(player.locator(".shk-time_duration")).not.toHaveText(/^(00:)?00:00$/);
  expect([200, 206]).toContain((await audioResponse).status());

  expect(stack.xaiRequests.length).toBeGreaterThan(0);
  expect(stack.xaiRequests.every((request) => request.authorization === `Bearer ${QA_XAI_KEY}`)).toBe(true);
  const spokenText = stack.xaiRequests.map((request) => request.text).join("\n");
  expect(spokenText).toContain(TITLE);
  expect(spokenText).toContain(FIRST_PARAGRAPH);
  expect(stack.blockedRequests()).toEqual([]);
  expect(pageErrors).toEqual([]);

  const duration = await player.locator(".shk-time_duration").textContent();
  console.log(
    `[qa] PASS slug=${slug} submission=${submission?.status} title="${TITLE}" ` +
      `player.duration=${duration} audio=${(await audioResponse).status()} ` +
      `mockXaiRequests=${stack.xaiRequests.length} blockedExternal=${stack.blockedRequests().length}`,
  );
});

test("bots authenticate only with an OIDC browser-session cookie, never a bearer or service token", async ({ page, playwright }) => {
  await page.goto(`${stack.baseUrl}/auth/login?returnTo=/`);
  const session = (await page.context().cookies()).find((cookie) => cookie.name === "pirate_radio_session");
  expect(session).toMatchObject({ httpOnly: true, secure: true });

  const bot = await playwright.request.newContext({ baseURL: stack.baseUrl, maxRedirects: 0 });
  try {
    expect((await bot.get("/health")).status()).toBe(200);
    const botCredentials: Record<string, string>[] = [
      {},
      { authorization: `Bearer ${UNSUPPORTED_SERVICE_TOKEN}` },
      { "x-api-key": UNSUPPORTED_SERVICE_TOKEN },
    ];
    for (const headers of botCredentials) {
      const rejected = await bot.get("/library.json", { headers });
      expect(rejected.status(), JSON.stringify(headers)).toBe(401);
      expect(await rejected.json()).toMatchObject({ error: "authentication_required" });
    }

    const cookie = { cookie: `pirate_radio_session=${session!.value}` };
    const me = await bot.get("/auth/me", { headers: cookie });
    expect(me.status()).toBe(200);
    expect(await me.json()).toMatchObject({ username: "qa.reader" });
    expect((await bot.get("/library.json", { headers: cookie })).status()).toBe(200);

    const noOrigin = await bot.post("/auth/logout", { headers: cookie });
    expect(noOrigin.status()).toBe(403);
    expect(await noOrigin.json()).toMatchObject({ error: "invalid_origin" });
    expect((await bot.post("/auth/logout", { headers: { ...cookie, origin: stack.baseUrl } })).status()).toBe(303);
    expect((await bot.get("/auth/me", { headers: cookie })).status()).toBe(401);
  } finally {
    await bot.dispose();
  }
  console.log("[qa] PASS bot-auth: bearer/x-api-key/PIRATE_RADIO_SERVICE_TOKEN rejected (401); session cookie accepted; writes need Origin (403 without); logout revokes");
});

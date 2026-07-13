import { chromium } from "playwright";
import { validateArticleUrl } from "./backlog.js";
import { extractStoryFromHtml } from "./extractor.js";
import type { Story } from "./types.js";

export const PROFILE_DIR = ".playwright-profile";
const LOGGED_IN_TEXT = "My Account";

export class PirateWiresAuthRequiredError extends Error {
  constructor(profileDir: string) {
    super(`Pirate Wires login required for ${profileDir}`);
    this.name = "PirateWiresAuthRequiredError";
  }
}

export async function openLoginBrowser(): Promise<void> {
  const profileDir = profileDirFromEnv();
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
  });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto("https://www.piratewires.com/", { waitUntil: "domcontentloaded" });
  console.log("Browser opened. Complete Pirate Wires login, then press Enter here.");
  await waitForEnter();
  await context.close();
  console.log(`Login session saved in ${profileDir}.`);
}

export async function extractStoryFromUrl(url: string): Promise<Story> {
  const validation = await validateArticleUrl(url);
  if (!validation.ok) {
    throw new Error(validation.error);
  }
  if (validation.sourceType === "substack") {
    return extractPublicStoryFromUrl(validation.url);
  }

  const context = await chromium.launchPersistentContext(profileDirFromEnv(), {
    headless: process.env.PWR_HEADLESS === "true",
  });
  const page = context.pages()[0] ?? (await context.newPage());
  const articleUrl = validation.url;

  try {
    await page.goto(articleUrl, { waitUntil: "networkidle", timeout: 60_000 });
    const html = await page.content();
    const story = extractStoryFromHtml(html, articleUrl);
    const pageText = await page.locator("body").textContent();
    validatePirateWiresAccess({
      pageText: pageText ?? "",
      articleWordCount: story.wordCount,
      profileDir: profileDirFromEnv(),
    });
    return story;
  } finally {
    await context.close();
  }
}

async function extractPublicStoryFromUrl(url: string): Promise<Story> {
  const response = await fetch(url, {
    headers: {
      accept: "text/html,application/xhtml+xml",
      "user-agent": "pirate-radio/0.1",
    },
  });
  if (!response.ok) {
    throw new Error(`Could not load article: ${response.status} ${response.statusText}`);
  }
  return extractStoryFromHtml(await response.text(), url);
}

export function canonicalPirateWiresUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.hostname === "piratewires.substack.com") {
    parsed.hostname = "www.piratewires.com";
  }
  return parsed.toString();
}

export function profileDirFromEnv(
  env: Partial<Pick<NodeJS.ProcessEnv, "PWR_PROFILE_DIR">> = process.env,
): string {
  return env.PWR_PROFILE_DIR || PROFILE_DIR;
}

export function validatePirateWiresAccess(input: {
  pageText: string;
  articleWordCount: number;
  profileDir: string;
}): void {
  if (!input.pageText.includes(LOGGED_IN_TEXT)) {
    throw new PirateWiresAuthRequiredError(input.profileDir);
  }
  if (input.articleWordCount === 0) {
    throw new Error("Pirate Wires article loaded without readable story text.");
  }
}

async function waitForEnter(): Promise<void> {
  process.stdin.resume();
  await new Promise<void>((resolve) => {
    process.stdin.once("data", () => resolve());
  });
  process.stdin.pause();
}

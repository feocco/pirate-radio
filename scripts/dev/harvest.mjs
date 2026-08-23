// Harvest REAL articles from the configured RSS feeds into committed seed
// fixtures (DEV/CLOUD ONLY). Run this once in an environment that can reach the
// feeds; it downloads real hero images and generates real xAI TTS, then
// writes scripts/dev/seed-assets/ so the runtime seed stays cost-free.
//
// It reuses the app's own extractor/TTS/image code. Full body text is captured
// for public sources (e.g. Hyperdimensional). Paywalled sources (Pirate Wires)
// fall back to the RSS summary unless a logged-in Playwright profile is wired.
//
// Requires: XAI_API_KEY, feed egress, and PIRATE_RADIO_DEV_STACK=1.
// Config: PIRATE_RADIO_FEEDS (or defaults), HARVEST_PER_FEED (default 1),
//         HARVEST_MAX_CHARS (default 2600), HARVEST_ASSETS_DIR (default
//         scripts/dev/seed-assets), HARVEST_KEEP_CUSTOM_TEXT (default 1).
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.PIRATE_RADIO_DEV_STACK !== "1" || process.env.NODE_ENV === "production") {
  console.error("[harvest] refusing to run: dev-only tool. Set PIRATE_RADIO_DEV_STACK=1 and ensure NODE_ENV!=production.");
  process.exit(1);
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = (p) => join(repoRoot, "dist", "src", p);
const assetsDir = process.env.HARVEST_ASSETS_DIR ?? join(repoRoot, "scripts", "dev", "seed-assets");
const PER_FEED = Number(process.env.HARVEST_PER_FEED ?? 1);
const MAX_CHARS = Number(process.env.HARVEST_MAX_CHARS ?? 2600);
const KEEP_CUSTOM = process.env.HARVEST_KEEP_CUSTOM_TEXT !== "0";

const { configFromEnv } = await import(dist("config.js"));
const { fetchArticleFeeds } = await import(dist("feed.js"));
const { extractStoryFromHtml } = await import(dist("extractor.js"));
const { cacheStoryImage } = await import(dist("assets.js"));
const { createTtsProvider } = await import(dist("tts/index.js"));
const { storySlug } = await import(dist("output.js"));

const config = configFromEnv();
if (!process.env.XAI_API_KEY) {
  console.error("[harvest] XAI_API_KEY is required to synthesize audio.");
  process.exit(1);
}
const provider = createTtsProvider();

function truncate(text) {
  if (text.length <= MAX_CHARS) return text;
  const cut = text.slice(0, MAX_CHARS);
  const at = cut.lastIndexOf("\n\n");
  return (at > 600 ? cut.slice(0, at) : cut).trim();
}

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { accept: "text/html,application/xhtml+xml", "user-agent": "pirate-radio/0.1" } });
  if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
  return res.text();
}

async function harvestItem(article, index) {
  let story;
  try {
    story = extractStoryFromHtml(await fetchHtml(article.url), article.url);
  } catch (error) {
    console.warn(`[harvest] page extract failed for ${article.url}: ${error.message}; using RSS summary`);
    const text = (article.description || article.title).trim();
    story = { sourceUrl: article.url, title: article.title, author: article.author, text, contentBlocks: [{ type: "paragraph", text }], wordCount: text.split(/\s+/).filter(Boolean).length, characterCount: text.length };
  }
  const slug = storySlug({ sourceUrl: story.sourceUrl, title: story.title });
  const text = truncate(story.text.trim());

  let imageFile = null;
  const heroUrl = story.heroImageOriginalUrl;
  if (heroUrl) {
    try {
      const cached = await cacheStoryImage({ libraryDir: assetsDir, slug, imageUrl: heroUrl });
      if (cached) imageFile = basename(cached.imagePath);
    } catch (error) {
      console.warn(`[harvest] image download failed for ${slug}: ${error.message}`);
    }
  }

  const audioFile = `${slug}.mp3`;
  await mkdir(join(assetsDir, "audio"), { recursive: true });
  await provider.synthesize({ title: story.title, text, outputPath: join(assetsDir, "audio", audioFile), allowOverBudget: false });

  return {
    slug,
    title: story.title,
    author: (story.author && story.author.trim()) || (article.author && article.author.trim()) || null,
    sourceName: article.sourceName ?? "Feed",
    sourceType: article.sourceType ?? "substack",
    url: story.sourceUrl,
    tagline: (story.tagline && story.tagline.trim()) || (article.description && article.description.trim()) || null,
    publishedOffsetDays: index * 2,
    audio: audioFile,
    image: imageFile,
    progress: index === 0 ? { positionSeconds: 100, durationSeconds: 100, ended: true }
      : index === 1 ? { positionSeconds: 42, durationSeconds: 210, ended: false } : null,
    text,
  };
}

async function main() {
  await mkdir(join(assetsDir, "audio"), { recursive: true });
  await mkdir(join(assetsDir, "images"), { recursive: true });

  const articles = await fetchArticleFeeds(config.feeds);
  const bySource = new Map();
  for (const article of articles) {
    const key = article.sourceName ?? article.sourceType ?? "feed";
    const list = bySource.get(key) ?? [];
    if (list.length < PER_FEED) {
      list.push(article);
      bySource.set(key, list);
    }
  }
  const chosen = [...bySource.values()].flat();
  console.log(`[harvest] selected ${chosen.length} real article(s) from ${bySource.size} feed source(s)`);

  const entries = [];
  let index = 0;
  for (const article of chosen) {
    try {
      const entry = await harvestItem(article, index);
      entries.push(entry);
      console.log(`[harvest] wrote fixture: ${entry.slug} ("${entry.title}")${entry.image ? " [+image]" : " [no image]"}`);
      index += 1;
    } catch (error) {
      console.error(`[harvest] failed for ${article.url}: ${error.message}`);
    }
  }

  if (KEEP_CUSTOM) {
    try {
      const existing = JSON.parse(await readFile(join(assetsDir, "articles.json"), "utf8"));
      for (const spec of existing) {
        if (spec.sourceType === "custom-text" && !entries.some((e) => e.slug === spec.slug)) entries.push(spec);
      }
    } catch { /* no existing articles.json */ }
  }

  await writeFile(join(assetsDir, "articles.json"), `${JSON.stringify(entries, null, 2)}\n`, "utf8");
  console.log(`[harvest] done. ${entries.length} entries written to ${join(assetsDir, "articles.json")}`);
}

await main();

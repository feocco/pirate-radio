// Seed realistic development data for Pirate Radio (DEV/CLOUD ONLY).
//
// Default mode is "fixtures": it copies the pre-generated MP3s and hero images
// under scripts/dev/seed-assets/ into the reader library and records matching
// Postgres rows (member/admin user, submission history, playback progress).
// This means NO OpenAI TTS runs at agent runtime — audio is baked into the repo
// and reused, so there is no per-run TTS cost and no team secret is required.
//
// Optional dynamic mode (PIRATE_RADIO_SEED_DYNAMIC=1) pulls recent public
// Substack-type articles via real extraction + OpenAI TTS. It incurs cost and
// needs OPENAI_API_KEY plus feed egress, so it is off by default.
//
// GUARDRAIL: refuses to run unless PIRATE_RADIO_DEV_STACK=1 and NODE_ENV is not
// "production", so it can never seed a real deployment.
//
// Run from the repo root after `npm run build`:  node scripts/dev/seed.mjs
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.PIRATE_RADIO_DEV_STACK !== "1" || process.env.NODE_ENV === "production") {
  console.error("[seed] refusing to run: dev-only tool. Set PIRATE_RADIO_DEV_STACK=1 and ensure NODE_ENV!=production (see scripts/dev/env.sh).");
  process.exit(1);
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = (p) => join(repoRoot, "dist", "src", p);
const assetsDir = join(repoRoot, "scripts", "dev", "seed-assets");

const { PirateRadioDatabase } = await import(dist("database.js"));
const { configFromEnv } = await import(dist("config.js"));
const { appendLibraryItem, readLibraryManifest } = await import(dist("library.js"));

const config = configFromEnv();
const ISSUER = config.oidcIssuer ?? "https://127.0.0.1:9443";
const DYNAMIC = process.env.PIRATE_RADIO_SEED_DYNAMIC === "1";

function storyFromSpec(spec, generatedAt) {
  const paragraphs = spec.text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  return {
    sourceUrl: spec.url,
    title: spec.title,
    author: spec.author ?? undefined,
    tagline: spec.tagline ?? undefined,
    contentBlocks: paragraphs.map((t) => ({ type: "paragraph", text: t })),
    text: spec.text,
    wordCount: spec.text.split(/\s+/).filter(Boolean).length,
    characterCount: spec.text.length,
    extractedAt: generatedAt,
  };
}

async function seedFromFixtures(database, user) {
  const specs = JSON.parse(await readFile(join(assetsDir, "articles.json"), "utf8"));
  const manifest = await readLibraryManifest(config.libraryDir);
  const existing = new Set(manifest.items.map((i) => i.slug));
  const audioDir = join(config.libraryDir, "audio");
  const imageDir = join(config.libraryDir, "images");
  const textDir = join(config.libraryDir, "text");
  const storyDir = join(config.libraryDir, "stories");
  for (const dir of [audioDir, imageDir, textDir, storyDir]) await mkdir(dir, { recursive: true });

  const seeded = [];
  for (const spec of specs) {
    if (existing.has(spec.slug)) {
      console.log(`[seed] skip existing: ${spec.slug}`);
      seeded.push(spec);
      continue;
    }
    const generatedAt = new Date(Date.now() - (spec.publishedOffsetDays ?? 0) * 3_600_000).toISOString();
    const publishedAt = new Date(Date.now() - (spec.publishedOffsetDays ?? 0) * 86_400_000).toUTCString();
    const story = storyFromSpec(spec, generatedAt);

    const audioSrc = join(assetsDir, "audio", spec.audio);
    try {
      await stat(audioSrc);
    } catch {
      console.warn(`[seed] missing committed audio for ${spec.slug} (${spec.audio}); skipping. ` +
        `Regenerate with PIRATE_RADIO_SEED_DYNAMIC=1 or add the file.`);
      continue;
    }
    const audioPath = join(audioDir, `${spec.slug}.mp3`);
    await copyFile(audioSrc, audioPath);

    let imagePath;
    let imageUrl;
    if (spec.image) {
      const ext = extname(spec.image) || ".jpg";
      imagePath = join(imageDir, `${spec.slug}${ext}`);
      await copyFile(join(assetsDir, "images", spec.image), imagePath);
      imageUrl = `/images/${spec.slug}${ext}`;
      story.heroImagePath = imagePath;
      story.heroImageUrl = imageUrl;
    }

    const textPath = join(textDir, `${spec.slug}.txt`);
    const jsonPath = join(storyDir, `${spec.slug}.json`);
    await writeFile(textPath, `${story.title}\n\n${story.text}\n`, "utf8");
    await writeFile(jsonPath, `${JSON.stringify(story, null, 2)}\n`, "utf8");

    const submissionType = spec.sourceType === "custom-text" ? "custom_text" : "feed";
    const submission = await database.createSubmission({
      slug: spec.slug,
      type: submissionType,
      title: story.title,
      sourceUrl: story.sourceUrl,
      submittedBy: user,
    });
    await database.updateSubmission(submission.id, "processing");

    await appendLibraryItem(config.libraryDir, {
      slug: spec.slug,
      title: story.title,
      author: story.author,
      sourceUrl: story.sourceUrl,
      sourceType: spec.sourceType,
      sourceName: spec.sourceName,
      canonicalUrl: spec.url,
      publishedAt,
      generatedAt,
      audioPath,
      jsonPath,
      textPath,
      imagePath,
      imageUrl,
      tagline: story.tagline,
      estimatedCostUsd: 0,
      wordCount: story.wordCount,
      characterCount: story.characterCount,
    });
    await database.updateSubmission(submission.id, "succeeded", { slug: spec.slug });
    console.log(`[seed] created: ${spec.slug} ("${story.title}")${imageUrl ? " [+image]" : ""}`);
    seeded.push(spec);
  }

  for (const spec of seeded) {
    if (spec.progress) {
      await database.saveProgress(user.id, spec.slug, spec.progress.positionSeconds, spec.progress.durationSeconds, spec.progress.ended ?? false);
    }
  }
  return seeded.length;
}

async function seedDynamic(database, user) {
  // Opt-in: pull recent live articles and synthesize with OpenAI TTS (costs money).
  if (!process.env.OPENAI_API_KEY) {
    console.warn("[seed] dynamic mode needs OPENAI_API_KEY; falling back to fixtures.");
    return seedFromFixtures(database, user);
  }
  const { createTtsProvider } = await import(dist("tts/index.js"));
  const { handleArticleDecision, providerSynthesizer, createInitialState } = await import(dist("workflow.js"));
  const { storySlug } = await import(dist("output.js"));
  const { readLibraryManifest } = await import(dist("library.js"));
  const { fetchArticleFeeds } = await import(dist("feed.js"));
  const { extractStoryFromUrl } = await import(dist("browser.js"));

  const count = Number(process.env.PIRATE_RADIO_SEED_COUNT ?? 3);
  const manifest = await readLibraryManifest(config.libraryDir);
  const existing = new Set(manifest.items.map((i) => i.slug));
  const synthesize = providerSynthesizer(createTtsProvider("openai"));
  const substackFeeds = config.feeds.filter((f) => f.type === "substack");
  const articles = await fetchArticleFeeds(substackFeeds);
  let created = 0;
  for (const article of articles.slice(0, count)) {
    try {
      const story = await extractStoryFromUrl(article.url);
      const slug = storySlug(story);
      if (existing.has(slug)) continue;
      const state = createInitialState();
      state.pending[slug] = { ...article, slug, sourceType: article.sourceType ?? "substack", sourceName: article.sourceName ?? "Substack" };
      const submission = await database.createSubmission({ slug, type: "feed", title: story.title, sourceUrl: story.sourceUrl, submittedBy: user });
      await database.updateSubmission(submission.id, "processing");
      const result = await handleArticleDecision({ decision: "accept", slug, state, libraryDir: config.libraryDir, readArticle: async () => story, synthesize, enableAlignment: false });
      await database.updateSubmission(submission.id, "succeeded", { slug: result.libraryItem?.slug ?? slug });
      console.log(`[seed] dynamic created: ${slug}`);
      created += 1;
    } catch (error) {
      console.warn(`[seed] dynamic item failed (${article.url}): ${error.message}`);
    }
  }
  if (created === 0) {
    console.warn("[seed] dynamic produced nothing; falling back to fixtures.");
    return seedFromFixtures(database, user);
  }
  return created;
}

async function main() {
  if (!config.databaseUrl) {
    console.error("[seed] DATABASE_URL is required");
    process.exit(1);
  }
  const database = new PirateRadioDatabase(config.databaseUrl);
  try {
    await database.migrate();
    const user = await database.upsertUser({
      issuer: ISSUER,
      subject: process.env.LOCAL_OIDC_SUBJECT ?? "demo-reader-subject",
      username: process.env.LOCAL_OIDC_USERNAME ?? "demo.reader",
      displayName: process.env.LOCAL_OIDC_NAME ?? "Demo Reader",
      email: process.env.LOCAL_OIDC_EMAIL ?? "demo.reader@example.com",
      groups: [config.memberGroup, config.adminGroup],
    });
    console.log(`[seed] demo user ${user.username} (${user.id})`);
    const count = DYNAMIC ? await seedDynamic(database, user) : await seedFromFixtures(database, user);
    console.log(`[seed] done. library items seeded/verified: ${count} (mode: ${DYNAMIC ? "dynamic" : "fixtures"})`);
  } finally {
    await database.close();
  }
}

await main();

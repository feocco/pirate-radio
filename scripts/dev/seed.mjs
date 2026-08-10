// Seed realistic development data for Pirate Radio.
//
// Populates Postgres (a member/admin app user, submission history, playback
// progress) and the reader library (story JSON/text/audio + index.json) so the
// app can be tested with data instead of an empty state.
//
// Audio is generated with real OpenAI TTS when OPENAI_API_KEY is present. When
// public feeds are reachable (egress allowlist), recent articles are pulled
// dynamically; otherwise bundled sample articles are used. Idempotent: items
// already present in the library manifest are skipped.
//
// Run from the repo root after `npm run build`:  node scripts/dev/seed.mjs
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = (p) => join(repoRoot, "dist", "src", p);

const { PirateRadioDatabase } = await import(dist("database.js"));
const { configFromEnv } = await import(dist("config.js"));
const { createTtsProvider } = await import(dist("tts/index.js"));
const { handleArticleDecision, providerSynthesizer, createInitialState } = await import(dist("workflow.js"));
const { storySlug } = await import(dist("output.js"));
const { readLibraryManifest } = await import(dist("library.js"));
const { fetchArticleFeeds } = await import(dist("feed.js"));
const { extractStoryFromUrl } = await import(dist("browser.js"));

const config = configFromEnv();
const MAX_CHARS = Number(process.env.PIRATE_RADIO_SEED_MAX_CHARS ?? 1600);
const COUNT = Number(process.env.PIRATE_RADIO_SEED_COUNT ?? 3);
const ISSUER = config.oidcIssuer ?? "https://127.0.0.1:9443";

const SAMPLE_ARTICLES = [
  {
    title: "The Quiet Return of the Generalist Engineer",
    author: "Mara Whitfield",
    sourceName: "Hyperdimensional",
    sourceType: "substack",
    url: "https://www.hyperdimensional.co/p/return-of-the-generalist-engineer",
    tagline: "Why breadth is beating depth again",
    text: `For a decade the industry rewarded specialization. Teams hired for one framework, one cloud, one narrow slice of the stack, and careers were built on going ever deeper into a single tool.

That tide is turning. As models absorb the rote parts of every specialty, the scarce skill is judgment across boundaries: knowing when a caching layer is the wrong answer, when a migration can wait, and when a small script beats a new service.

The best engineers I know right now are aggressively normal. They read the whole system before touching a line. They keep a running model of failure modes in their head. They treat the deploy pipeline as part of the product, not an afterthought.

None of this is nostalgia for a simpler time. It is a bet that the leverage has moved. When execution gets cheap, taste and context get expensive, and the generalist is the person who can supply both.`,
  },
  {
    title: "Regulators Discover the Data Center",
    author: "Ryan Hassan",
    sourceName: "Pirate Wires",
    sourceType: "pirate-wires",
    url: "https://www.piratewires.com/p/regulators-discover-the-data-center",
    tagline: "A late arrival to a decade-old party",
    text: `The hearings started, as they always do, with a prop. A senator held up a hard drive and asked what a gigawatt was. Nobody in the room could answer without a staffer.

Behind the theater there is a real fight. The buildout of compute has outrun the grid, and the people who approve transmission lines are not the people who approve chips. Two bureaucracies that never had to speak are now negotiating the future of the economy through each other.

What is striking is how quickly the framing shifted from innovation to infrastructure. A year ago the story was models. Now it is substations, water rights, and interconnection queues that stretch past the end of the decade.

The companies that win the next phase will not be the ones with the cleverest architecture. They will be the ones who learned to file paperwork.`,
  },
  {
    title: "Notes on Shipping Software That Reads Itself Aloud",
    author: null,
    sourceName: "Custom Text",
    sourceType: "custom-text",
    url: "custom-text://local/notes-on-shipping-audio",
    tagline: null,
    text: `Turning articles into audio sounds simple until you try it. The text is never clean. Bylines hide in three different places. Section headings masquerade as paragraphs. A single stray pull-quote can double the runtime of a narration.

The trick is to be ruthless about what counts as the story. Title and body, nothing else. Everything cosmetic is noise that a listener cannot see and does not want to hear.

Once the text is honest, the rest is plumbing: chunk it under the model limit, stream the audio to disk, and record just enough metadata to rebuild the library without ever loading a media file into memory.`,
  },
];

function truncate(text) {
  if (text.length <= MAX_CHARS) return text;
  const cut = text.slice(0, MAX_CHARS);
  const lastBreak = cut.lastIndexOf("\n\n");
  return (lastBreak > 400 ? cut.slice(0, lastBreak) : cut).trim();
}

function specToStoryAndArticle(spec, publishedAt) {
  const text = truncate(spec.text.trim());
  const slug = storySlug({ sourceUrl: spec.url, title: spec.title });
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const story = {
    sourceUrl: spec.url,
    title: spec.title,
    author: spec.author ?? undefined,
    tagline: spec.tagline ?? undefined,
    contentBlocks: paragraphs.map((t) => ({ type: "paragraph", text: t })),
    text,
    wordCount: text.split(/\s+/).filter(Boolean).length,
    characterCount: text.length,
    extractedAt: new Date().toISOString(),
  };
  const article = {
    id: spec.url,
    title: spec.title,
    url: spec.url,
    author: spec.author ?? "",
    publishedAt,
    description: spec.tagline ?? "",
    sourceId: spec.sourceType,
    slug,
    sourceType: spec.sourceType,
    sourceName: spec.sourceName,
    canonicalUrl: spec.url,
  };
  return { slug, story, article };
}

async function dynamicSpecs() {
  // Pull recent public (Substack-type) articles when the feeds are reachable.
  const out = [];
  try {
    const substackFeeds = config.feeds.filter((f) => f.type === "substack");
    if (substackFeeds.length === 0) return out;
    const articles = await fetchArticleFeeds(substackFeeds);
    for (const article of articles.slice(0, COUNT)) {
      try {
        const story = await extractStoryFromUrl(article.url);
        out.push({
          title: story.title,
          author: story.author ?? article.author ?? null,
          sourceName: article.sourceName ?? "Substack",
          sourceType: "substack",
          url: story.sourceUrl ?? article.url,
          tagline: story.tagline ?? article.description ?? null,
          text: story.text,
        });
      } catch (error) {
        console.warn(`[seed] dynamic extract failed for ${article.url}: ${error.message}`);
      }
    }
  } catch (error) {
    console.warn(`[seed] dynamic feed pull unavailable: ${error.message}`);
  }
  return out;
}

async function main() {
  if (!config.databaseUrl) {
    console.error("[seed] DATABASE_URL is required");
    process.exit(1);
  }
  const hasKey = Boolean(process.env.OPENAI_API_KEY);
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

    if (!hasKey) {
      console.warn("[seed] OPENAI_API_KEY not set — created the demo user but skipping audio library seed.");
      return;
    }

    let specs = await dynamicSpecs();
    if (specs.length > 0) console.log(`[seed] pulled ${specs.length} live article(s) from feeds`);
    for (const sample of SAMPLE_ARTICLES) {
      if (specs.length >= COUNT) break;
      if (!specs.some((s) => storySlug({ sourceUrl: s.url, title: s.title }) === storySlug({ sourceUrl: sample.url, title: sample.title }))) {
        specs.push(sample);
      }
    }
    specs = specs.slice(0, COUNT);

    const synthesize = providerSynthesizer(createTtsProvider("openai"));
    const manifest = await readLibraryManifest(config.libraryDir);
    const existing = new Set(manifest.items.map((i) => i.slug));
    const seededSlugs = [];

    let dayOffset = 0;
    for (const spec of specs) {
      const publishedAt = new Date(Date.now() - dayOffset * 86_400_000).toUTCString();
      dayOffset += 2;
      const { slug, story, article } = specToStoryAndArticle(spec, publishedAt);
      if (existing.has(slug)) {
        console.log(`[seed] skip existing: ${slug}`);
        seededSlugs.push(slug);
        continue;
      }
      const submissionType = spec.sourceType === "custom-text" ? "custom_text" : "feed";
      const submission = await database.createSubmission({
        slug,
        type: submissionType,
        title: story.title,
        sourceUrl: story.sourceUrl,
        submittedBy: user,
      });
      await database.updateSubmission(submission.id, "processing");
      try {
        const state = createInitialState();
        state.pending[slug] = article;
        const result = await handleArticleDecision({
          decision: "accept",
          slug,
          state,
          libraryDir: config.libraryDir,
          readArticle: async () => story,
          synthesize,
          enableAlignment: false,
        });
        await database.updateSubmission(submission.id, "succeeded", { slug: result.libraryItem?.slug ?? slug });
        console.log(`[seed] created: ${slug} ("${story.title}")`);
        seededSlugs.push(slug);
      } catch (error) {
        await database.updateSubmission(submission.id, "failed", { error: error.message });
        console.error(`[seed] failed: ${slug}: ${error.message}`);
      }
    }

    // Realistic playback progress: first item completed, second partway.
    if (seededSlugs[0]) await database.saveProgress(user.id, seededSlugs[0], 100, 100, true);
    if (seededSlugs[1]) await database.saveProgress(user.id, seededSlugs[1], 42, 210);

    console.log(`[seed] done. library items: ${seededSlugs.length}`);
  } finally {
    await database.close();
  }
}

await main();

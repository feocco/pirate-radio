import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { writeAlignment } from "./alignment.js";
import { cacheStoryImage } from "./assets.js";
import type { PirateArticle } from "./feed.js";
import { appendLibraryItem, type LibraryItem } from "./library.js";
import { readLibraryManifest } from "./library.js";
import { storySlug } from "./output.js";
import { sanitizeSlug } from "./slug.js";
import { createInitialState, type PirateRadioState } from "./state.js";
import type { TtsProvider, TtsRequest, TtsResult } from "./tts/index.js";
import type { Story, StoryContentBlock } from "./types.js";

export { createInitialState };

export interface ArticleDecisionInput {
  decision: "accept" | "skip";
  slug: string;
  state: PirateRadioState;
  libraryDir: string;
  readArticle: (url: string) => Promise<Story>;
  synthesize: (request: TtsRequest) => Promise<TtsResult>;
  enableAlignment?: boolean;
}

export interface ArticleDecisionResult {
  status: "accepted" | "skipped" | "missing";
  article?: PirateArticle;
  libraryItem?: LibraryItem;
}

export interface RefreshLibraryArticleInput {
  slug: string;
  libraryDir: string;
  readArticle: (url: string) => Promise<Story>;
  cacheImage?: typeof cacheStoryImage;
  regenerateAudio?: boolean;
  synthesize?: (request: TtsRequest) => Promise<TtsResult>;
}

export interface RefreshLibraryArticleResult {
  status: "refreshed" | "missing";
  libraryItem?: LibraryItem;
}

export interface CustomTextInput {
  title: string;
  text: string;
}

export type CustomTextValidation =
  | { ok: true; title: string; text: string }
  | { ok: false; error: string };

export interface CustomTextAudioInput extends CustomTextInput {
  libraryDir: string;
  synthesize: (request: TtsRequest) => Promise<TtsResult>;
  enableAlignment?: boolean;
  now?: () => Date;
}

export interface CustomTextAudioResult {
  status: "created";
  libraryItem: LibraryItem;
}

export async function handleArticleDecision(
  input: ArticleDecisionInput,
): Promise<ArticleDecisionResult> {
  const existingApproved = findDecisionRecord(input.state.approved, input.slug);
  if (existingApproved && input.decision === "accept") {
    return { status: "accepted", article: existingApproved.article };
  }

  const article =
    input.state.pending[input.slug] ??
    findDecisionRecord(input.state.skipped, input.slug)?.article ??
    findSeenArticle(input.state, input.slug);
  if (!article) {
    return { status: "missing" };
  }

  const decidedAt = new Date().toISOString();

  if (input.decision === "skip") {
    delete input.state.pending[input.slug];
    input.state.skipped[article.id] = { article, decidedAt };
    return { status: "skipped", article };
  }

  delete input.state.skipped[article.id];

  const story = await input.readArticle(article.url);
  story.author = normalizedAuthor(story.author) ?? normalizedAuthor(article.author);
  const slug = storySlug(story);
  const textDir = join(input.libraryDir, "text");
  const storyDir = join(input.libraryDir, "stories");
  const audioDir = join(input.libraryDir, "audio");
  await mkdir(textDir, { recursive: true });
  await mkdir(storyDir, { recursive: true });
  await mkdir(audioDir, { recursive: true });

  const textPath = join(textDir, `${slug}.txt`);
  const jsonPath = join(storyDir, `${slug}.json`);
  const audioPath = join(audioDir, `${slug}.mp3`);
  const cachedImage = await tryCacheStoryImage(input.libraryDir, slug, story.heroImageOriginalUrl);
  if (cachedImage) {
    story.heroImagePath = cachedImage.imagePath;
    story.heroImageUrl = cachedImage.imageUrl;
  }

  await writeFile(textPath, `${story.title}\n\n${story.text}\n`, "utf8");
  await writeFile(jsonPath, `${JSON.stringify(story, null, 2)}\n`, "utf8");
  const ttsResult = await input.synthesize({
    title: story.title,
    text: story.text,
    outputPath: audioPath,
    allowOverBudget: false,
    ...(input.enableAlignment ? { includeTimestamps: true } : {}),
  });
  const alignment = input.enableAlignment
    ? await tryWriteAlignment(input.libraryDir, slug, ttsResult)
    : undefined;

  const manifest = await appendLibraryItem(input.libraryDir, {
    slug,
    title: story.title,
    author: story.author,
    sourceUrl: story.sourceUrl,
    sourceType: article.sourceType,
    sourceName: article.sourceName,
    canonicalUrl: article.canonicalUrl ?? article.url,
    audioPath: ttsResult.outputPath,
    jsonPath,
    textPath,
    imagePath: story.heroImagePath,
    imageUrl: story.heroImageUrl,
    alignmentPath: alignment?.alignmentPath,
    alignmentUrl: alignment?.alignmentUrl,
    hasAlignment: Boolean(alignment),
    tagline: story.tagline,
    sectionTitles: story.sectionTitles,
    publishedAt: article.publishedAt,
    generatedAt: new Date().toISOString(),
    estimatedCostUsd: ttsResult.estimatedCostUsd,
    wordCount: story.wordCount,
    characterCount: story.characterCount,
  });

  input.state.approved[article.id] = { article, decidedAt };
  delete input.state.pending[input.slug];
  return { status: "accepted", article, libraryItem: manifest.items[0] };
}

export function providerSynthesizer(provider: TtsProvider): ArticleDecisionInput["synthesize"] {
  return (request) => provider.synthesize(request);
}

export async function createCustomTextAudio(
  input: CustomTextAudioInput,
): Promise<CustomTextAudioResult> {
  const validation = validateCustomTextInput(input);
  if (!validation.ok) {
    throw new Error(validation.error);
  }

  const now = input.now?.() ?? new Date();
  const slug = sanitizeSlug(`${validation.title}-${now.toISOString()}`);
  const story = customTextStory(validation.title, validation.text, slug, now);
  const textDir = join(input.libraryDir, "text");
  const storyDir = join(input.libraryDir, "stories");
  const audioDir = join(input.libraryDir, "audio");
  await mkdir(textDir, { recursive: true });
  await mkdir(storyDir, { recursive: true });
  await mkdir(audioDir, { recursive: true });

  const textPath = join(textDir, `${slug}.txt`);
  const jsonPath = join(storyDir, `${slug}.json`);
  const audioPath = join(audioDir, `${slug}.mp3`);

  await writeFile(textPath, `${story.title}\n\n${story.text}\n`, "utf8");
  await writeFile(jsonPath, `${JSON.stringify(story, null, 2)}\n`, "utf8");
  const ttsResult = await input.synthesize({
    title: story.title,
    text: story.text,
    outputPath: audioPath,
    allowOverBudget: false,
    ...(input.enableAlignment ? { includeTimestamps: true } : {}),
  });
  const alignment = input.enableAlignment
    ? await tryWriteAlignment(input.libraryDir, slug, ttsResult)
    : undefined;

  const manifest = await appendLibraryItem(input.libraryDir, {
    slug,
    title: story.title,
    sourceUrl: story.sourceUrl,
    sourceType: "custom-text",
    sourceName: "Custom Text",
    canonicalUrl: story.sourceUrl,
    audioPath: ttsResult.outputPath,
    jsonPath,
    textPath,
    alignmentPath: alignment?.alignmentPath,
    alignmentUrl: alignment?.alignmentUrl,
    hasAlignment: Boolean(alignment),
    publishedAt: now.toUTCString(),
    generatedAt: now.toISOString(),
    estimatedCostUsd: ttsResult.estimatedCostUsd,
    wordCount: story.wordCount,
    characterCount: story.characterCount,
  });

  return { status: "created", libraryItem: manifest.items[0] };
}

export function validateCustomTextInput(input: CustomTextInput): CustomTextValidation {
  const title = input.title.trim();
  const text = input.text.trim();
  if (!title) {
    return { ok: false, error: "Enter a title." };
  }
  if (title.length > 160) {
    return { ok: false, error: "Title must be 160 characters or less." };
  }
  if (!text) {
    return { ok: false, error: "Enter text to convert." };
  }
  if (text.length > 60000) {
    return { ok: false, error: "Text must be 60,000 characters or less." };
  }
  return { ok: true, title, text };
}

export async function refreshLibraryArticle(
  input: RefreshLibraryArticleInput,
): Promise<RefreshLibraryArticleResult> {
  const manifest = await readLibraryManifest(input.libraryDir);
  const item = manifest.items.find((candidate) => candidate.slug === input.slug);
  if (!item) {
    return { status: "missing" };
  }

  const story = await input.readArticle(item.sourceUrl);
  story.author = normalizedAuthor(story.author) ?? normalizedAuthor(item.author);
  const slug = storySlug(story);
  const cachedImage = await (input.cacheImage ?? cacheStoryImage)({
    libraryDir: input.libraryDir,
    slug,
    imageUrl: story.heroImageOriginalUrl,
  });
  if (cachedImage) {
    story.heroImagePath = cachedImage.imagePath;
    story.heroImageUrl = cachedImage.imageUrl;
  } else {
    story.heroImagePath = item.imagePath;
    story.heroImageUrl = item.imageUrl;
  }

  await mkdir(join(input.libraryDir, "text"), { recursive: true });
  await mkdir(join(input.libraryDir, "stories"), { recursive: true });
  await writeFile(item.textPath, `${story.title}\n\n${story.text}\n`, "utf8");
  await writeFile(item.jsonPath, `${JSON.stringify(story, null, 2)}\n`, "utf8");

  let audioPath = item.audioPath;
  let estimatedCostUsd = item.estimatedCostUsd;
  if (input.regenerateAudio) {
    if (!input.synthesize) {
      throw new Error("Cannot regenerate audio without a synthesizer.");
    }
    const ttsResult = await input.synthesize({
      title: story.title,
      text: story.text,
      outputPath: item.audioPath,
      allowOverBudget: false,
    });
    audioPath = ttsResult.outputPath;
    estimatedCostUsd = ttsResult.estimatedCostUsd;
  }

  const nextManifest = await appendLibraryItem(input.libraryDir, {
    slug: item.slug,
    title: story.title,
    author: story.author,
    sourceUrl: story.sourceUrl,
    sourceType: item.sourceType,
    sourceName: item.sourceName,
    canonicalUrl: item.canonicalUrl,
    audioPath,
    jsonPath: item.jsonPath,
    textPath: item.textPath,
    imagePath: story.heroImagePath,
    imageUrl: story.heroImageUrl,
    alignmentPath: item.alignmentPath,
    alignmentUrl: item.alignmentUrl,
    hasAlignment: item.hasAlignment,
    tagline: story.tagline,
    sectionTitles: story.sectionTitles,
    publishedAt: item.publishedAt,
    generatedAt: item.generatedAt,
    estimatedCostUsd,
    wordCount: story.wordCount,
    characterCount: story.characterCount,
  });

  return {
    status: "refreshed",
    libraryItem: nextManifest.items.find((candidate) => candidate.slug === item.slug),
  };
}

function normalizedAuthor(author: string | undefined): string | undefined {
  return author?.trim() || undefined;
}

function findDecisionRecord(
  records: PirateRadioState["approved"] | PirateRadioState["skipped"],
  slug: string,
): { article: PirateArticle; decidedAt: string } | undefined {
  return Object.values(records).find((record) => articleSlug(record.article) === slug);
}

function findSeenArticle(state: PirateRadioState, slug: string): PirateArticle | undefined {
  return Object.values(state.seen).find((article) => articleSlug(article) === slug);
}

function articleSlug(article: PirateArticle): string {
  return article.slug ?? basename(new URL(article.url).pathname);
}

function customTextStory(title: string, text: string, slug: string, now: Date): Story {
  const paragraphs = text.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const contentBlocks: StoryContentBlock[] = paragraphs.map((paragraph) => ({
    type: "paragraph",
    text: paragraph,
  }));
  return {
    sourceUrl: `custom-text://local/${slug}`,
    title,
    text,
    contentBlocks,
    wordCount: text.split(/\s+/).filter(Boolean).length,
    characterCount: text.length,
    extractedAt: now.toISOString(),
  };
}

async function tryCacheStoryImage(
  libraryDir: string,
  slug: string,
  imageUrl?: string,
): Promise<{ imagePath: string; imageUrl: string } | undefined> {
  try {
    return await cacheStoryImage({ libraryDir, slug, imageUrl });
  } catch (error) {
    console.warn(`[pirate-radio] image cache failed for ${slug}: ${(error as Error).message}`);
    return undefined;
  }
}

async function tryWriteAlignment(
  libraryDir: string,
  slug: string,
  ttsResult: TtsResult,
): Promise<{ alignmentPath: string; alignmentUrl: string } | undefined> {
  try {
    return await writeAlignment({
      libraryDir,
      slug,
      audioPath: ttsResult.outputPath,
      ...(ttsResult.words ? { words: ttsResult.words } : {}),
    });
  } catch (error) {
    console.warn(`[pirate-radio] alignment failed for ${slug}: ${(error as Error).message}`);
    return undefined;
  }
}

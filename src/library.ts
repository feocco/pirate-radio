import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

export interface LibraryItem {
  slug: string;
  title: string;
  author?: string;
  sourceUrl: string;
  sourceType?: string;
  sourceName?: string;
  canonicalUrl?: string;
  publishedAt: string;
  generatedAt: string;
  audioPath: string;
  audioUrl: string;
  jsonPath: string;
  textPath: string;
  imagePath?: string;
  imageUrl?: string;
  alignmentPath?: string;
  alignmentUrl?: string;
  hasAlignment?: boolean;
  tagline?: string;
  sectionTitles?: string[];
  estimatedCostUsd: number;
  wordCount: number;
  characterCount: number;
  audioBytes: number;
}

export interface LibraryManifest {
  version: 1;
  updatedAt: string;
  items: LibraryItem[];
}

export type NewLibraryItem = Omit<LibraryItem, "audioUrl" | "audioBytes">;
const manifestWriteQueues = new Map<string, Promise<LibraryManifest>>();

export async function readLibraryManifest(libraryDir: string): Promise<LibraryManifest> {
  try {
    return JSON.parse(await readFile(manifestPath(libraryDir), "utf8")) as LibraryManifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, updatedAt: new Date(0).toISOString(), items: [] };
    }
    throw error;
  }
}

export async function appendLibraryItem(
  libraryDir: string,
  item: NewLibraryItem,
): Promise<LibraryManifest> {
  const previous = manifestWriteQueues.get(libraryDir) ?? Promise.resolve({ version: 1 as const, updatedAt: new Date(0).toISOString(), items: [] });
  const next = previous.catch(() => ({ version: 1 as const, updatedAt: new Date(0).toISOString(), items: [] })).then(() => appendLibraryItemLocked(libraryDir, item));
  manifestWriteQueues.set(libraryDir, next);
  try {
    return await next;
  } finally {
    if (manifestWriteQueues.get(libraryDir) === next) manifestWriteQueues.delete(libraryDir);
  }
}

async function appendLibraryItemLocked(
  libraryDir: string,
  item: NewLibraryItem,
): Promise<LibraryManifest> {
  await mkdir(libraryDir, { recursive: true });
  const manifest = await readLibraryManifest(libraryDir);
  const audioBytes = (await stat(item.audioPath)).size;
  const nextItem: LibraryItem = {
    ...item,
    audioUrl: `/audio/${basename(item.audioPath)}`,
    audioBytes,
  };
  const items = [nextItem, ...manifest.items.filter((existing) => existing.slug !== item.slug)];
  const nextManifest: LibraryManifest = {
    version: 1,
    updatedAt: new Date().toISOString(),
    items,
  };
  const target = manifestPath(libraryDir);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(nextManifest, null, 2)}\n`, "utf8");
  await rename(temporary, target);
  return nextManifest;
}

export function manifestPath(libraryDir: string): string {
  return join(libraryDir, "index.json");
}

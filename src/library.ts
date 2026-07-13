import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

export interface LibraryItem {
  slug: string;
  title: string;
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
  await writeFile(manifestPath(libraryDir), `${JSON.stringify(nextManifest, null, 2)}\n`, "utf8");
  return nextManifest;
}

export function manifestPath(libraryDir: string): string {
  return join(libraryDir, "index.json");
}

import { copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

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

export interface ArchivedLibraryItem {
  item: LibraryItem;
  deletedAt: string;
  deletedByUsername: string;
  archiveDir: string;
  archivedFiles: string[];
  retainedOriginalFiles: string[];
}

export type NewLibraryItem = Omit<LibraryItem, "audioUrl" | "audioBytes">;
const manifestWriteQueues = new Map<string, Promise<unknown>>();

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
  return queueManifestWrite(libraryDir, () => appendLibraryItemLocked(libraryDir, item));
}

export async function archiveLibraryItem(
  libraryDir: string,
  slug: string,
  deletedByUsername: string,
): Promise<ArchivedLibraryItem | undefined> {
  return queueManifestWrite(libraryDir, () =>
    archiveLibraryItemLocked(libraryDir, slug, deletedByUsername),
  );
}

async function queueManifestWrite<T>(libraryDir: string, operation: () => Promise<T>): Promise<T> {
  const previous = manifestWriteQueues.get(libraryDir) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
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
  await writeManifest(libraryDir, nextManifest);
  return nextManifest;
}

async function archiveLibraryItemLocked(
  libraryDir: string,
  slug: string,
  deletedByUsername: string,
): Promise<ArchivedLibraryItem | undefined> {
  const manifest = await readLibraryManifest(libraryDir);
  const item = manifest.items.find((candidate) => candidate.slug === slug);
  if (!item) return undefined;

  const deletedAt = new Date().toISOString();
  const archiveDir = join(
    libraryDir,
    "trash",
    `${deletedAt.replace(/[:.]/g, "-")}-${slug.replace(/[^a-z0-9._-]/gi, "_")}`,
  );
  await mkdir(archiveDir, { recursive: true });

  const libraryRoot = resolve(libraryDir);
  const paths = [...new Set([
    item.audioPath,
    item.jsonPath,
    item.textPath,
    item.imagePath,
    item.alignmentPath,
  ].filter((value): value is string => Boolean(value)))];
  const archivedFiles: string[] = [];

  for (const path of paths) {
    const relativePath = libraryRelativePath(libraryRoot, path);
    const destination = join(archiveDir, relativePath);
    await mkdir(dirname(destination), { recursive: true });
    try {
      await copyFile(path, destination);
      archivedFiles.push(relativePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  await writeJsonAtomic(join(archiveDir, "manifest-before.json"), manifest);
  const deletion = {
    version: 1,
    deletedAt,
    deletedByUsername,
    item,
    archivedFiles,
    retainedOriginalFiles: [] as string[],
  };
  await writeJsonAtomic(join(archiveDir, "deletion.json"), deletion);

  const nextManifest: LibraryManifest = {
    version: 1,
    updatedAt: deletedAt,
    items: manifest.items.filter((candidate) => candidate.slug !== slug),
  };
  await writeManifest(libraryDir, nextManifest);

  const retainedOriginalFiles: string[] = [];
  for (const path of paths) {
    try {
      await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") retainedOriginalFiles.push(path);
    }
  }
  if (retainedOriginalFiles.length) {
    deletion.retainedOriginalFiles = retainedOriginalFiles;
    await writeJsonAtomic(join(archiveDir, "deletion.json"), deletion);
  }

  return { item, deletedAt, deletedByUsername, archiveDir, archivedFiles, retainedOriginalFiles };
}

function libraryRelativePath(libraryRoot: string, path: string): string {
  const relativePath = relative(libraryRoot, resolve(path));
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`Refusing to archive a file outside the library: ${path}`);
  }
  return relativePath;
}

async function writeManifest(libraryDir: string, manifest: LibraryManifest): Promise<void> {
  await writeJsonAtomic(manifestPath(libraryDir), manifest);
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

export function manifestPath(libraryDir: string): string {
  return join(libraryDir, "index.json");
}

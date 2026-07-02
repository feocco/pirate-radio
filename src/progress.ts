import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_USER_ID = "default";

export interface PlaybackProgress {
  positionSeconds: number;
  durationSeconds?: number;
  updatedAt: string;
}

interface PlaybackProgressStore {
  version: 1;
  updatedAt: string;
  users: Record<string, Record<string, PlaybackProgress>>;
}

export interface WritePlaybackProgressInput {
  positionSeconds: number;
  durationSeconds?: number;
}

export async function readPlaybackProgress(
  libraryDir: string,
  slug: string,
): Promise<PlaybackProgress | undefined> {
  const store = await readPlaybackProgressStore(libraryDir);
  return store.users[DEFAULT_USER_ID]?.[slug];
}

export async function writePlaybackProgress(
  libraryDir: string,
  slug: string,
  progress: WritePlaybackProgressInput,
): Promise<PlaybackProgress> {
  const store = await readPlaybackProgressStore(libraryDir);
  const now = new Date().toISOString();
  const nextProgress: PlaybackProgress = {
    positionSeconds: normalizeSeconds(progress.positionSeconds),
    ...(progress.durationSeconds == null
      ? {}
      : { durationSeconds: normalizeSeconds(progress.durationSeconds) }),
    updatedAt: now,
  };
  store.users[DEFAULT_USER_ID] ??= {};
  store.users[DEFAULT_USER_ID][slug] = nextProgress;
  store.updatedAt = now;
  await mkdir(libraryDir, { recursive: true });
  await writeFile(progressPath(libraryDir), `${JSON.stringify(store, null, 2)}\n`, "utf8");
  return nextProgress;
}

export function progressPath(libraryDir: string): string {
  return join(libraryDir, "progress.json");
}

async function readPlaybackProgressStore(libraryDir: string): Promise<PlaybackProgressStore> {
  try {
    const store = JSON.parse(await readFile(progressPath(libraryDir), "utf8")) as PlaybackProgressStore;
    store.version = 1;
    store.users ??= {};
    store.users[DEFAULT_USER_ID] ??= {};
    return store;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        version: 1,
        updatedAt: new Date(0).toISOString(),
        users: { [DEFAULT_USER_ID]: {} },
      };
    }
    throw error;
  }
}

function normalizeSeconds(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.round(value * 1000) / 1000;
}

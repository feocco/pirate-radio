import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_USER_ID = "default";
const writeQueues = new Map<string, Promise<void>>();

export interface PlaybackProgress {
  positionSeconds: number;
  durationSeconds?: number;
  updatedAt: string;
}

export interface PlaybackProgressStore {
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
  let writtenProgress: PlaybackProgress | undefined;
  await enqueueWrite(libraryDir, async () => {
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
    await writeProgressStoreAtomically(libraryDir, store);
    writtenProgress = nextProgress;
  });
  if (!writtenProgress) {
    throw new Error("Playback progress write did not complete.");
  }
  return writtenProgress;
}

export function progressPath(libraryDir: string): string {
  return join(libraryDir, "progress.json");
}

async function readPlaybackProgressStore(libraryDir: string): Promise<PlaybackProgressStore> {
  try {
    const parsed = JSON.parse(await readFile(progressPath(libraryDir), "utf8")) as unknown;
    return validatePlaybackProgressStore(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyPlaybackProgressStore();
    }
    console.warn(
      `[pirate-radio] ignoring invalid playback progress store at ${progressPath(libraryDir)}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return emptyPlaybackProgressStore();
  }
}

export async function readLegacyDefaultProgress(
  libraryDir: string,
): Promise<Record<string, PlaybackProgress>> {
  return (await readPlaybackProgressStore(libraryDir)).users[DEFAULT_USER_ID] ?? {};
}

async function enqueueWrite(libraryDir: string, write: () => Promise<void>): Promise<void> {
  const previous = writeQueues.get(libraryDir) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(write);
  writeQueues.set(
    libraryDir,
    next.finally(() => {
      if (writeQueues.get(libraryDir) === next) {
        writeQueues.delete(libraryDir);
      }
    }),
  );
  await next;
}

async function writeProgressStoreAtomically(
  libraryDir: string,
  store: PlaybackProgressStore,
): Promise<void> {
  await mkdir(libraryDir, { recursive: true });
  const targetPath = progressPath(libraryDir);
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await rename(tempPath, targetPath);
}

function emptyPlaybackProgressStore(): PlaybackProgressStore {
  return {
    version: 1,
    updatedAt: new Date(0).toISOString(),
    users: { [DEFAULT_USER_ID]: {} },
  };
}

function validatePlaybackProgressStore(value: unknown): PlaybackProgressStore {
  if (!isRecord(value) || Array.isArray(value.users)) {
    throw new Error("Invalid playback progress store shape.");
  }
  const usersValue = value.users;
  if (usersValue != null && !isRecord(usersValue)) {
    throw new Error("Invalid playback progress users shape.");
  }
  const users: Record<string, Record<string, PlaybackProgress>> = {};
  for (const [userId, entriesValue] of Object.entries(usersValue ?? {})) {
    if (!isRecord(entriesValue)) {
      throw new Error(`Invalid playback progress entries for user ${userId}.`);
    }
    users[userId] = {};
    for (const [slug, progressValue] of Object.entries(entriesValue)) {
      users[userId][slug] = validatePlaybackProgress(slug, progressValue);
    }
  }
  users[DEFAULT_USER_ID] ??= {};
  return {
    version: 1,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString(),
    users,
  };
}

function validatePlaybackProgress(slug: string, value: unknown): PlaybackProgress {
  if (!isRecord(value)) {
    throw new Error(`Invalid playback progress value for ${slug}.`);
  }
  if (typeof value.updatedAt !== "string") {
    throw new Error(`Invalid playback progress updatedAt for ${slug}.`);
  }
  if (typeof value.positionSeconds !== "number" || !Number.isFinite(value.positionSeconds)) {
    throw new Error(`Invalid playback progress positionSeconds for ${slug}.`);
  }
  if (
    value.durationSeconds != null &&
    (typeof value.durationSeconds !== "number" || !Number.isFinite(value.durationSeconds))
  ) {
    throw new Error(`Invalid playback progress durationSeconds for ${slug}.`);
  }
  return {
    positionSeconds: normalizeSeconds(value.positionSeconds),
    ...(value.durationSeconds == null
      ? {}
      : { durationSeconds: normalizeSeconds(value.durationSeconds) }),
    updatedAt: value.updatedAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeSeconds(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.round(value * 1000) / 1000;
}

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CloudExtractAnchors } from "./cloudExtract.js";

export interface CloudHostFingerprint {
  anchors?: CloudExtractAnchors;
  selectors?: string[];
}

export interface CloudHostRecord {
  host: string;
  firstSeenAt: string;
  lastExtractedAt: string;
  lastSourceUrl: string;
  fingerprint: CloudHostFingerprint;
  adapterStatus: "none" | "requested";
  adapterAgentId?: string;
  adapterPrUrl?: string;
}

export interface CloudHostStore {
  version: 1;
  updatedAt: string;
  hosts: Record<string, CloudHostRecord>;
}

const writeQueues = new Map<string, Promise<unknown>>();

export function cloudHostsPath(libraryDir: string): string {
  return join(libraryDir, "cloud-hosts.json");
}

export function normalizeCloudHost(hostOrUrl: string): string {
  const value = hostOrUrl.trim();
  try {
    const url = value.includes("://") ? new URL(value) : new URL(`https://${value}`);
    return url.hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    throw new Error("Enter a host or https URL.");
  }
}

export async function readCloudHostStore(libraryDir: string): Promise<CloudHostStore> {
  try {
    return JSON.parse(await readFile(cloudHostsPath(libraryDir), "utf8")) as CloudHostStore;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, updatedAt: new Date(0).toISOString(), hosts: {} };
    }
    throw error;
  }
}

export async function recordCloudHostExtract(input: {
  libraryDir: string;
  sourceUrl: string;
  anchors?: CloudExtractAnchors;
  selectors?: string[];
  now?: () => Date;
}): Promise<CloudHostRecord> {
  const host = normalizeCloudHost(input.sourceUrl);
  const now = (input.now?.() ?? new Date()).toISOString();
  return mutateCloudHostStore(input.libraryDir, (store) => {
    const existing = store.hosts[host];
    const record: CloudHostRecord = {
      host,
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastExtractedAt: now,
      lastSourceUrl: input.sourceUrl,
      fingerprint: {
        ...(input.anchors ? { anchors: input.anchors } : existing?.fingerprint.anchors ? { anchors: existing.fingerprint.anchors } : {}),
        ...(input.selectors ? { selectors: input.selectors } : existing?.fingerprint.selectors ? { selectors: existing.fingerprint.selectors } : {}),
      },
      adapterStatus: existing?.adapterStatus ?? "none",
      ...(existing?.adapterAgentId ? { adapterAgentId: existing.adapterAgentId } : {}),
      ...(existing?.adapterPrUrl ? { adapterPrUrl: existing.adapterPrUrl } : {}),
    };
    store.hosts[host] = record;
    return record;
  });
}

export async function markCloudHostAdapterRequested(input: {
  libraryDir: string;
  host: string;
  agentId?: string;
  prUrl?: string;
  now?: () => Date;
}): Promise<CloudHostRecord> {
  const host = normalizeCloudHost(input.host);
  return mutateCloudHostStore(input.libraryDir, (store) => {
    const existing = store.hosts[host] ?? {
      host,
      firstSeenAt: (input.now?.() ?? new Date()).toISOString(),
      lastExtractedAt: (input.now?.() ?? new Date()).toISOString(),
      lastSourceUrl: `https://${host}/`,
      fingerprint: {},
      adapterStatus: "none" as const,
    };
    const record: CloudHostRecord = {
      ...existing,
      adapterStatus: "requested",
      ...(input.agentId ? { adapterAgentId: input.agentId } : {}),
      ...(input.prUrl ? { adapterPrUrl: input.prUrl } : {}),
    };
    store.hosts[host] = record;
    return record;
  });
}

async function mutateCloudHostStore<T>(
  libraryDir: string,
  mutate: (store: CloudHostStore) => T,
): Promise<T> {
  const path = cloudHostsPath(libraryDir);
  const previous = writeQueues.get(path) ?? Promise.resolve();
  let result!: T;
  const next = previous.catch(() => undefined).then(async () => {
    const store = await readCloudHostStore(libraryDir);
    result = mutate(store);
    store.version = 1;
    store.updatedAt = new Date().toISOString();
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    await rename(temporary, path);
  });
  writeQueues.set(path, next);
  try {
    await next;
    return result;
  } finally {
    if (writeQueues.get(path) === next) {
      writeQueues.delete(path);
    }
  }
}

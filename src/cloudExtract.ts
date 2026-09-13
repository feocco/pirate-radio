import { isXHostname } from "./xArticle.js";
import { sanitizeSlug, slugFromUrl } from "./slug.js";
import type { Story, StoryContentBlock } from "./types.js";

export type UnsupportedArticleUrlClassification =
  | {
      ok: true;
      url: string;
      slug: string;
      sourceType: typeof CLOUD_EXTRACT_SOURCE_TYPE;
      sourceName: string;
    }
  | { ok: false; error: string };

export const MISSING_CURSOR_API_KEY_MESSAGE =
  "CURSOR_API_KEY is required to extract unsupported article URLs.";

export const CLOUD_EXTRACT_FAILURE_MESSAGE =
  "Cloud extract failed. The article was not added to the library.";

export const CLOUD_EXTRACT_TIMEOUT_MESSAGE =
  "Cloud extract timed out. The article was not added to the library.";

export const HOST_ADAPTER_TIMEOUT_MESSAGE = "Host adapter agent timed out.";

export const CLOUD_AGENT_TIMEOUT_MS = 10 * 60 * 1000;

export const CLOUD_EXTRACT_SOURCE_TYPE = "cloud-extract" as const;

export interface CloudExtractAnchors {
  firstSentence?: string;
  lastSentence?: string;
}

export interface CloudExtractRequest {
  url: string;
  anchors?: CloudExtractAnchors;
}

export interface ParsedCloudExtract {
  story: Story;
  selectors?: string[];
}

export interface CloudAgentRunResult {
  status: "finished" | "error" | "cancelled" | string;
  result?: string;
  error?: { message?: string };
  git?: { branches?: Array<{ repoUrl?: string; branch?: string; prUrl?: string }> };
}

export interface CloudAgentHandle {
  agentId?: string;
  send(message: string): Promise<{ wait(): Promise<CloudAgentRunResult> }>;
  listArtifacts(): Promise<Array<{ path: string }>>;
  downloadArtifact(path: string): Promise<Uint8Array>;
  close(): void;
}

export const PIRATE_RADIO_REPO_URL = "https://github.com/feocco/pirate-radio";

export interface CloudAgentCreateInput {
  apiKey: string;
  cloud:
    | { repos: [] }
    | {
        repos: Array<{ url: string; startingRef?: string }>;
        autoCreatePR?: boolean;
      };
}

export type CloudAgentFactory = (input: CloudAgentCreateInput) => Promise<CloudAgentHandle>;

export function cursorApiKeyFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const key = env.CURSOR_API_KEY?.trim();
  return key || undefined;
}

export function normalizeExtractAnchors(input: {
  firstSentence?: unknown;
  lastSentence?: unknown;
}): CloudExtractAnchors | undefined {
  const firstSentence = typeof input.firstSentence === "string" ? input.firstSentence.trim() : "";
  const lastSentence = typeof input.lastSentence === "string" ? input.lastSentence.trim() : "";
  if (!firstSentence && !lastSentence) {
    return undefined;
  }
  return {
    ...(firstSentence ? { firstSentence } : {}),
    ...(lastSentence ? { lastSentence } : {}),
  };
}

export function hostDisplayName(hostname: string): string {
  return hostname.replace(/^www\./i, "");
}

export function cloudExtractSlug(url: string): string {
  const parsed = new URL(url);
  const host = sanitizeSlug(hostDisplayName(parsed.hostname));
  const path = slugFromUrl(url);
  return sanitizeSlug(`${host}-${path}`);
}

export function decodeArtifactBytes(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf8");
}

export async function withCloudAgentTimeout<T>(
  work: () => Promise<T>,
  options: { timeoutMs?: number; timeoutMessage?: string } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? CLOUD_AGENT_TIMEOUT_MS;
  const timeoutMessage = options.timeoutMessage ?? CLOUD_EXTRACT_TIMEOUT_MESSAGE;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = work();
  pending.catch(() => {
    // Keep a late reject from an abandoned create/send/wait from becoming unhandled.
  });
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export async function waitForCloudAgent(
  wait: () => Promise<CloudAgentRunResult>,
  options: { timeoutMs?: number; timeoutMessage?: string } = {},
): Promise<CloudAgentRunResult> {
  return withCloudAgentTimeout(wait, options);
}

export function classifyUnsupportedHttpsArticleUrl(value: string): UnsupportedArticleUrlClassification {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return { ok: false, error: "Enter a valid URL." };
  }

  if (url.protocol !== "https:") {
    return { ok: false, error: "Enter an https article URL." };
  }

  if (isXHostname(url.hostname)) {
    return {
      ok: false,
      error: "Enter an X post URL with a /username/status/id path.",
    };
  }

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length === 0) {
    return { ok: false, error: "Enter an article URL with a path." };
  }

  url.hash = "";
  url.search = "";
  return {
    ok: true,
    url: url.toString(),
    slug: cloudExtractSlug(url.toString()),
    sourceType: CLOUD_EXTRACT_SOURCE_TYPE,
    sourceName: hostDisplayName(url.hostname),
  };
}

export function buildCloudExtractPrompt(request: CloudExtractRequest): string {
  const lines = [
    "Open this URL in the browser and extract the article body only.",
    `URL: ${request.url}`,
    "",
    "Write a Story-shaped JSON file at artifacts/story.json with these fields:",
    "- title (string)",
    "- author (optional string; omit if unknown; do not invent a byline)",
    "- text (string; article body only)",
    "- sourceUrl (exactly the URL above)",
    "- characterCount (number; text character length)",
    "- wordCount (number; whitespace-separated words)",
    "- extractedAt (ISO-8601 timestamp)",
    "- selectors (optional string array of CSS selectors you used)",
    "",
    "Exclude comments, subscribe widgets, related posts, and nav chrome.",
  ];
  if (request.anchors?.firstSentence) {
    lines.push(
      `The extract must begin at this first sentence, inclusive: ${request.anchors.firstSentence}`,
    );
  }
  if (request.anchors?.lastSentence) {
    lines.push(
      `The extract must end at this last sentence, inclusive: ${request.anchors.lastSentence}`,
    );
  }
  return lines.join("\n");
}

export function parseCloudExtractArtifact(
  raw: unknown,
  sourceUrl: string,
  anchors?: CloudExtractAnchors,
  now: () => Date = () => new Date(),
): ParsedCloudExtract {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Cloud extract artifact is not a Story object.");
  }
  const value = raw as Record<string, unknown>;
  const title = asNonEmptyString(value.title);
  const text = asNonEmptyString(value.text);
  if (!title || !text) {
    throw new Error("Cloud extract artifact is missing title or text.");
  }
  assertAnchors(text, anchors);

  const author = asNonEmptyString(value.author);
  const selectors = asStringArray(value.selectors);
  const extractedAt =
    typeof value.extractedAt === "string" && !Number.isNaN(Date.parse(value.extractedAt))
      ? value.extractedAt
      : now().toISOString();
  const paragraphs = text.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const contentBlocks: StoryContentBlock[] = paragraphs.map((paragraph) => ({
    type: "paragraph",
    text: paragraph,
  }));

  return {
    story: {
      sourceUrl,
      title,
      ...(author ? { author } : {}),
      text,
      contentBlocks,
      wordCount: countWords(text),
      characterCount: text.length,
      extractedAt,
    },
    ...(selectors ? { selectors } : {}),
  };
}

export async function extractStoryViaCloud(
  request: CloudExtractRequest,
  options: {
    apiKey?: string;
    createAgent?: CloudAgentFactory;
    now?: () => Date;
    timeoutMs?: number;
  } = {},
): Promise<ParsedCloudExtract> {
  const apiKey = options.apiKey ?? cursorApiKeyFromEnv();
  if (!apiKey) {
    throw new Error(MISSING_CURSOR_API_KEY_MESSAGE);
  }

  const createAgent = options.createAgent ?? createCursorSdkAgent;
  let agent: CloudAgentHandle | undefined;
  try {
    return await withCloudAgentTimeout(async () => {
      agent = await createAgent({
        apiKey,
        cloud: { repos: [] },
      });
      const run = await agent.send(buildCloudExtractPrompt(request));
      const result = await run.wait();
      if (result.status !== "finished") {
        throw new Error(result.error?.message || CLOUD_EXTRACT_FAILURE_MESSAGE);
      }

      const artifactPath = pickStoryArtifactPath(await agent.listArtifacts());
      if (!artifactPath) {
        throw new Error("Cloud extract finished without a Story JSON artifact.");
      }

      let raw: unknown;
      try {
        raw = JSON.parse(decodeArtifactBytes(await agent.downloadArtifact(artifactPath)));
      } catch (error) {
        throw new Error(
          error instanceof Error && error.message.includes("JSON")
            ? error.message
            : "Cloud extract artifact is not valid JSON.",
        );
      }

      return parseCloudExtractArtifact(raw, request.url, request.anchors, options.now);
    }, { timeoutMs: options.timeoutMs });
  } finally {
    agent?.close();
  }
}

export function buildHostAdapterPrompt(input: {
  host: string;
  sourceUrl?: string;
  fingerprint?: { anchors?: CloudExtractAnchors; selectors?: string[] };
}): string {
  const lines = [
    `Add a first-class Pirate Radio host adapter for ${input.host}.`,
    "Open a pull request. Do not merge or enable auto-merge.",
    "",
    "Reuse the public HTML extract path in src/extractor.ts and src/browser.ts.",
    "Follow the Substack/public fetch pattern, not Playwright, unless the host is paywalled.",
    "Do not scrape X. X Articles stay on the official Post lookup API.",
    "Do not add Mozilla Readability as a generic product path.",
    "Keep validateArticleUrl, library sourceType, and the queue convert-url path in sync.",
    "Cover the new host with focused tests.",
  ];
  if (input.sourceUrl) {
    lines.push(`Example URL from a successful cloud extract: ${input.sourceUrl}`);
  }
  if (input.fingerprint?.selectors?.length) {
    lines.push(`Selectors observed during cloud extract: ${input.fingerprint.selectors.join(", ")}`);
  }
  if (input.fingerprint?.anchors?.firstSentence) {
    lines.push(`First-sentence anchor that worked: ${input.fingerprint.anchors.firstSentence}`);
  }
  if (input.fingerprint?.anchors?.lastSentence) {
    lines.push(`Last-sentence anchor that worked: ${input.fingerprint.anchors.lastSentence}`);
  }
  return lines.join("\n");
}

const adapterHostsInFlight = new Set<string>();

export type QueueHostAdapterProposalResult =
  | { ok: true; status: "queued" | "processing" | "opened"; host: string; prUrl?: string }
  | { ok: false; error: string };

export async function queueHostAdapterProposal(input: {
  hostOrUrl: string;
  libraryDir: string;
  apiKey?: string;
  createAgent?: CloudAgentFactory;
  repoUrl?: string;
  timeoutMs?: number;
}): Promise<QueueHostAdapterProposalResult> {
  const { normalizeCloudHost, readCloudHostStore } = await import("./cloudHosts.js");
  let host: string;
  try {
    host = normalizeCloudHost(input.hostOrUrl);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Enter a host or https URL.",
    };
  }

  const apiKey = input.apiKey ?? cursorApiKeyFromEnv();
  if (!apiKey) {
    return { ok: false, error: MISSING_CURSOR_API_KEY_MESSAGE };
  }

  const existing = (await readCloudHostStore(input.libraryDir)).hosts[host];
  if (existing?.adapterPrUrl) {
    return { ok: true, status: "opened", host, prUrl: existing.adapterPrUrl };
  }
  if (adapterHostsInFlight.has(host)) {
    return { ok: true, status: "processing", host };
  }

  adapterHostsInFlight.add(host);
  void proposeHostAdapter({
    ...input,
    hostOrUrl: host,
    apiKey,
  }).catch((error) => {
    console.error(
      `[pirate-radio] adapter agent failed for ${host}:`,
      error instanceof Error ? error.message : error,
    );
  }).finally(() => {
    adapterHostsInFlight.delete(host);
  });

  return { ok: true, status: "queued", host };
}

export async function proposeHostAdapter(input: {
  hostOrUrl: string;
  libraryDir: string;
  apiKey?: string;
  createAgent?: CloudAgentFactory;
  repoUrl?: string;
  timeoutMs?: number;
}): Promise<{ host: string; agentId?: string; prUrl?: string }> {
  const { markCloudHostAdapterRequested, normalizeCloudHost, readCloudHostStore } = await import("./cloudHosts.js");
  const host = normalizeCloudHost(input.hostOrUrl);
  const apiKey = input.apiKey ?? cursorApiKeyFromEnv();
  if (!apiKey) {
    throw new Error(MISSING_CURSOR_API_KEY_MESSAGE);
  }

  const store = await readCloudHostStore(input.libraryDir);
  const existing = store.hosts[host];
  const createAgent = input.createAgent ?? createCursorSdkAgent;
  let agent: CloudAgentHandle | undefined;
  try {
    return await withCloudAgentTimeout(async () => {
      agent = await createAgent({
        apiKey,
        cloud: {
          repos: [{ url: input.repoUrl ?? PIRATE_RADIO_REPO_URL, startingRef: "main" }],
          autoCreatePR: true,
        },
      });
      const run = await agent.send(
        buildHostAdapterPrompt({
          host,
          sourceUrl: existing?.lastSourceUrl,
          fingerprint: existing?.fingerprint,
        }),
      );
      const result = await run.wait();
      if (result.status !== "finished") {
        throw new Error(result.error?.message || "Host adapter agent failed.");
      }
      const prUrl = result.git?.branches?.find((branch) => branch.prUrl)?.prUrl;
      const record = await markCloudHostAdapterRequested({
        libraryDir: input.libraryDir,
        host,
        agentId: agent.agentId,
        ...(prUrl ? { prUrl } : {}),
      });
      return {
        host: record.host,
        ...(record.adapterAgentId ? { agentId: record.adapterAgentId } : {}),
        ...(record.adapterPrUrl ? { prUrl: record.adapterPrUrl } : {}),
      };
    }, {
      timeoutMs: input.timeoutMs,
      timeoutMessage: HOST_ADAPTER_TIMEOUT_MESSAGE,
    });
  } finally {
    agent?.close();
  }
}

export async function createCursorSdkAgent(input: CloudAgentCreateInput): Promise<CloudAgentHandle> {
  const { Agent } = await import("@cursor/sdk");
  return Agent.create({
    apiKey: input.apiKey,
    cloud: input.cloud,
  });
}

export function pickStoryArtifactPath(artifacts: Array<{ path: string }>): string | undefined {
  const jsonArtifacts = artifacts.filter((artifact) => artifact.path.toLowerCase().endsWith(".json"));
  return (
    jsonArtifacts.find((artifact) => artifact.path.replace(/\\/g, "/").endsWith("artifacts/story.json"))?.path ??
    jsonArtifacts.find((artifact) => /story\.json$/i.test(artifact.path))?.path ??
    jsonArtifacts[0]?.path
  );
}

function assertAnchors(text: string, anchors?: CloudExtractAnchors): void {
  const trimmed = text.trim();
  if (anchors?.firstSentence && !trimmed.startsWith(anchors.firstSentence)) {
    throw new Error("Cloud extract did not begin at the requested first sentence.");
  }
  if (anchors?.lastSentence && !trimmed.endsWith(anchors.lastSentence)) {
    throw new Error("Cloud extract did not end at the requested last sentence.");
  }
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return items.length > 0 ? items : undefined;
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

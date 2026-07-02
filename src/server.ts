import { createReadStream } from "node:fs";
import { access, mkdir, readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, join, resolve } from "node:path";
import { contentTypeForAsset } from "./assets.js";
import { buildBacklogItems, queueBacklogConversion } from "./backlog.js";
import { filterVoiceExcludedLibraryManifest } from "./articleFilters.js";
import { fetchPirateFeed, detectNewArticles } from "./feed.js";
import { extractStoryFromUrl } from "./browser.js";
import type { PirateRadioConfig } from "./config.js";
import { HomeAssistantActionListener } from "./haActions.js";
import { readLibraryManifest } from "./library.js";
import {
  buildArticleFailureNotification,
  buildArticleNotification,
  buildArticleReadyNotification,
  failureType,
  type ArticleNotification,
  type PirateRadioDecision,
} from "./notifications.js";
import { HomelabFunctionsNotifier, type Notifier } from "./notifier.js";
import { readPlaybackProgress, writePlaybackProgress } from "./progress.js";
import { renderAdminHtml, renderArticleHtml, renderBacklogHtml, renderReaderHtml } from "./reader.js";
import { readState, seenArticleIds, writeState, type PirateRadioState } from "./state.js";
import { createTtsProvider } from "./tts/index.js";
import { handleArticleDecision, providerSynthesizer, refreshLibraryArticle } from "./workflow.js";

export interface PirateRadioServiceOptions {
  config: PirateRadioConfig;
  notifier?: Notifier;
}

export class PirateRadioService {
  private state?: PirateRadioState;
  private pollTimer?: NodeJS.Timeout;
  private readonly notifier: Notifier;
  private readonly actionListener: HomeAssistantActionListener;
  private readonly failureNotifications = new Set<string>();
  private readonly processingBacklogSlugs = new Set<string>();

  constructor(private readonly options: PirateRadioServiceOptions) {
    this.notifier =
      options.notifier ??
      new HomelabFunctionsNotifier({
        serviceUrl: options.config.homelabFunctionsUrl,
        token: options.config.homelabFunctionsToken,
      });
    this.actionListener = new HomeAssistantActionListener({
      haUrl: options.config.haUrl,
      token: options.config.haLongLivedToken,
      onAction: (action) => this.decide(action.slug, action.decision),
    });
  }

  async start(): Promise<void> {
    await mkdir(this.options.config.libraryDir, { recursive: true });
    this.state = await readState(this.options.config.statePath);
    const server = createServer((request, response) => {
      void this.handleRequest(request, response);
    });
    server.listen(this.options.config.port, this.options.config.host, () => {
      console.log(
        `[pirate-radio] listening on ${this.options.config.host}:${this.options.config.port}`,
      );
    });

    void this.actionListener.start();
    await this.pollOnce();
    this.pollTimer = setInterval(() => {
      void this.pollOnce();
    }, this.options.config.pollIntervalMs);
  }

  async pollOnce(): Promise<void> {
    const state = await this.getState();
    const articles = await fetchPirateFeed(this.options.config.feedUrl);
    const unseen = detectNewArticles(articles, seenArticleIds(state));
    const toNotify = unseen.slice(0, this.options.config.maxNotificationsPerPoll);

    const firstRun = !state.initialized;
    const articlesToMarkSeen = firstRun ? unseen : toNotify;
    for (const article of articlesToMarkSeen) {
      state.seen[article.id] = article;
    }
    state.initialized = true;

    for (const article of toNotify) {
      const slug = article.slug ?? basename(new URL(article.url).pathname);
      state.pending[slug] = article;
      await this.notifier.send(buildArticleNotification(article, this.options.config.publicBaseUrl));
      console.log(`[pirate-radio] queued notification for ${article.title}`);
    }

    await writeState(this.options.config.statePath, state);
  }

  async decide(slug: string, decision: PirateRadioDecision): Promise<void> {
    const state = await this.getState();
    const provider = createTtsProvider("openai");
    try {
      const result = await handleArticleDecision({
        decision,
        slug,
        state,
        libraryDir: this.options.config.libraryDir,
        readArticle: (url) => extractStoryFromUrl(url),
        synthesize: providerSynthesizer(provider),
        enableAlignment: this.options.config.enableAlignment,
      });
      await writeState(this.options.config.statePath, state);
      if (decision === "accept" && result.libraryItem) {
        await this.sendNotification(
          buildArticleReadyNotification(result.libraryItem, this.options.config.publicBaseUrl),
        );
      }
      console.log(`[pirate-radio] decision ${decision} for ${slug}: ${result.status}`);
    } catch (error) {
      await writeState(this.options.config.statePath, state);
      await this.notifyArticleFailure(slug, error);
      console.error(`[pirate-radio] decision ${decision} for ${slug} failed`, error);
    }
  }

  private async getState(): Promise<PirateRadioState> {
    this.state ??= await readState(this.options.config.statePath);
    return this.state;
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/health") {
      json(response, 200, { ok: true });
      return;
    }
    if (request.method === "GET" && url.pathname === "/") {
      html(response, renderReaderHtml());
      return;
    }
    if (request.method === "GET" && url.pathname === "/backlog") {
      html(response, renderBacklogHtml());
      return;
    }
    if (request.method === "GET" && url.pathname === "/admin") {
      html(response, renderAdminHtml());
      return;
    }
    if (request.method === "GET" && url.pathname === "/backlog.json") {
      const articles = await fetchPirateFeed(this.options.config.feedUrl);
      const manifest = await readLibraryManifest(this.options.config.libraryDir);
      json(response, 200, {
        version: 1,
        updatedAt: new Date().toISOString(),
        items: buildBacklogItems({
          articles,
          manifest,
          processingSlugs: this.processingBacklogSlugs,
        }),
      });
      return;
    }
    if (request.method === "POST" && url.pathname.startsWith("/backlog/convert/")) {
      const slug = decodeURIComponent(url.pathname.slice("/backlog/convert/".length));
      const articles = await fetchPirateFeed(this.options.config.feedUrl);
      const manifest = await readLibraryManifest(this.options.config.libraryDir);
      const state = await this.getState();
      const result = await queueBacklogConversion({
        slug,
        articles,
        manifest,
        state,
        statePath: this.options.config.statePath,
        processingSlugs: this.processingBacklogSlugs,
        writeState,
        startConversion: (queuedSlug) => this.decide(queuedSlug, "accept"),
      });
      json(response, result.status === "missing" ? 404 : 200, result);
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/article/")) {
      await renderArticle(response, this.options.config.libraryDir, decodeURIComponent(url.pathname));
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/progress/")) {
      const slug = decodeURIComponent(url.pathname.slice("/progress/".length));
      const progress = await readPlaybackProgress(this.options.config.libraryDir, slug);
      json(response, progress ? 200 : 404, progress ?? { error: "progress_not_found" });
      return;
    }
    if (request.method === "PUT" && url.pathname.startsWith("/progress/")) {
      const slug = decodeURIComponent(url.pathname.slice("/progress/".length));
      try {
        const body = await readJsonBody(request);
        const progress = await writePlaybackProgress(this.options.config.libraryDir, slug, {
          positionSeconds: Number(body.positionSeconds),
          durationSeconds:
            body.durationSeconds == null ? undefined : Number(body.durationSeconds),
        });
        json(response, 200, progress);
      } catch {
        json(response, 400, { error: "bad_progress" });
      }
      return;
    }
    if (request.method === "GET" && url.pathname === "/library.json") {
      json(
        response,
        200,
        filterVoiceExcludedLibraryManifest(await readLibraryManifest(this.options.config.libraryDir)),
      );
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/images/")) {
      await streamLibraryAsset(
        response,
        this.options.config.libraryDir,
        "images",
        decodeURIComponent(url.pathname),
        contentTypeForAsset(basename(url.pathname)),
      );
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/alignment/")) {
      await streamLibraryAsset(
        response,
        this.options.config.libraryDir,
        "alignment",
        decodeURIComponent(url.pathname),
        "application/json",
      );
      return;
    }
    if (
      (request.method === "GET" || request.method === "HEAD") &&
      url.pathname.startsWith("/audio/")
    ) {
      await streamAudio(
        request,
        response,
        this.options.config.libraryDir,
        decodeURIComponent(url.pathname),
        request.method === "HEAD",
      );
      return;
    }
    if (request.method === "POST" && url.pathname.startsWith("/simulate/")) {
      const [, , decision, slug] = url.pathname.split("/");
      if (decision === "refresh" && slug) {
        const regenerateAudio = url.searchParams.get("regenerateAudio") === "true";
        const notify = url.searchParams.get("notify") === "true";
        const provider = regenerateAudio ? createTtsProvider("openai") : undefined;
        const result = await refreshLibraryArticle({
          slug,
          libraryDir: this.options.config.libraryDir,
          readArticle: (articleUrl) => extractStoryFromUrl(articleUrl),
          regenerateAudio,
          synthesize: provider ? providerSynthesizer(provider) : undefined,
        });
        if (notify && result.libraryItem) {
          await this.sendNotification(
            buildArticleReadyNotification(result.libraryItem, this.options.config.publicBaseUrl),
          );
        }
        json(response, result.status === "missing" ? 404 : 200, { ok: result.status !== "missing", ...result });
        return;
      }
      if ((decision === "accept" || decision === "skip") && slug) {
        await this.decide(slug, decision);
        json(response, 200, { ok: true, decision, slug });
        return;
      }
    }
    json(response, 404, { error: "not_found" });
  }

  private async notifyArticleFailure(slug: string, error: unknown): Promise<void> {
    const state = await this.getState();
    const article = findArticleBySlug(state, slug);
    if (!article) {
      return;
    }
    const key = `${slug}:${failureType(error)}`;
    if (this.failureNotifications.has(key)) {
      return;
    }
    this.failureNotifications.add(key);
    await this.sendNotification(
      buildArticleFailureNotification(
        article,
        error,
        this.options.config.publicBaseUrl,
        this.options.config.reauthUrl,
      ),
    );
  }

  private async sendNotification(notification: ArticleNotification): Promise<void> {
    try {
      await this.notifier.send(notification);
    } catch (error) {
      console.error("[pirate-radio] notification failed", error);
    }
  }
}

function findArticleBySlug(state: PirateRadioState, slug: string) {
  const articles = [
    ...Object.values(state.pending),
    ...Object.values(state.seen),
    ...Object.values(state.approved).map((record) => record.article),
    ...Object.values(state.skipped).map((record) => record.article),
  ];
  return articles.find((article) => (article.slug ?? basename(new URL(article.url).pathname)) === slug);
}

async function renderArticle(
  response: ServerResponse,
  libraryDir: string,
  pathname: string,
): Promise<void> {
  const slug = basename(pathname);
  const manifest = await readLibraryManifest(libraryDir);
  const item = manifest.items.find((candidate) => candidate.slug === slug);
  if (!item) {
    json(response, 404, { error: "article_not_found" });
    return;
  }
  const story = JSON.parse(await readFile(item.jsonPath, "utf8"));
  html(response, renderArticleHtml(story, item));
}

async function streamAudio(
  request: IncomingMessage,
  response: ServerResponse,
  libraryDir: string,
  pathname: string,
  headOnly: boolean,
): Promise<void> {
  const filename = basename(pathname);
  const audioPath = resolve(join(libraryDir, "audio", filename));
  const audioRoot = resolve(join(libraryDir, "audio"));
  if (!audioPath.startsWith(audioRoot)) {
    json(response, 400, { error: "bad_audio_path" });
    return;
  }
  try {
    await access(audioPath);
  } catch {
    json(response, 404, { error: "audio_not_found" });
    return;
  }
  const audioSize = (await stat(audioPath)).size;
  const range = parseAudioRange(request.headers.range, audioSize);
  if (range === "invalid") {
    response.writeHead(416, {
      "content-range": `bytes */${audioSize}`,
      "accept-ranges": "bytes",
    });
    response.end();
    return;
  }

  const headers = {
    "content-type": "audio/mpeg",
    "content-length": String(range ? range.end - range.start + 1 : audioSize),
    "accept-ranges": "bytes",
    ...(range ? { "content-range": `bytes ${range.start}-${range.end}/${audioSize}` } : {}),
  };
  response.writeHead(range ? 206 : 200, headers);
  if (headOnly) {
    response.end();
    return;
  }
  createReadStream(audioPath, range ? { start: range.start, end: range.end } : undefined).pipe(
    response,
  );
}

async function streamLibraryAsset(
  response: ServerResponse,
  libraryDir: string,
  directory: "images" | "alignment",
  pathname: string,
  contentType: string,
): Promise<void> {
  const filename = basename(pathname);
  const filePath = resolve(join(libraryDir, directory, filename));
  const root = resolve(join(libraryDir, directory));
  if (!filePath.startsWith(root)) {
    json(response, 400, { error: "bad_asset_path" });
    return;
  }
  try {
    await access(filePath);
  } catch {
    json(response, 404, { error: "asset_not_found" });
    return;
  }
  const size = (await stat(filePath)).size;
  response.writeHead(200, {
    "content-type": contentType,
    "content-length": String(size),
  });
  createReadStream(filePath).pipe(response);
}

export function parseAudioRange(
  rangeHeader: string | undefined,
  size: number,
): { start: number; end: number } | "invalid" | undefined {
  if (!rangeHeader) {
    return undefined;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!match) {
    return "invalid";
  }
  const [, startValue, endValue] = match;
  if (!startValue && !endValue) {
    return "invalid";
  }

  if (!startValue) {
    const suffixLength = Number(endValue);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) {
      return "invalid";
    }
    return {
      start: Math.max(size - suffixLength, 0),
      end: size - 1,
    };
  }

  const start = Number(startValue);
  const end = endValue ? Number(endValue) : size - 1;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start ||
    start >= size
  ) {
    return "invalid";
  }
  return { start, end: Math.min(end, size - 1) };
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(`${JSON.stringify(body)}\n`);
}

function html(response: ServerResponse, body: string): void {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(body);
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 4096) {
      throw new Error("Request body too large");
    }
  }
  return JSON.parse(body || "{}") as Record<string, unknown>;
}

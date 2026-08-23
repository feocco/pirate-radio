import { createReadStream } from "node:fs";
import { access, mkdir, readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { contentTypeForAsset } from "./assets.js";
import { buildBacklogItems, queueBacklogConversion, queueBacklogUrlConversion } from "./backlog.js";
import { filterVoiceExcludedLibraryManifest } from "./articleFilters.js";
import { fetchArticleFeeds, detectNewArticles } from "./feed.js";
import { extractStoryFromUrl } from "./browser.js";
import { OidcAuthenticator, ForbiddenIdentityError, originAllowed, sendAuthenticationRequired, type AuthenticatedRequest, type Authenticator } from "./auth.js";
import { validateIdentityConfig, type PirateRadioConfig } from "./config.js";
import { PirateRadioDatabase, type PirateRadioStore } from "./database.js";
import { HomeAssistantActionListener } from "./haActions.js";
import { archiveLibraryItem, readLibraryManifest } from "./library.js";
import {
  buildArticleFailureNotification,
  buildArticleNotification,
  buildArticleReadyNotification,
  failureType,
  type ArticleNotification,
  type PirateRadioDecision,
} from "./notifications.js";
import { HomelabFunctionsNotifier, type Notifier } from "./notifier.js";
import { renderAdminHtml, renderArticleHtml, renderBacklogHtml, renderReaderHtml } from "./reader.js";
import { getPirateRadioOpenApiDocument, renderPirateRadioDocsHtml } from "./serviceDocs.js";
import {
  baselineNewFeeds,
  readState,
  seenArticleIds,
  writeState,
  type PirateRadioState,
} from "./state.js";
import { createTtsProvider } from "./tts/index.js";
import {
  createCustomTextAudio,
  handleArticleDecision,
  providerSynthesizer,
  refreshLibraryArticle,
  validateCustomTextInput,
} from "./workflow.js";

const MAX_JSON_BODY_CHARS = 128_000;

const shikwasaDistDir = dirname(createRequire(import.meta.url).resolve("shikwasa"));
const SHIKWASA_VENDOR_ASSETS = new Map<string, { fileName: string; contentType: string }>([
  [
    "/vendor/shikwasa/shikwasa.iife.js",
    { fileName: "shikwasa.iife.js", contentType: "text/javascript; charset=utf-8" },
  ],
  ["/vendor/shikwasa/style.css", { fileName: "style.css", contentType: "text/css; charset=utf-8" }],
]);

export interface PirateRadioServiceOptions {
  config: PirateRadioConfig;
  notifier?: Notifier;
  database?: PirateRadioDatabase;
  authenticator?: Authenticator;
}

export interface PirateRadioRequestHandlerOptions {
  config: PirateRadioConfig;
  getState?: () => Promise<PirateRadioState>;
  decide?: (slug: string, decision: PirateRadioDecision, submissionId?: string) => Promise<void>;
  processingSlugs?: Set<string>;
  sendNotification?: (notification: ArticleNotification) => Promise<void>;
  store: PirateRadioStore;
  authenticator: Authenticator;
}

export class PirateRadioService {
  private state?: PirateRadioState;
  private pollTimer?: NodeJS.Timeout;
  private readonly notifier: Notifier;
  private readonly actionListener: HomeAssistantActionListener;
  private readonly failureNotifications = new Set<string>();
  private readonly processingBacklogSlugs = new Set<string>();
  private database?: PirateRadioDatabase;
  private authenticator?: Authenticator;

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
    validateIdentityConfig(this.options.config);
    await mkdir(this.options.config.libraryDir, { recursive: true });
    this.state = await readState(this.options.config.statePath);
    this.database = this.options.database ?? new PirateRadioDatabase(this.options.config.databaseUrl!);
    await this.database.migrate();
    this.authenticator = this.options.authenticator ?? new OidcAuthenticator(this.options.config, this.database);
    await this.authenticator.initialize();
    const requestHandler = createPirateRadioRequestHandler({
      config: this.options.config,
      getState: () => this.getState(),
      decide: (slug, decision) => this.decide(slug, decision),
      processingSlugs: this.processingBacklogSlugs,
      sendNotification: (notification) => this.sendNotification(notification),
      store: this.database,
      authenticator: this.authenticator,
    });
    const server = createServer((request, response) => {
      void requestHandler(request, response).catch((error) => {
        console.error("[pirate-radio] request failed", error);
        if (!response.headersSent) json(response, 500, { error: "internal_error" });
        else response.end();
      });
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
    const articles = await fetchArticleFeeds(this.options.config.feeds);
    const baselines = baselineNewFeeds(state, articles, this.options.config.feeds);
    for (const baseline of baselines) {
      console.log(
        `[pirate-radio] baselined ${baseline.articleCount} existing articles for new feed ${baseline.feedId}`,
      );
    }
    const unseen = detectNewArticles(articles, seenArticleIds(state));
    const toNotify = unseen.slice(0, this.options.config.maxNotificationsPerPoll);

    for (const article of toNotify) {
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

  async decide(slug: string, decision: PirateRadioDecision, submissionId?: string): Promise<void> {
    const state = await this.getState();
    const provider = createTtsProvider("xai");
    let effectiveSubmissionId = submissionId;
    if (!effectiveSubmissionId && decision === "accept" && this.database) {
      const article = findArticleBySlug(state, slug);
      effectiveSubmissionId = (await this.database.createSubmission({
        slug,
        type: "automated",
        title: article?.title,
        sourceUrl: article?.url,
      })).id;
      await this.database.updateSubmission(effectiveSubmissionId, "processing");
    }
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
      if (effectiveSubmissionId && this.database) {
        await this.database.updateSubmission(effectiveSubmissionId, result.status === "accepted" ? "succeeded" : "failed", {
          slug: result.libraryItem?.slug ?? slug,
          ...(result.status === "accepted" ? {} : { error: result.status }),
        });
      }
      if (decision === "accept" && result.libraryItem) {
        await this.sendNotification(
          buildArticleReadyNotification(result.libraryItem, this.options.config.publicBaseUrl),
        );
      }
      console.log(`[pirate-radio] decision ${decision} for ${slug}: ${result.status}`);
    } catch (error) {
      await writeState(this.options.config.statePath, state);
      if (effectiveSubmissionId && this.database) {
        await this.database.updateSubmission(effectiveSubmissionId, "failed", { error: error instanceof Error ? error.message : String(error) });
      }
      await this.notifyArticleFailure(slug, error);
      console.error(`[pirate-radio] decision ${decision} for ${slug} failed`, error);
    }
  }

  private async getState(): Promise<PirateRadioState> {
    this.state ??= await readState(this.options.config.statePath);
    return this.state;
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

export function createPirateRadioRequestHandler(options: PirateRadioRequestHandlerOptions) {
  const getState = options.getState ?? missingRouteDependency<PirateRadioState>("getState");
  const decide = options.decide ?? missingRouteDependency<void>("decide");
  const processingSlugs = options.processingSlugs ?? new Set<string>();
  const sendNotification = options.sendNotification ?? (async () => {});

  return async function handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", options.config.publicBaseUrl);
    if (request.method === "GET" && url.pathname === "/health") {
      json(response, 200, { ok: true });
      return;
    }
    if (request.method === "GET" && url.pathname === "/auth/login") {
      const result = await options.authenticator.login(url);
      response.writeHead(302, { location: result.location, "set-cookie": result.transactionCookie, "cache-control": "no-store" });
      response.end();
      return;
    }
    if (request.method === "GET" && url.pathname === "/auth/callback") {
      try {
        const result = await options.authenticator.callback(url, request.headers.cookie);
        response.writeHead(302, {
          location: result.returnTo,
          "set-cookie": [result.sessionCookie, result.transactionCookie],
          "cache-control": "no-store",
        });
        response.end();
      } catch (error) {
        if (error instanceof ForbiddenIdentityError) {
          json(response, 403, { error: "membership_required" });
        } else {
          json(response, 400, { error: "invalid_oidc_callback" });
        }
      }
      return;
    }

    if (!originAllowed(request, options.config.publicBaseUrl)) {
      json(response, 403, { error: "invalid_origin" });
      return;
    }
    const principal = await options.authenticator.authenticate(request.headers.cookie);
    if (!principal) {
      sendAuthenticationRequired(response, request);
      return;
    }
    if (request.method === "GET" && url.pathname === "/auth/me") {
      json(response, 200, publicPrincipal(principal));
      return;
    }
    if (request.method === "POST" && url.pathname === "/auth/logout") {
      const result = await options.authenticator.logout(request.headers.cookie);
      response.writeHead(303, {
        location: result.location,
        "set-cookie": result.sessionCookie,
        "cache-control": "no-store",
      });
      response.end();
      return;
    }
    if (adminPath(url.pathname) && !principal.isAdmin) {
      json(response, 403, { error: "admin_required" });
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/vendor/shikwasa/")) {
      const asset = SHIKWASA_VENDOR_ASSETS.get(url.pathname);
      if (!asset) {
        json(response, 404, { error: "not_found" });
        return;
      }
      const filePath = join(shikwasaDistDir, asset.fileName);
      const body = await readFile(filePath);
      response.writeHead(200, {
        "content-type": asset.contentType,
        "content-length": String(body.byteLength),
        "cache-control": "private, max-age=86400",
      });
      response.end(body);
      return;
    }
    if (request.method === "GET" && url.pathname === "/docs") {
      html(response, renderPirateRadioDocsHtml());
      return;
    }
    if (request.method === "GET" && url.pathname === "/openapi.json") {
      json(response, 200, getPirateRadioOpenApiDocument());
      return;
    }
    if (request.method === "GET" && url.pathname === "/") {
      html(response, renderReaderHtml(principal.user, options.config.identitySettingsUrl));
      return;
    }
    if (request.method === "GET" && (url.pathname === "/queue" || url.pathname === "/backlog")) {
      html(response, renderBacklogHtml(principal.user, options.config.identitySettingsUrl));
      return;
    }
    if (request.method === "GET" && url.pathname === "/admin") {
      html(response, renderAdminHtml(principal.user, options.config.identitySettingsUrl));
      return;
    }
    if (request.method === "GET" && (url.pathname === "/queue.json" || url.pathname === "/backlog.json")) {
      const articles = await fetchArticleFeeds(options.config.feeds);
      const manifest = await readLibraryManifest(options.config.libraryDir);
      json(response, 200, {
        version: 1,
        updatedAt: new Date().toISOString(),
        items: buildBacklogItems({
          articles,
          manifest,
          processingSlugs,
        }),
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/submissions.json") {
      json(response, 200, { version: 1, items: await options.store.submissions() });
      return;
    }
    if (request.method === "POST" && queueConvertSlug(url.pathname)) {
      const slug = decodeURIComponent(queueConvertSlug(url.pathname) ?? "");
      const articles = await fetchArticleFeeds(options.config.feeds);
      const manifest = await readLibraryManifest(options.config.libraryDir);
      const state = await getState();
      const article = findArticleBySlug(state, slug) ?? articles.find((candidate) => candidate.slug === slug);
      const submission = await options.store.createSubmission({
        slug,
        type: "feed",
        title: article?.title,
        sourceUrl: article?.url,
        submittedBy: principal.user,
      });
      const result = await queueBacklogConversion({
        slug,
        articles,
        manifest,
        state,
        statePath: options.config.statePath,
        processingSlugs,
        writeState,
        startConversion: async (queuedSlug) => {
          await options.store.updateSubmission(submission.id, "processing");
          await decide(queuedSlug, "accept", submission.id);
        },
      });
      if (result.status === "missing") await options.store.updateSubmission(submission.id, "failed", { error: "missing" });
      if (result.status === "converted") await options.store.updateSubmission(submission.id, "succeeded");
      if (result.status === "processing") await options.store.updateSubmission(submission.id, "processing");
      json(response, result.status === "missing" ? 404 : 200, result);
      return;
    }
    if (
      request.method === "POST" &&
      (url.pathname === "/queue/convert-url" || url.pathname === "/backlog/convert-url")
    ) {
      try {
        const body = await readJsonBody(request);
        const submittedUrl = String(body.url ?? "");
        const submission = await options.store.createSubmission({ type: "url", sourceUrl: submittedUrl, submittedBy: principal.user });
        const manifest = await readLibraryManifest(options.config.libraryDir);
        const state = await getState();
        const result = await queueBacklogUrlConversion({
          url: submittedUrl,
          manifest,
          state,
          statePath: options.config.statePath,
          processingSlugs,
          writeState,
          startConversion: async (queuedSlug) => {
            await options.store.updateSubmission(submission.id, "processing", { slug: queuedSlug });
            await decide(queuedSlug, "accept", submission.id);
          },
        });
        if (!result.ok) await options.store.updateSubmission(submission.id, "failed", { error: result.error });
        if (result.ok && result.status === "converted") await options.store.updateSubmission(submission.id, "succeeded", { slug: result.slug });
        if (result.ok && result.status === "processing") await options.store.updateSubmission(submission.id, "processing", { slug: result.slug });
        json(response, result.ok ? 200 : 400, result);
      } catch {
        json(response, 400, {
          ok: false,
          status: "invalid_url",
          error: "Enter a valid URL.",
        });
      }
      return;
    }
    if (
      request.method === "POST" &&
      (url.pathname === "/queue/convert-text" || url.pathname === "/backlog/convert-text")
    ) {
      try {
        const body = await readJsonBody(request);
        const validation = validateCustomTextInput({
          title: String(body.title ?? ""),
          text: String(body.text ?? ""),
        });
        if (!validation.ok) {
          json(response, 400, { ok: false, status: "invalid_text", error: validation.error });
          return;
        }
        const submission = await options.store.createSubmission({
          type: "custom_text",
          title: validation.title,
          submittedBy: principal.user,
        });
        await options.store.updateSubmission(submission.id, "processing");
        const provider = createTtsProvider("xai");
        void createCustomTextAudio({
          title: validation.title,
          text: validation.text,
          libraryDir: options.config.libraryDir,
          synthesize: providerSynthesizer(provider),
          enableAlignment: options.config.enableAlignment,
        })
          .then(async (result) => {
            await options.store.updateSubmission(submission.id, "succeeded", { slug: result.libraryItem.slug });
            await sendNotification(buildArticleReadyNotification(result.libraryItem, options.config.publicBaseUrl));
          })
          .catch(async (error) => {
            await options.store.updateSubmission(submission.id, "failed", { error: error instanceof Error ? error.message : String(error) });
            await sendNotification(
              buildArticleFailureNotification(
                {
                  id: `custom-text:${validation.title}`,
                  title: validation.title,
                  url: `custom-text://local/${encodeURIComponent(validation.title)}`,
                  author: "",
                  publishedAt: "",
                  description: "",
                },
                error,
                options.config.publicBaseUrl,
              ),
            );
          });
        json(response, 200, { ok: true, status: "queued" });
      } catch (error) {
        json(response, 400, {
          ok: false,
          status: "invalid_text",
          error:
            error instanceof Error && error.message === "Request body too large"
              ? "Request body too large."
              : "Enter text to convert.",
        });
      }
      return;
    }
    if (request.method === "POST" && deleteArticleSlug(url.pathname)) {
      const slug = decodeURIComponent(deleteArticleSlug(url.pathname) ?? "");
      const archived = await archiveLibraryItem(
        options.config.libraryDir,
        slug,
        principal.user.username,
      );
      if (!archived) {
        json(response, 404, { error: "article_not_found" });
        return;
      }
      console.log(`[pirate-radio] archived article ${slug} by ${principal.user.username}`);
      response.writeHead(303, { location: "/", "cache-control": "no-store" });
      response.end();
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/article/")) {
      await renderArticle(
        response,
        options.config.libraryDir,
        decodeURIComponent(url.pathname),
        options.store,
        principal.user,
        principal.isAdmin,
        options.config.identitySettingsUrl,
      );
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/progress/")) {
      const slug = decodeURIComponent(url.pathname.slice("/progress/".length));
      const progress = await options.store.progress(principal.user.id, slug);
      json(response, progress ? 200 : 404, progress ?? { error: "progress_not_found" });
      return;
    }
    if (request.method === "PUT" && url.pathname.startsWith("/progress/")) {
      const slug = decodeURIComponent(url.pathname.slice("/progress/".length));
      try {
        const body = await readJsonBody(request);
        const progress = await options.store.saveProgress(
          principal.user.id,
          slug,
          Number(body.positionSeconds),
          body.durationSeconds == null ? undefined : Number(body.durationSeconds),
          body.ended === true,
        );
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
        filterVoiceExcludedLibraryManifest(await readLibraryManifest(options.config.libraryDir)),
      );
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/images/")) {
      await streamLibraryAsset(
        response,
        options.config.libraryDir,
        "images",
        decodeURIComponent(url.pathname),
        contentTypeForAsset(basename(url.pathname)),
      );
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/alignment/")) {
      await streamLibraryAsset(
        response,
        options.config.libraryDir,
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
        options.config.libraryDir,
        decodeURIComponent(url.pathname),
        request.method === "HEAD",
      );
      return;
    }
    if (request.method === "POST" && url.pathname.startsWith("/simulate/")) {
      const [, , decisionName, slug] = url.pathname.split("/");
      if (decisionName === "refresh" && slug) {
        const regenerateAudio = url.searchParams.get("regenerateAudio") === "true";
        const notify = url.searchParams.get("notify") === "true";
        const provider = regenerateAudio ? createTtsProvider("xai") : undefined;
        const result = await refreshLibraryArticle({
          slug,
          libraryDir: options.config.libraryDir,
          readArticle: (articleUrl) => extractStoryFromUrl(articleUrl),
          regenerateAudio,
          synthesize: provider ? providerSynthesizer(provider) : undefined,
        });
        if (notify && result.libraryItem) {
          await sendNotification(
            buildArticleReadyNotification(result.libraryItem, options.config.publicBaseUrl),
          );
        }
        json(response, result.status === "missing" ? 404 : 200, {
          ok: result.status !== "missing",
          ...result,
        });
        return;
      }
      if ((decisionName === "accept" || decisionName === "skip") && slug) {
        await decide(slug, decisionName);
        json(response, 200, { ok: true, decision: decisionName, slug });
        return;
      }
    }
    json(response, 404, { error: "not_found" });
  };
}

function adminPath(pathname: string): boolean {
  return pathname === "/admin" || pathname.startsWith("/admin/") || pathname.startsWith("/simulate/");
}

function publicPrincipal(principal: AuthenticatedRequest) {
  return {
    id: principal.user.id,
    username: principal.user.username,
    displayName: principal.user.displayName,
    email: principal.user.email,
    groups: principal.user.groups,
    isAdmin: principal.isAdmin,
  };
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

function queueConvertSlug(pathname: string): string | undefined {
  if (pathname.startsWith("/queue/convert/")) {
    return pathname.slice("/queue/convert/".length);
  }
  if (pathname.startsWith("/backlog/convert/")) {
    return pathname.slice("/backlog/convert/".length);
  }
  return undefined;
}

function deleteArticleSlug(pathname: string): string | undefined {
  const match = pathname.match(/^\/admin\/articles\/([^/]+)\/delete$/);
  return match?.[1];
}

async function renderArticle(
  response: ServerResponse,
  libraryDir: string,
  pathname: string,
  store: PirateRadioStore,
  user: AuthenticatedRequest["user"],
  isAdmin: boolean,
  identitySettingsUrl?: string,
): Promise<void> {
  const slug = basename(pathname);
  const manifest = await readLibraryManifest(libraryDir);
  const item = manifest.items.find((candidate) => candidate.slug === slug);
  if (!item) {
    json(response, 404, { error: "article_not_found" });
    return;
  }
  const story = JSON.parse(await readFile(item.jsonPath, "utf8"));
  const [completedUsers, submittedBy] = await Promise.all([
    store.completedUsers(slug),
    store.firstSuccessfulSubmitter(slug),
  ]);
  html(response, renderArticleHtml(story, item, { user, isAdmin, completedUsers, submittedBy, identitySettingsUrl }));
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
    if (body.length > MAX_JSON_BODY_CHARS) {
      throw new Error("Request body too large");
    }
  }
  return JSON.parse(body || "{}") as Record<string, unknown>;
}

function missingRouteDependency<T>(name: string) {
  return async (): Promise<T> => {
    throw new Error(`Missing route dependency: ${name}`);
  };
}

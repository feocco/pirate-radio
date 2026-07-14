import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ArticleFeedConfig, PirateArticle } from "./feed.js";
const stateWriteQueues = new Map<string, Promise<void>>();

export interface ArticleDecisionRecord {
  article: PirateArticle;
  decidedAt: string;
}

export interface PirateRadioState {
  initialized: boolean;
  initializedFeedIds: string[];
  seen: Record<string, PirateArticle>;
  pending: Record<string, PirateArticle>;
  approved: Record<string, ArticleDecisionRecord>;
  skipped: Record<string, ArticleDecisionRecord>;
}

export function createInitialState(): PirateRadioState {
  return {
    initialized: false,
    initializedFeedIds: [],
    seen: {},
    pending: {},
    approved: {},
    skipped: {},
  };
}

export async function readState(statePath: string): Promise<PirateRadioState> {
  try {
    const state = JSON.parse(await readFile(statePath, "utf8")) as PirateRadioState;
    state.initialized ??= false;
    state.initializedFeedIds ??= [];
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return createInitialState();
    }
    throw error;
  }
}

export interface FeedBaseline {
  feedId: string;
  articleCount: number;
}

export function baselineNewFeeds(
  state: PirateRadioState,
  articles: PirateArticle[],
  feeds: ArticleFeedConfig[],
): FeedBaseline[] {
  const initializedFeedIds = new Set(state.initializedFeedIds);
  const newFeedIds = feeds.map((feed) => feed.id).filter((feedId) => !initializedFeedIds.has(feedId));

  const baselines = newFeedIds.map((feedId) => {
    const feedArticles = articles.filter((article) => article.sourceId === feedId);
    for (const article of feedArticles) {
      state.seen[article.id] = article;
    }
    return { feedId, articleCount: feedArticles.length };
  });

  state.initializedFeedIds.push(...newFeedIds);
  return baselines;
}

export async function writeState(statePath: string, state: PirateRadioState): Promise<void> {
  const previous = stateWriteQueues.get(statePath) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    await mkdir(dirname(statePath), { recursive: true });
    const temporary = `${statePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(temporary, statePath);
  });
  stateWriteQueues.set(statePath, next);
  try {
    await next;
  } finally {
    if (stateWriteQueues.get(statePath) === next) stateWriteQueues.delete(statePath);
  }
}

export function seenArticleIds(state: PirateRadioState): Set<string> {
  return new Set([
    ...Object.keys(state.seen),
    ...Object.keys(state.approved),
    ...Object.keys(state.skipped),
  ]);
}

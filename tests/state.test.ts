import { describe, expect, test } from "vitest";
import type { ArticleFeedConfig, PirateArticle } from "../src/feed.js";
import { detectNewArticles } from "../src/feed.js";
import { baselineNewFeeds, createInitialState, seenArticleIds } from "../src/state.js";

const feeds: ArticleFeedConfig[] = [
  { id: "pirate-wires", name: "Pirate Wires", type: "pirate-wires", url: "https://pirate.test/feed" },
  { id: "hyperdimensional", name: "Hyperdimensional", type: "substack", url: "https://hyper.test/feed" },
];

function article(id: string, sourceId: string): PirateArticle {
  return {
    id,
    title: id,
    url: `https://example.test/${id}`,
    author: "",
    publishedAt: "",
    description: "",
    sourceId,
  };
}

describe("feed state baselines", () => {
  test("baselines all existing articles on first startup", () => {
    const state = createInitialState();
    const articles = [article("pirate-old", "pirate-wires"), article("hyper-old", "hyperdimensional")];

    expect(baselineNewFeeds(state, articles, feeds)).toEqual([
      { feedId: "pirate-wires", articleCount: 1 },
      { feedId: "hyperdimensional", articleCount: 1 },
    ]);
    expect(detectNewArticles(articles, seenArticleIds(state))).toEqual([]);
  });

  test("baselines history only for a newly added feed", () => {
    const state = createInitialState();
    state.initializedFeedIds = ["pirate-wires"];
    const articles = [article("pirate-new", "pirate-wires"), article("hyper-old", "hyperdimensional")];

    expect(baselineNewFeeds(state, articles, feeds)).toEqual([
      { feedId: "hyperdimensional", articleCount: 1 },
    ]);
    expect(detectNewArticles(articles, seenArticleIds(state)).map((item) => item.id)).toEqual([
      "pirate-new",
    ]);
  });

  test("detects articles published after a feed has been baselined", () => {
    const state = createInitialState();
    const oldArticle = article("hyper-old", "hyperdimensional");
    baselineNewFeeds(state, [oldArticle], [feeds[1]]);

    const newArticle = article("hyper-new", "hyperdimensional");
    expect(baselineNewFeeds(state, [newArticle, oldArticle], [feeds[1]])).toEqual([]);
    expect(detectNewArticles([newArticle, oldArticle], seenArticleIds(state))).toEqual([newArticle]);
  });
});

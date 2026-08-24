import { describe, expect, test } from "vitest";
import {
  renderAdminHtml,
  renderArticleHtml,
  renderBacklogHtml,
  renderReaderHtml,
} from "../src/reader.js";
import {
  mediaPlayerTrack,
  renderMediaPlayerClient,
  serializeMediaPlayerTrackForScript,
} from "../src/mediaPlayer.js";
import { ACCENT } from "../src/theme.js";
import type { LibraryItem } from "../src/library.js";
import type { Story } from "../src/types.js";
import { adminUser, memberUser } from "./support/fakes.js";

describe("reader page", () => {
  const articleStory: Story = {
    sourceUrl: "https://www.piratewires.com/p/test-story",
    title: "The Test Story",
    tagline: "A sharp test tagline.",
    heroImageOriginalUrl: "https://cdn.example.com/original.png",
    heroImageUrl: "/images/test-story.png",
    sectionTitles: ["A Section"],
    contentBlocks: [
      { type: "heading", text: "A Section" },
      { type: "paragraph", text: "First paragraph." },
    ],
    text: "A Section\n\nFirst paragraph.",
    wordCount: 4,
    characterCount: 27,
    extractedAt: "2026-06-23T01:00:00.000Z",
  };
  const articleItem: LibraryItem = {
    slug: "test-story",
    title: articleStory.title,
    sourceUrl: articleStory.sourceUrl,
    publishedAt: "Tue, 23 Jun 2026 12:00:00 GMT",
    generatedAt: "2026-06-23T12:01:00.000Z",
    audioPath: "/data/library/audio/test-story.mp3",
    audioUrl: "/audio/test-story.mp3",
    jsonPath: "/data/library/stories/test-story.json",
    textPath: "/data/library/text/test-story.txt",
    imagePath: "/data/library/images/test-story.png",
    imageUrl: "/images/test-story.png",
    alignmentPath: "/data/library/alignment/test-story.json",
    alignmentUrl: "/alignment/test-story.json",
    hasAlignment: true,
    tagline: articleStory.tagline,
    sectionTitles: articleStory.sectionTitles,
    estimatedCostUsd: 0.01,
    wordCount: articleStory.wordCount,
    characterCount: articleStory.characterCount,
    audioBytes: 1024,
  };

  function expectSharedPlayer(html: string) {
    expect(html).toContain('/vendor/shikwasa/style.css');
    expect(html).toContain('/vendor/shikwasa/shikwasa.iife.js');
    expect(html).toContain("mountMediaPlayer");
    expect(html).toContain('fixed: { type: "static" }');
    expect(html).toContain(`themeColor: "${ACCENT}"`);
    expect(html).toContain("--color-primary: var(--accent) !important;");
    expect(html).toContain("escapePlayerText(track.title)");
    expect(html).toContain("escapePlayerText(track.sourceName)");
    expect(html).toContain('url.startsWith("/images/")');
    expect(html).toContain("pirate-radio-position:");
    expect(html).toContain("/progress/");
    expect(html).toContain("saveProgress");
    expect(html).toContain("setTimeout(write, 2500)");
    expect(html).toContain("saveProgress(track.slug, audio, true, true)");
    expect(html).toContain("typeof player.initMediaSession === \"function\"");
    expect(html).toContain("player.initMediaSession()");
    expect(html).toContain("audio.disableRemotePlayback = false");
    expect(html).toContain("function attachCastControl");
    expect(html).toContain("window.dispatchEvent(new Event(\"resize\"))");
    expect(html).toContain(".media-player { margin-top: 14px; width: 100%; max-width: 100%; min-width: 0; }");
    expect(html).toContain(".media-player .shk { width: 100%; max-width: 100%; min-width: 0; box-sizing: border-box; }");
    expect(html).toContain(".media-player .shk-controls { max-width: 100%; }");
    expect(html).toContain(".item, .item > *, .player-panel { min-width: 0; max-width: 100%; }");
    expect(html).toContain(".wrap { width: min(1180px, calc(100% - 32px)); max-width: 100%; margin: 0 auto; }");
    expect(html).toContain("function destroy()");
    expect(html).toContain("player.destroy()");
    expect(html).not.toContain('createElement("audio")');
    expect(html).not.toContain("<audio");
    expect(html).not.toContain('controls = true');
    expect(html).not.toContain("skipButton");
    expect(html).not.toContain("appendSkipControls");
    expect(html).not.toContain(".skip-button");
    expect(html).not.toContain("skipSeconds");
  }

  test("renders an audio reader that persists playback position in localStorage", () => {
    const html = renderReaderHtml();

    expectSharedPlayer(html);
    expect(html).toContain("/library.json");
    expect(html).toContain("localStorage");
    expect(html).toContain("source-filter");
    expect(html).toContain("sort-order");
    expect(html).toContain("filterLibraryItems");
    expect(html).toContain("sortLibraryItems");
    expect(html).toContain("Newest conversion");
    expect(html).toContain("Article date");
    expect(html).toContain("item.imageUrl");
    expect(html).toContain("mountMediaPlayer(playerHost, mediaPlayerTrack(item))");
    expect(html).toContain('playerHost.className = "media-player compact"');
    expect(html).toContain("controls.append(actions, playerHost)");
    expect(html).toContain(".media-player.compact .shk-controls { margin: 0; width: auto; }");
    expect(html).toContain("libraryPlayers.push(mountMediaPlayer(playerHost, mediaPlayerTrack(item)))");
    expect(html).toContain("destroyLibraryPlayers()");
    expect(html).toContain("mounted.destroy()");
    expect(html).toContain('item.author ? "By " + item.author : ""');
    expect(html).toContain('"/article/" + encodeURIComponent(item.slug)');
    expect(html).toContain("downloadLink.download = item.slug + \".mp3\"");
    expect(html).toContain("Read");
    expect(html).toContain("Download MP3");
    expect(html).toContain("Pirate Radio");
    expect(html).toContain('<span class="mark">PR</span>');
    expect(html).not.toContain('<section class="hero wrap">');
    expect(html).not.toContain("Audio dispatches");
    expect(html).not.toContain("A private audio reader for dispatches from across the web");
    expect(html).toContain('href="/queue"');
    expect(html).toContain('href="/admin"');
    expect(html).toContain('<a class="brandlink active" href="/" aria-label="Pirate Radio home">');
    expect(html).not.toContain('href="/">Pirate Wires</a>');
    expect(html).not.toContain("Culture");
  });

  test("uses the same Shikwasa mount and vendor assets on library and article pages", () => {
    const libraryHtml = renderReaderHtml();
    const articleHtml = renderArticleHtml(articleStory, articleItem);
    expectSharedPlayer(libraryHtml);
    expectSharedPlayer(articleHtml);
    expect(articleHtml).toContain('id="article-player"');
    expect(articleHtml).toContain("const { audio } = mountMediaPlayer(");
    expect(articleHtml).toContain('"title":"The Test Story"');
    expect(articleHtml).toContain('"sourceName":"Unknown Source"');
    expect(articleHtml).toContain('"audioUrl":"/audio/test-story.mp3"');
    expect(libraryHtml).toContain("mediaPlayerTrack(item)");
  });

  test("escapes hostile title and source metadata before Shikwasa innerHTML assignment", () => {
    const hostile = "</script><img src=x onerror=alert(1)>";
    const story: Story = {
      ...articleStory,
      title: hostile,
      text: "Body",
      contentBlocks: [{ type: "paragraph", text: "Body" }],
    };
    const item: LibraryItem = {
      ...articleItem,
      title: hostile,
      sourceName: hostile,
      imageUrl: "https://evil.example/cover.png",
      hasAlignment: false,
      alignmentUrl: undefined,
    };

    const track = mediaPlayerTrack(item);
    expect(track).toEqual({
      slug: item.slug,
      title: hostile,
      sourceName: hostile,
      audioUrl: item.audioUrl,
    });
    expect(track.coverUrl).toBeUndefined();

    const serialized = serializeMediaPlayerTrackForScript(track);
    expect(serialized).toContain("\\u003c/script\\u003e");
    expect(serialized).toContain("\\u003cimg");
    expect(serialized).not.toContain("</script>");
    expect(serialized).not.toContain("<img");
    expect(JSON.parse(serialized)).toEqual(track);

    const html = renderArticleHtml(story, item);
    expect(html).toContain(serialized);
    expect(html).not.toContain(hostile);
    expect(html).not.toContain("</script><img");
    expect(html).toContain("const title = escapePlayerText(track.title)");
    expect(html).toContain("const artist = escapePlayerText(track.sourceName)");
    expect(html).toContain("trustedCoverUrl(track.coverUrl)");
    expect(html).not.toContain(`title: "${hostile}"`);
    expect(html).not.toContain(`artist: "${hostile}"`);
    expect(renderMediaPlayerClient()).toContain("escapePlayerText(track.title)");
  });

  test("destroys library players before sort or filter rerenders and reactivates media session on play", () => {
    const html = renderReaderHtml();
    expect(html).toContain("let libraryPlayers = []");
    expect(html).toContain("function destroyLibraryPlayers()");
    expect(html).toContain("for (const mounted of libraryPlayers)");
    expect(html).toContain("mounted.destroy()");
    expect(html).toContain("libraryPlayers = []");
    expect(html).toContain("destroyLibraryPlayers();\n      root.textContent = \"\"");
    expect(html).toContain("libraryPlayers.push(mountMediaPlayer(playerHost, mediaPlayerTrack(item)))");
    expect(html).toContain("audio.addEventListener(\"play\", onPlay)");
    expect(html).toContain("if (typeof player.initMediaSession === \"function\") player.initMediaSession()");
    expect(html).toContain("window.removeEventListener(\"pagehide\", onPageHide)");
    expect(html).toContain("clearTimeout(progressTimers.get(track.slug))");
    expect(html).toContain("progressTimers.delete(track.slug)");
    expect(html).toContain("player.destroy()");
  });

  test("persists progress immediately on seeked and removes the seeked listener on destroy", () => {
    const client = renderMediaPlayerClient();
    expect(client).toContain("const onSeeked = () => saveProgress(track.slug, audio, true)");
    expect(client).toContain('audio.addEventListener("seeked", onSeeked)');
    expect(client).toContain('audio.removeEventListener("seeked", onSeeked)');
    const html = renderReaderHtml();
    expect(html).toContain("const onSeeked = () => saveProgress(track.slug, audio, true)");
    expect(html).toContain('audio.addEventListener("seeked", onSeeked)');
    expect(html).toContain('audio.removeEventListener("seeked", onSeeked)');
  });

  test("renders a compact account menu with central profile and native logout actions", () => {
    const html = renderReaderHtml(memberUser, "https://auth.example.com/if/user/#/settings");

    expect(html).toContain('class="account-menu"');
    expect(html).toContain("Account menu for member");
    expect(html).toContain('class="account-avatar"');
    expect(html).toContain('href="https://auth.example.com/if/user/#/settings"');
    expect(html).toContain(">Edit profile</a>");
    expect(html).toContain('method="post" action="/auth/logout"');
    expect(html).not.toContain('location.href = "/auth/login"');
  });

  test("renders a queue page with search, pagination, and convert controls", () => {
    const html = renderBacklogHtml();

    expect(html).toContain("/queue.json");
    expect(html).toContain("/queue/convert/");
    expect(html).toContain("/queue/convert-url");
    expect(html).toContain("/queue/convert-text");
    expect(html).toContain("Paste an article URL (Pirate Wires, Substack, or X).");
    expect(html).toContain("Custom text title");
    expect(html).toContain("Paste text to convert");
    expect(html).toContain("queueText");
    expect(html).toContain("queueUrl");
    expect(html).toContain("queue-list");
    expect(html).toContain("queue-row");
    expect(html).toContain("All recent");
    expect(html).toContain("Search");
    expect(html).toContain("Convert");
    expect(html).toContain("pageSize = 10");
    expect(html).not.toContain('placeholder.textContent = "PW"');
    expect(html).toContain('<a class="navlink active" href="/queue" aria-current="page">Queue</a>');
    expect(html).toContain('<a class="brandlink" href="/" aria-label="Pirate Radio home">');
  });

  test("renders source names when article metadata includes them", () => {
    const story: Story = {
      sourceUrl: "https://www.hyperdimensional.co/p/what-should-be-done",
      title: "What Should Be Done",
      author: "Dean W. Ball",
      tagline: "How to get past improvised model licensing",
      text: "Body paragraph.",
      wordCount: 2,
      characterCount: 15,
      extractedAt: "2026-07-13T00:00:00.000Z",
    };
    const item: LibraryItem = {
      slug: "what-should-be-done",
      title: story.title,
      author: story.author,
      sourceUrl: story.sourceUrl,
      sourceType: "substack",
      sourceName: "Hyperdimensional",
      canonicalUrl: story.sourceUrl,
      publishedAt: "Fri, 26 Jun 2026 11:45:17 GMT",
      generatedAt: "2026-07-13T00:00:00.000Z",
      audioPath: "/tmp/audio.mp3",
      audioUrl: "/audio/what-should-be-done.mp3",
      jsonPath: "/tmp/story.json",
      textPath: "/tmp/story.txt",
      estimatedCostUsd: 0.01,
      wordCount: 2,
      characterCount: 15,
      audioBytes: 100,
    };

    const html = renderArticleHtml(story, item);

    expect(html).toContain("Hyperdimensional");
    expect(html).toContain("By Dean W. Ball");
    expect(html).toContain('"sourceName":"Hyperdimensional"');
    expect(html).toContain('"title":"What Should Be Done"');
  });

  test("renders an admin page with the admin nav tab active", () => {
    const html = renderAdminHtml();

    expect(html).toContain("<h1>Admin</h1>");
    expect(html).toContain("/health");
    expect(html).toContain("/library.json");
    expect(html).toContain("/queue.json");
    expect(html).toContain('<a class="navlink active" href="/admin" aria-current="page">Admin</a>');
    expect(html).not.toContain("Culture");
  });

  test("renders a dedicated article page with image, audio, text blocks, and optional alignment", () => {
    const story = articleStory;
    const item = articleItem;

    const html = renderArticleHtml(story, item);

    expect(html).toContain("The Test Story");
    expect(html).toContain("A sharp test tagline.");
    expect(html).toContain("/images/test-story.png");
    expect(html).toContain("/audio/test-story.mp3");
    expect(html).toContain("/progress/");
    expect(html).toContain("saveProgress");
    expect(html).toContain('download="test-story.mp3"');
    expect(html).toContain("Download MP3");
    expect(html).toContain("/alignment/test-story.json");
    expect(html).toContain("const { audio } = mountMediaPlayer(");
    expect(html).toContain("audio.addEventListener(\"timeupdate\"");
    expect(html).toContain("data-word-index");
    expect(html).toContain("A Section");
    expect(html).toContain(">First</span>");
    expect(html).toContain(">paragraph.</span>");

    const adminHtml = renderArticleHtml(story, item, { user: adminUser, isAdmin: true });
    const memberHtml = renderArticleHtml(story, item, { user: memberUser, isAdmin: false });
    expect(adminHtml).toContain(`/admin/articles/${item.slug}/delete`);
    expect(adminHtml).toContain("Delete article");
    expect(adminHtml).toContain("window.confirm");
    expect(memberHtml).not.toContain("Delete article");
  });
});

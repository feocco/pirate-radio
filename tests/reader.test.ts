import { describe, expect, test } from "vitest";
import {
  renderAdminHtml,
  renderArticleHtml,
  renderBacklogHtml,
  renderReaderHtml,
} from "../src/reader.js";
import type { LibraryItem } from "../src/library.js";
import type { Story } from "../src/types.js";
import { adminUser, memberUser } from "./support/fakes.js";

describe("reader page", () => {
  test("renders an audio reader that persists playback position in localStorage", () => {
    const html = renderReaderHtml();

    expect(html).toContain('createElement("audio")');
    expect(html).toContain("/library.json");
    expect(html).toContain("localStorage");
    expect(html).toContain("pirate-radio-position:");
    expect(html).toContain("/progress/");
    expect(html).toContain("saveProgress");
    expect(html).toContain("source-filter");
    expect(html).toContain("sort-order");
    expect(html).toContain("filterLibraryItems");
    expect(html).toContain("sortLibraryItems");
    expect(html).toContain("Newest conversion");
    expect(html).toContain("Article date");
    expect(html).toContain("item.imageUrl");
    expect(html).toContain('item.author ? "By " + item.author : ""');
    expect(html).toContain('"/article/" + encodeURIComponent(item.slug)');
    expect(html).toContain("downloadLink.download = item.slug + \".mp3\"");
    expect(html).toContain("Read");
    expect(html).toContain("Download MP3");
    expect(html).toContain("Pirate Radio");
    expect(html).toContain('href="/queue"');
    expect(html).toContain('href="/admin"');
    expect(html).toContain('<a class="brandlink active" href="/" aria-label="Pirate Radio home">');
    expect(html).not.toContain('href="/">Pirate Wires</a>');
    expect(html).not.toContain("Culture");
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
    expect(html).toContain("Paste Pirate Wires, Substack, or X Article URL");
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
    expect(html).toContain('<a class="navlink active" href="/queue">Queue</a>');
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
  });

  test("renders an admin page with the admin nav tab active", () => {
    const html = renderAdminHtml();

    expect(html).toContain("<h1>Admin</h1>");
    expect(html).toContain("/health");
    expect(html).toContain("/library.json");
    expect(html).toContain("/queue.json");
    expect(html).toContain('<a class="navlink active" href="/admin">Admin</a>');
    expect(html).not.toContain("Culture");
  });

  test("renders a dedicated article page with image, audio, text blocks, and optional alignment", () => {
    const story: Story = {
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
    const item: LibraryItem = {
      slug: "test-story",
      title: story.title,
      sourceUrl: story.sourceUrl,
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
      tagline: story.tagline,
      sectionTitles: story.sectionTitles,
      estimatedCostUsd: 0.01,
      wordCount: story.wordCount,
      characterCount: story.characterCount,
      audioBytes: 1024,
    };

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

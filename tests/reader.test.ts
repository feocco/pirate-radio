import { describe, expect, test } from "vitest";
import { renderArticleHtml, renderBacklogHtml, renderReaderHtml } from "../src/reader.js";
import type { LibraryItem } from "../src/library.js";
import type { Story } from "../src/types.js";

describe("reader page", () => {
  test("renders an audio reader that persists playback position in localStorage", () => {
    const html = renderReaderHtml();

    expect(html).toContain('createElement("audio")');
    expect(html).toContain("/library.json");
    expect(html).toContain("localStorage");
    expect(html).toContain("pirate-radio-position:");
    expect(html).toContain("item.imageUrl");
    expect(html).toContain('"/article/" + encodeURIComponent(item.slug)');
    expect(html).toContain("downloadLink.download = item.slug + \".mp3\"");
    expect(html).toContain("Read");
    expect(html).toContain("Download MP3");
    expect(html).toContain("Pirate Wires");
    expect(html).toContain('href="/backlog"');
  });

  test("renders a backlog page with search, pagination, and convert controls", () => {
    const html = renderBacklogHtml();

    expect(html).toContain("/backlog.json");
    expect(html).toContain("/backlog/convert/");
    expect(html).toContain("backlog-list");
    expect(html).toContain("backlog-row");
    expect(html).toContain("All recent");
    expect(html).toContain("Search");
    expect(html).toContain("Convert");
    expect(html).toContain("pageSize = 10");
    expect(html).not.toContain('placeholder.textContent = "PW"');
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
    expect(html).toContain('download="test-story.mp3"');
    expect(html).toContain("Download MP3");
    expect(html).toContain("/alignment/test-story.json");
    expect(html).toContain("data-word-index");
    expect(html).toContain("A Section");
    expect(html).toContain(">First</span>");
    expect(html).toContain(">paragraph.</span>");
  });
});

import { describe, expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { extractStoryFromHtml } from "../src/extractor.js";

describe("extractStoryFromHtml", () => {
  test("extracts focused story content and reader metadata from fixture HTML", async () => {
    const html = await readFile("tests/fixtures/pirate-story.html", "utf8");

    const story = extractStoryFromHtml(html, "https://www.piratewires.com/p/test-story");

    expect(story.title).toBe("The Test Story");
    expect(story.author).toBe("Pirate Staff");
    expect(story.text).toBe(
      [
        "Enter: The Test Section",
        "Preferred body paragraph one.",
        "A quoted line from the story.",
        "A list item from the article.",
        "American Test Redux",
        "Preferred body paragraph two.",
      ].join("\n\n"),
    );
    expect(story.tagline).toBe("A visible article tagline with the article's full deck.");
    expect(story.heroImageOriginalUrl).toContain("substack-post-media.s3.amazonaws.com");
    expect(story.heroImageOriginalUrl).toContain("hero.png");
    expect(story.heroImageOriginalUrl).not.toContain("recommendation.png");
    expect(story.sectionTitles).toEqual(["Enter: The Test Section", "American Test Redux"]);
    expect(story.contentBlocks).toEqual([
      { type: "heading", text: "Enter: The Test Section" },
      { type: "paragraph", text: "Preferred body paragraph one." },
      { type: "quote", text: "A quoted line from the story." },
      { type: "list", text: "A list item from the article." },
      { type: "heading", text: "American Test Redux" },
      { type: "paragraph", text: "Preferred body paragraph two." },
    ]);
    expect(story.text).not.toContain("This is not the story body.");
    expect(story.text).not.toContain("Home Politics Subscribe");
    expect(story.text).not.toContain("Subscribe now for more.");
    expect(story.text).not.toContain("Privacy Policy Terms");
    expect(story.wordCount).toBe(27);
    expect(story.characterCount).toBe(story.text.length);
  });

  test("extracts public Substack post metadata and body from fixture HTML", async () => {
    const html = await readFile("tests/fixtures/substack-story.html", "utf8");

    const story = extractStoryFromHtml(html, "https://www.hyperdimensional.co/p/what-should-be-done");

    expect(story.title).toBe("What Should Be Done");
    expect(story.author).toBe("Dean W. Ball");
    expect(story.tagline).toBe("How to get past improvised model licensing");
    expect(story.heroImageOriginalUrl).toBe("https://substackcdn.com/image/fetch/hero.png");
    expect(story.sectionTitles).toEqual(["On the Current State of Affairs", "What Should Be Done"]);
    expect(story.text).toContain("First real body paragraph with a frontier model discussion.");
    expect(story.text).toContain("A quoted passage from the article.");
    expect(story.text).toContain("A numbered recommendation from the article.");
    expect(story.text).not.toContain("Subscribe now");
    expect(story.text).not.toContain("This is a reader comment.");
  });

  test("extracts WSJ subscriber markup and ignores chrome plus JSON-LD fallback", async () => {
    const html = await readFile("tests/fixtures/wsj-story.html", "utf8");

    const story = extractStoryFromHtml(
      html,
      "https://www.wsj.com/tech/steve-jobs-apple-next-cia-161b65f9",
    );

    expect(story.title).toBe("Steve Jobs, Apple and the CIA");
    expect(story.author).toBe("Joanna Stern");
    expect(story.tagline).toBe("How a secretive computing project connected Cupertino and Langley.");
    expect(story.heroImageOriginalUrl).toBe("https://images.wsj.net/im-hero.jpg");
    expect(story.sectionTitles).toEqual(["The Next Chapter"]);
    expect(story.text).toBe(
      [
        "Preferred WSJ body paragraph one about Next and intelligence work.",
        "The Next Chapter",
        "Preferred WSJ body paragraph two with the reported history.",
        "A quoted line from the article.",
      ].join("\n\n"),
    );
    expect(story.text).not.toContain("JSON-LD fallback paragraph");
    expect(story.text).not.toContain("Related teaser");
    expect(story.text).not.toContain("Subscribe to continue reading");
  });

  test("falls back to NewsArticle JSON-LD when HTML body containers are empty", () => {
    const html = `
      <html>
        <head>
          <meta property="og:title" content="JSON-LD Only Story">
          <script type="application/ld+json">
            {"@type":"NewsArticle","articleBody":"First sourced paragraph.\\n\\nSecond sourced paragraph."}
          </script>
        </head>
        <body><p>Subscribe</p></body>
      </html>
    `;

    const story = extractStoryFromHtml(html, "https://www.wsj.com/articles/json-ld-only");

    expect(story.title).toBe("JSON-LD Only Story");
    expect(story.contentBlocks).toEqual([
      { type: "paragraph", text: "First sourced paragraph." },
      { type: "paragraph", text: "Second sourced paragraph." },
    ]);
  });
});

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { appendLibraryItem, readLibraryManifest } from "../src/library.js";
import { filterVoiceExcludedLibraryManifest } from "../src/articleFilters.js";

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("library visibility filters", () => {
  test("hides Three Morning Takes from reader manifests without deleting it", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pirate-library-"));
    await mkdir(join(tempDir, "audio"), { recursive: true });
    const regularAudioPath = join(tempDir, "audio", "regular.mp3");
    const takesAudioPath = join(tempDir, "audio", "three-morning-takes.mp3");
    await writeFile(regularAudioPath, Buffer.alloc(10, 1));
    await writeFile(takesAudioPath, Buffer.alloc(10, 1));

    await appendLibraryItem(tempDir, {
      slug: "regular",
      title: "A Regular Article",
      sourceUrl: "https://piratewires.substack.com/p/regular",
      audioPath: regularAudioPath,
      jsonPath: join(tempDir, "stories", "regular.json"),
      textPath: join(tempDir, "text", "regular.txt"),
      publishedAt: "Mon, 22 Jun 2026 17:07:10 GMT",
      generatedAt: "2026-06-23T01:00:00.000Z",
      estimatedCostUsd: 0.08,
      wordCount: 100,
      characterCount: 500,
    });
    await appendLibraryItem(tempDir, {
      slug: "three-morning-takes",
      title: "Monday: Three Morning Takes",
      sourceUrl: "https://piratewires.substack.com/p/three-morning-takes",
      audioPath: takesAudioPath,
      jsonPath: join(tempDir, "stories", "three-morning-takes.json"),
      textPath: join(tempDir, "text", "three-morning-takes.txt"),
      publishedAt: "Mon, 22 Jun 2026 09:45:52 GMT",
      generatedAt: "2026-06-23T01:00:00.000Z",
      estimatedCostUsd: 0.04,
      wordCount: 400,
      characterCount: 2500,
    });

    const manifest = await readLibraryManifest(tempDir);
    const visible = filterVoiceExcludedLibraryManifest(manifest);

    expect(manifest.items.map((item) => item.title)).toContain("Monday: Three Morning Takes");
    expect(visible.items.map((item) => item.title)).toEqual(["A Regular Article"]);
  });
});

describe("library manifest", () => {
  test("stores MP3 metadata without embedding audio bytes in the manifest", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pirate-library-"));
    const audioPath = join(tempDir, "audio", "inside-microns-attempts.mp3");
    await mkdir(join(tempDir, "audio"), { recursive: true });
    await writeFile(audioPath, Buffer.alloc(1024, 1));

    await appendLibraryItem(tempDir, {
      slug: "inside-microns-attempts",
      title: "Inside Micron's Attempts",
      sourceUrl: "https://piratewires.substack.com/p/inside-microns-attempts",
      audioPath,
      jsonPath: join(tempDir, "stories", "inside-microns-attempts.json"),
      textPath: join(tempDir, "text", "inside-microns-attempts.txt"),
      imagePath: join(tempDir, "images", "inside-microns-attempts.png"),
      imageUrl: "/images/inside-microns-attempts.png",
      tagline: "following nonsense regulations",
      sectionTitles: ["American Industrialization Redux"],
      publishedAt: "Mon, 22 Jun 2026 17:07:10 GMT",
      generatedAt: "2026-06-23T01:00:00.000Z",
      estimatedCostUsd: 0.08,
      wordCount: 100,
      characterCount: 500,
    });

    const manifest = await readLibraryManifest(tempDir);
    const rawManifest = await readFile(join(tempDir, "index.json"), "utf8");

    expect(manifest.items).toHaveLength(1);
    expect(manifest.items[0].audioUrl).toBe("/audio/inside-microns-attempts.mp3");
    expect(manifest.items[0].imageUrl).toBe("/images/inside-microns-attempts.png");
    expect(manifest.items[0].tagline).toBe("following nonsense regulations");
    expect(manifest.items[0].sectionTitles).toEqual(["American Industrialization Redux"]);
    expect(rawManifest.length).toBeLessThan(2000);
    expect(rawManifest).not.toContain(Buffer.alloc(16, 1).toString("base64"));
  });
});

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { appendLibraryItem, archiveLibraryItem, readLibraryManifest } from "../src/library.js";
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

  test("sorts visible items by conversion time and infers legacy source names", () => {
    const visible = filterVoiceExcludedLibraryManifest({
      version: 1,
      updatedAt: "2026-07-13T00:00:00.000Z",
      items: [
        {
          slug: "older",
          title: "Older Pirate Story",
          sourceUrl: "https://www.piratewires.com/p/older",
          publishedAt: "Mon, 13 Jul 2026 00:00:00 GMT",
          generatedAt: "2026-07-13T01:00:00.000Z",
          audioPath: "/audio/older.mp3",
          audioUrl: "/audio/older.mp3",
          jsonPath: "/stories/older.json",
          textPath: "/text/older.txt",
          estimatedCostUsd: 0.01,
          wordCount: 100,
          characterCount: 500,
          audioBytes: 100,
        },
        {
          slug: "newer",
          title: "Newer Hyper Story",
          sourceUrl: "https://www.hyperdimensional.co/p/newer",
          publishedAt: "Fri, 26 Jun 2026 00:00:00 GMT",
          generatedAt: "2026-07-13T02:00:00.000Z",
          audioPath: "/audio/newer.mp3",
          audioUrl: "/audio/newer.mp3",
          jsonPath: "/stories/newer.json",
          textPath: "/text/newer.txt",
          estimatedCostUsd: 0.01,
          wordCount: 100,
          characterCount: 500,
          audioBytes: 100,
        },
      ],
    });

    expect(visible.items.map((item) => item.slug)).toEqual(["newer", "older"]);
    expect(visible.items.map((item) => item.sourceName)).toEqual(["Hyperdimensional", "Pirate Wires"]);
  });
});

describe("library manifest", () => {
  test("archives generated files before removing an article from the active manifest", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pirate-library-"));
    const slug = "delete-me";
    const paths = {
      audio: join(tempDir, "audio", `${slug}.mp3`),
      story: join(tempDir, "stories", `${slug}.json`),
      text: join(tempDir, "text", `${slug}.txt`),
      image: join(tempDir, "images", `${slug}.jpg`),
    };
    await Promise.all(Object.values(paths).map((path) => mkdir(dirname(path), { recursive: true })));
    await Promise.all([
      writeFile(paths.audio, "audio"),
      writeFile(paths.story, JSON.stringify({ title: "Delete Me" })),
      writeFile(paths.text, "article text"),
      writeFile(paths.image, "image"),
    ]);
    await appendLibraryItem(tempDir, {
      slug,
      title: "Delete Me",
      sourceUrl: "https://example.com/delete-me",
      audioPath: paths.audio,
      jsonPath: paths.story,
      textPath: paths.text,
      imagePath: paths.image,
      imageUrl: `/images/${slug}.jpg`,
      publishedAt: "2026-07-16T00:00:00.000Z",
      generatedAt: "2026-07-16T01:00:00.000Z",
      estimatedCostUsd: 0.01,
      wordCount: 2,
      characterCount: 9,
    });

    const archived = await archiveLibraryItem(tempDir, slug, "admin");

    expect(archived?.deletedByUsername).toBe("admin");
    expect((await readLibraryManifest(tempDir)).items).toHaveLength(0);
    await expect(readFile(paths.audio)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(archived!.archiveDir, "audio", `${slug}.mp3`), "utf8")).resolves.toBe("audio");
    const deletion = JSON.parse(await readFile(join(archived!.archiveDir, "deletion.json"), "utf8"));
    const priorManifest = JSON.parse(await readFile(join(archived!.archiveDir, "manifest-before.json"), "utf8"));
    expect(deletion).toMatchObject({ deletedByUsername: "admin", item: { slug } });
    expect(priorManifest.items).toHaveLength(1);
  });

  test("stores MP3 metadata without embedding audio bytes in the manifest", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pirate-library-"));
    const audioPath = join(tempDir, "audio", "inside-microns-attempts.mp3");
    await mkdir(join(tempDir, "audio"), { recursive: true });
    await writeFile(audioPath, Buffer.alloc(1024, 1));

    await appendLibraryItem(tempDir, {
      slug: "inside-microns-attempts",
      title: "Inside Micron's Attempts",
      author: "Ryan Hassan",
      sourceUrl: "https://piratewires.substack.com/p/inside-microns-attempts",
      sourceType: "pirate-wires",
      sourceName: "Pirate Wires",
      canonicalUrl: "https://www.piratewires.com/p/inside-microns-attempts",
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
    expect(manifest.items[0].sourceType).toBe("pirate-wires");
    expect(manifest.items[0].sourceName).toBe("Pirate Wires");
    expect(manifest.items[0].author).toBe("Ryan Hassan");
    expect(manifest.items[0].canonicalUrl).toBe("https://www.piratewires.com/p/inside-microns-attempts");
    expect(manifest.items[0].imageUrl).toBe("/images/inside-microns-attempts.png");
    expect(manifest.items[0].tagline).toBe("following nonsense regulations");
    expect(manifest.items[0].sectionTitles).toEqual(["American Industrialization Redux"]);
    expect(rawManifest.length).toBeLessThan(2000);
    expect(rawManifest).not.toContain(Buffer.alloc(16, 1).toString("base64"));
  });
});

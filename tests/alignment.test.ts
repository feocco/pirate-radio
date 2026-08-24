import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { writeAlignment, type AlignmentResult } from "../src/alignment.js";

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("audio alignment", () => {
  test("writes optional word timing metadata under the library alignment directory", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pirate-alignment-"));
    const audioPath = join(tempDir, "audio", "test-story.mp3");
    await mkdir(join(tempDir, "audio"), { recursive: true });
    await writeFile(audioPath, Buffer.from("mock mp3"));

    const result = await writeAlignment({
      libraryDir: tempDir,
      slug: "test-story",
      audioPath,
      transcribe: async () => ({
        words: [
          { word: "First", start: 0, end: 0.25 },
          { word: "paragraph", start: 0.26, end: 0.8 },
        ],
      }),
    });

    expect(result).toEqual({
      alignmentPath: join(tempDir, "alignment", "test-story.json"),
      alignmentUrl: "/alignment/test-story.json",
    });
    const written = JSON.parse(await readFile(result.alignmentPath, "utf8")) as AlignmentResult;
    expect(written.words).toEqual([
      { word: "First", start: 0, end: 0.25 },
      { word: "paragraph", start: 0.26, end: 0.8 },
    ]);
  });

  test("times out STT and maps provider errors without leaking bodies", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pirate-alignment-"));
    const audioPath = join(tempDir, "audio", "test-story.mp3");
    await mkdir(join(tempDir, "audio"), { recursive: true });
    await writeFile(audioPath, Buffer.from("mock mp3"));

    const secret = "secret-transcript-should-not-leak";
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const originalFetch = globalThis.fetch;
    const originalKey = process.env.XAI_API_KEY;
    process.env.XAI_API_KEY = "test-key";
    globalThis.fetch = (async (url, init) => {
      expect(url).toBe("https://api.x.ai/v1/stt");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(`${secret}${"y".repeat(400)}`, { status: 503 });
    }) as typeof fetch;

    try {
      const error = await writeAlignment({
        libraryDir: tempDir,
        slug: "test-story",
        audioPath,
      }).catch((caught: unknown) => caught);

      expect(timeout).toHaveBeenCalledWith(60_000);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("xAI stt failed (503)");
      expect((error as Error).message).not.toContain(secret);
    } finally {
      timeout.mockRestore();
      globalThis.fetch = originalFetch;
      if (originalKey === undefined) {
        delete process.env.XAI_API_KEY;
      } else {
        process.env.XAI_API_KEY = originalKey;
      }
    }
  });
});

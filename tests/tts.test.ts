import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import packageJson from "../package.json" with { type: "json" };
import { createTtsProvider } from "../src/tts/index.js";
import { assertWithinBudget, estimateTtsCost } from "../src/tts/cost.js";
import { splitSpeechInput } from "../src/tts/chunk.js";
import { wordsFromGraphTimestamps } from "../src/tts/timestamps.js";
import { XaiTtsProvider } from "../src/tts/xai.js";
import type { TtsProvider } from "../src/tts/types.js";

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("xAI TTS cost guard", () => {
  test("estimates speech generation at 15 dollars per million characters", () => {
    expect(estimateTtsCost(10_000)).toBeCloseTo(0.15);
  });

  test("blocks audio generation above one dollar unless explicitly allowed", () => {
    expect(() => assertWithinBudget(70_000, false)).toThrow(
      "Estimated xAI TTS cost $1.05 exceeds the $1.00 budget",
    );
    expect(() => assertWithinBudget(70_000, true)).not.toThrow();
  });
});

describe("TtsProvider contract", () => {
  test("can be implemented by a mock provider", async () => {
    const provider: TtsProvider = {
      name: "mock",
      synthesize: async () => ({
        provider: "mock",
        outputPath: "output/audio/test.mp3",
        estimatedCostUsd: 0.01,
      }),
    };

    const result = await provider.synthesize({
      title: "The Test Story",
      text: "Story text.",
      outputPath: "output/audio/test.mp3",
      allowOverBudget: false,
    });

    expect(result.outputPath).toBe("output/audio/test.mp3");
  });
});

describe("createTtsProvider", () => {
  test("rejects removed providers", () => {
    expect(() => createTtsProvider("openai")).toThrow(
      'Unsupported TTS provider "openai". Available providers: xai.',
    );
  });

  test("does not depend on the openai package", () => {
    expect(packageJson.dependencies).not.toHaveProperty("openai");
  });
});

describe("splitSpeechInput", () => {
  test("splits long article text into ordered bounded chunks", () => {
    const text = Array.from({ length: 12 }, (_, index) => `Paragraph ${index} ${"word ".repeat(80)}`).join(
      "\n\n",
    );

    const chunks = splitSpeechInput("A Long Story", text, 1200);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 1200)).toBe(true);
    expect(chunks.join("\n\n")).toContain("A Long Story");
    expect(chunks.join("\n\n")).toContain("Paragraph 11");
  });

  test("default chunks stay below xAI speech input max length", () => {
    const text = Array.from({ length: 20 }, (_, index) => `Paragraph ${index} ${"word ".repeat(170)}`).join(
      "\n\n",
    );

    const chunks = splitSpeechInput("A Long Story", text);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 15000)).toBe(true);
  });
});

describe("wordsFromGraphTimestamps", () => {
  test("groups characters into words and applies offsets", () => {
    const words = wordsFromGraphTimestamps(
      ["H", "i", " ", "t", "h", "e", "r", "e", "."],
      [
        [0, 0.1],
        [0.1, 0.2],
        [0.2, 0.25],
        [0.25, 0.3],
        [0.3, 0.35],
        [0.35, 0.4],
        [0.4, 0.45],
        [0.45, 0.5],
        [0.5, 0.6],
      ],
      2,
    );

    expect(words).toEqual([
      { word: "Hi", start: 2, end: 2.2 },
      { word: "there.", start: 2.25, end: 2.6 },
    ]);
  });
});

describe("XaiTtsProvider", () => {
  test("writes raw MP3 bytes from the binary response", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pirate-xai-tts-"));
    const outputPath = join(tempDir, "audio", "story.mp3");
    const mp3 = Buffer.from("mock-mp3-bytes");

    const provider = new XaiTtsProvider({
      apiKey: "test-key",
      fetchImpl: async (url) => {
        expect(url).toBe("https://api.x.ai/v1/tts");
        return new Response(mp3, {
          status: 200,
          headers: { "Content-Type": "audio/mpeg" },
        });
      },
    });

    const result = await provider.synthesize({
      title: "Story",
      text: "Short body.",
      outputPath,
      allowOverBudget: false,
    });

    expect(result).toMatchObject({
      provider: "xai",
      outputPath,
    });
    expect(await readFile(outputPath)).toEqual(mp3);
  });

  test("merges timestamped chunks with cumulative offsets", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pirate-xai-tts-"));
    const outputPath = join(tempDir, "audio", "chunked.mp3");
    let call = 0;

    const provider = new XaiTtsProvider({
      apiKey: "test-key",
      fetchImpl: async () => {
        call += 1;
        if (call === 1) {
          return Response.json({
            audio: Buffer.from("chunk-one").toString("base64"),
            audio_timestamps: {
              graph_chars: ["H", "i"],
              graph_times: [
                [0, 0.2],
                [0.2, 0.4],
              ],
            },
            duration: 0.4,
          });
        }
        return Response.json({
          audio: Buffer.from("chunk-two").toString("base64"),
          audio_timestamps: {
            graph_chars: ["B", "y", "e"],
            graph_times: [
              [0, 0.1],
              [0.1, 0.2],
              [0.2, 0.3],
            ],
          },
          duration: 0.3,
        });
      },
    });

    const result = await provider.synthesize({
      title: "Chunked",
      text: `${"word ".repeat(1600)}\n\n${"word ".repeat(1600)}`,
      outputPath,
      allowOverBudget: true,
      includeTimestamps: true,
    });

    expect(result.words).toEqual([
      { word: "Hi", start: 0, end: 0.4 },
      { word: "Bye", start: 0.4, end: 0.7 },
    ]);
    expect(await readFile(outputPath)).toEqual(Buffer.concat([Buffer.from("chunk-one"), Buffer.from("chunk-two")]));
  });

  test("keeps audio when timestamp metadata is missing", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pirate-xai-tts-"));
    const outputPath = join(tempDir, "audio", "no-stamps.mp3");
    const provider = new XaiTtsProvider({
      apiKey: "test-key",
      fetchImpl: async () =>
        Response.json({
          audio: Buffer.from("still-audio").toString("base64"),
        }),
    });

    const result = await provider.synthesize({
      title: "Story",
      text: "Body",
      outputPath,
      allowOverBudget: false,
      includeTimestamps: true,
    });

    expect(result.words).toBeUndefined();
    expect(await readFile(outputPath)).toEqual(Buffer.from("still-audio"));
  });

  test("throws when XAI_API_KEY is missing", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pirate-xai-tts-"));
    const provider = new XaiTtsProvider({ apiKey: "" });

    await expect(
      provider.synthesize({
        title: "Story",
        text: "Body",
        outputPath: join(tempDir, "story.mp3"),
        allowOverBudget: false,
      }),
    ).rejects.toThrow("XAI_API_KEY is required");
  });
});

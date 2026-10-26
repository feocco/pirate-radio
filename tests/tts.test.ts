import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import packageJson from "../package.json" with { type: "json" };
import { assertWithinBudget, estimateTtsCost } from "../src/tts/cost.js";
import {
  createTtsProvider,
  DEFAULT_TTS_PROVIDER,
  splitSpeechInput,
  wordsFromGraphTimestamps,
  XaiTtsProvider,
  type TimedWord,
  type TtsProvider,
} from "../src/tts/index.js";

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
  test("returns an xAI provider by default", () => {
    const provider = createTtsProvider();
    expect(provider).toBeInstanceOf(XaiTtsProvider);
    expect(provider.name).toBe(DEFAULT_TTS_PROVIDER);
  });

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

  test("default chunks stay within 5000 characters and keep the article text", () => {
    const title = "A Long Story";
    const paragraphs = Array.from({ length: 20 }, (_, index) =>
      `Paragraph ${index} ${"word ".repeat(170)}`.trim(),
    );
    const text = paragraphs.join("\n\n");

    const chunks = splitSpeechInput(title, text);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 5_000)).toBe(true);
    expect(chunks.join("").replaceAll("\n\n", "")).toBe(`${title}${paragraphs.join("")}`);
  });

  test("splits on paragraph boundaries when each paragraph fits", () => {
    const first = `${"a".repeat(3_000)}.`;
    const second = `${"b".repeat(3_000)}.`;

    const chunks = splitSpeechInput("Title", `${first}\n\n${second}`);

    expect(chunks.every((chunk) => chunk.length <= 5_000)).toBe(true);
    expect(chunks.map((chunk) => chunk.replaceAll("\n\n", ""))).toEqual([`Title${first}`, second]);
    expect(chunks.join("").replaceAll("\n\n", "")).toBe(`Title${first}${second}`);
  });

  test("splits an oversized paragraph on sentence boundaries", () => {
    const first = `${"c".repeat(3_000)}.`;
    const second = `${"d".repeat(3_000)}.`;

    const chunks = splitSpeechInput("Title", `${first} ${second}`);

    expect(chunks.every((chunk) => chunk.length <= 5_000)).toBe(true);
    expect(chunks.map((chunk) => chunk.trim())).toEqual(["Title", first, second]);
    expect(chunks.join("").replaceAll("\n\n", "")).toBe(`Title${first} ${second}`);
  });

  test("keeps oversized sentence, token, and title text in order", () => {
    const words = Array.from({ length: 1_200 }, (_, index) => `w${String(index).padStart(4, "0")}`);
    const sentence = `${words.join(" ")}.`;
    const token = `${"Q".repeat(5_050)}TAIL`;
    const title = `Headline ${"Z".repeat(5_200)}`;
    const text = `${sentence}\n\n${token}`;

    const chunks = splitSpeechInput(title, text);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 5_000)).toBe(true);
    expect(chunks.join("").replaceAll("\n\n", "")).toBe(`${title}${sentence}${token}`);
    expect(chunks.some((chunk) => chunk.includes(words[0]!))).toBe(true);
    expect(chunks.some((chunk) => chunk.includes(words[600]!))).toBe(true);
    expect(chunks.some((chunk) => chunk.includes(words[1_199]!))).toBe(true);
    expect(chunks.join("").match(/Q/g)?.length).toBe(5_050);
    expect(chunks.some((chunk) => chunk.includes("TAIL"))).toBe(true);
    expect(chunks.join("").match(/Z/g)?.length).toBe(5_200);
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

    const expected: TimedWord[] = [
      { word: "Hi", start: 2, end: 2.2 },
      { word: "there.", start: 2.25, end: 2.6 },
    ];
    expect(words).toEqual(expected);
  });
});

describe("XaiTtsProvider", () => {
  test("writes raw MP3 bytes from the binary response", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pirate-xai-tts-"));
    const outputPath = join(tempDir, "audio", "story.mp3");
    const mp3 = Buffer.from("mock-mp3-bytes");

    const provider = new XaiTtsProvider({
      apiKey: "test-key",
      fetchImpl: async (url, init) => {
        expect(url).toBe("https://api.x.ai/v1/tts");
        expect(init?.headers).toMatchObject({
          Authorization: "Bearer test-key",
          "Content-Type": "application/json",
        });
        expect(JSON.parse(String(init?.body))).toEqual({
          text: "Story\n\nShort body.",
          voice_id: "eve",
          language: "en",
        });
        expect(init?.signal).toBeInstanceOf(AbortSignal);
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
      text: `${"word ".repeat(800)}\n\n${"word ".repeat(800)}`,
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

  test("forwards custom endpoint, language, and timeout to fetch", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pirate-xai-tts-"));
    const outputPath = join(tempDir, "audio", "custom.mp3");
    const timeout = vi.spyOn(AbortSignal, "timeout");

    try {
      const provider = new XaiTtsProvider({
        apiKey: "test-key",
        endpoint: "https://tts.example.test/v1/speak",
        language: "es",
        timeoutMs: 12_000,
        fetchImpl: async (url, init) => {
          expect(url).toBe("https://tts.example.test/v1/speak");
          expect(JSON.parse(String(init?.body))).toMatchObject({
            language: "es",
          });
          expect(init?.signal).toBeInstanceOf(AbortSignal);
          return new Response(Buffer.from("custom-mp3"), {
            status: 200,
            headers: { "Content-Type": "audio/mpeg" },
          });
        },
      });

      await provider.synthesize({
        title: "Story",
        text: "Body",
        outputPath,
        allowOverBudget: false,
      });

      expect(timeout).toHaveBeenCalledWith(12_000);
    } finally {
      timeout.mockRestore();
    }
  });

  test("maps provider HTTP errors without leaking response bodies", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pirate-xai-tts-"));
    const secret = "secret-user-prompt-should-not-leak";
    const provider = new XaiTtsProvider({
      apiKey: "test-key",
      fetchImpl: async () =>
        new Response(`${secret}${"x".repeat(400)}`, {
          status: 403,
          headers: { "Content-Type": "text/plain" },
        }),
    });

    const error = await provider
      .synthesize({
        title: "Story",
        text: "Body",
        outputPath: join(tempDir, "story.mp3"),
        allowOverBudget: false,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("xAI tts failed (403)");
    expect((error as Error).message).not.toContain(secret);
  });

  test("advances timeOffset across a chunk that returns audio without timestamps", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pirate-xai-tts-"));
    const outputPath = join(tempDir, "audio", "offset.mp3");
    let call = 0;
    const silentChunk = Buffer.alloc(32_000, 1);

    const provider = new XaiTtsProvider({
      apiKey: "test-key",
      fetchImpl: async () => {
        call += 1;
        if (call === 1) {
          return Response.json({
            audio: silentChunk.toString("base64"),
          });
        }
        return Response.json({
          audio: Buffer.from("chunk-two").toString("base64"),
          audio_timestamps: {
            graph_chars: ["H", "i"],
            graph_times: [
              [0, 0.2],
              [0.2, 0.4],
            ],
          },
          duration: 0.4,
        });
      },
    });

    const result = await provider.synthesize({
      title: "Chunked",
      text: `${"word ".repeat(800)}\n\n${"word ".repeat(800)}`,
      outputPath,
      allowOverBudget: true,
      includeTimestamps: true,
    });

    expect(result.words).toEqual([{ word: "Hi", start: 2, end: 2.4 }]);
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

  test("times out each TTS attempt at 120 seconds", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pirate-xai-tts-"));
    const timeout = vi.spyOn(AbortSignal, "timeout");

    try {
      const provider = new XaiTtsProvider({
        apiKey: "test-key",
        fetchImpl: async () =>
          new Response(Buffer.from("default-timeout"), {
            status: 200,
            headers: { "Content-Type": "audio/mpeg" },
          }),
      });

      await provider.synthesize({
        title: "Story",
        text: "Body",
        outputPath: join(tempDir, "story.mp3"),
        allowOverBudget: false,
      });

      expect(timeout).toHaveBeenCalledTimes(1);
      expect(timeout).toHaveBeenCalledWith(120_000);
    } finally {
      timeout.mockRestore();
    }
  });

  test("retries a header timeout on a fresh signal", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pirate-xai-tts-"));
    const outputPath = join(tempDir, "audio", "header-timeout.mp3");
    const signals: AbortSignal[] = [];

    const provider = new XaiTtsProvider({
      apiKey: "test-key",
      timeoutMs: 0,
      retryDelaysMs: [0, 0],
      fetchImpl: async (_url, init) => {
        const signal = init?.signal;
        if (!(signal instanceof AbortSignal)) {
          throw new Error("missing timeout signal");
        }
        signals.push(signal);
        if (signals.length === 1) {
          if (signal.aborted) {
            throw signal.reason;
          }
          await new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        }
        expect(signal.aborted).toBe(false);
        return new Response(Buffer.from("after-header-timeout"), {
          status: 200,
          headers: { "Content-Type": "audio/mpeg" },
        });
      },
    });

    await provider.synthesize({
      title: "Story",
      text: "Body",
      outputPath,
      allowOverBudget: false,
    });

    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
    expect(signals[0]?.aborted).toBe(true);
    expect((signals[0]?.reason as Error | undefined)?.name).toBe("TimeoutError");
    expect(await readFile(outputPath)).toEqual(Buffer.from("after-header-timeout"));
  });

  test("retries when the response body times out", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pirate-xai-tts-"));
    const outputPath = join(tempDir, "audio", "body-timeout.mp3");
    let calls = 0;

    const provider = new XaiTtsProvider({
      apiKey: "test-key",
      retryDelaysMs: [0, 0],
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) {
          const stream = new ReadableStream({
            start(controller) {
              controller.error(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
            },
          });
          return new Response(stream, {
            status: 200,
            headers: { "Content-Type": "audio/mpeg" },
          });
        }
        return new Response(Buffer.from("after-body-timeout"), {
          status: 200,
          headers: { "Content-Type": "audio/mpeg" },
        });
      },
    });

    await provider.synthesize({
      title: "Story",
      text: "Body",
      outputPath,
      allowOverBudget: false,
    });

    expect(calls).toBe(2);
    expect(await readFile(outputPath)).toEqual(Buffer.from("after-body-timeout"));
  });

  test("retries an Error named TimeoutError", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pirate-xai-tts-"));
    const outputPath = join(tempDir, "audio", "error-timeout.mp3");
    let calls = 0;

    const provider = new XaiTtsProvider({
      apiKey: "test-key",
      retryDelaysMs: [0, 0],
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) {
          const timeout = new Error("timed out");
          timeout.name = "TimeoutError";
          throw timeout;
        }
        return new Response(Buffer.from("after-error-timeout"), {
          status: 200,
          headers: { "Content-Type": "audio/mpeg" },
        });
      },
    });

    await provider.synthesize({
      title: "Story",
      text: "Body",
      outputPath,
      allowOverBudget: false,
    });

    expect(calls).toBe(2);
    expect(await readFile(outputPath)).toEqual(Buffer.from("after-error-timeout"));
  });

  test.each([429, 500, 503, 599])("retries HTTP %s and writes the later audio", async (status) => {
    tempDir = await mkdtemp(join(tmpdir(), "pirate-xai-tts-"));
    const outputPath = join(tempDir, "audio", `status-${status}.mp3`);
    let calls = 0;

    const provider = new XaiTtsProvider({
      apiKey: "test-key",
      retryDelaysMs: [0, 0],
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) {
          return new Response("temporary", { status });
        }
        return new Response(Buffer.from(`recovered-${status}`), {
          status: 200,
          headers: { "Content-Type": "audio/mpeg" },
        });
      },
    });

    await provider.synthesize({
      title: "Story",
      text: "Body",
      outputPath,
      allowOverBudget: false,
    });

    expect(calls).toBe(2);
    expect(await readFile(outputPath)).toEqual(Buffer.from(`recovered-${status}`));
  });

  test("waits 1000ms and then 4000ms between retries of one chunk", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pirate-xai-tts-"));
    const outputPath = join(tempDir, "audio", "delays.mp3");
    const waits: number[] = [];
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      if (timeout === 1_000 || timeout === 4_000) {
        waits.push(timeout);
        return originalSetTimeout(handler, 0, ...(args as []));
      }
      return originalSetTimeout(handler, timeout, ...(args as []));
    }) as typeof setTimeout;

    let calls = 0;
    try {
      const provider = new XaiTtsProvider({
        apiKey: "test-key",
        fetchImpl: async () => {
          calls += 1;
          if (calls < 3) {
            return new Response("busy", { status: 429 });
          }
          return new Response(Buffer.from("after-delays"), {
            status: 200,
            headers: { "Content-Type": "audio/mpeg" },
          });
        },
      });

      await provider.synthesize({
        title: "Story",
        text: "Body",
        outputPath,
        allowOverBudget: false,
      });

      expect(waits).toEqual([1_000, 4_000]);
      expect(calls).toBe(3);
      expect(await readFile(outputPath)).toEqual(Buffer.from("after-delays"));
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  test("stops after the configured attempts and keeps the redacted status error", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pirate-xai-tts-"));
    const body = `${"s".repeat(80)}${"x".repeat(400)}`;
    const logged: string[] = [];
    const consoleError = vi.spyOn(console, "error").mockImplementation((message?: unknown) => {
      logged.push(String(message));
    });
    let calls = 0;

    try {
      const provider = new XaiTtsProvider({
        apiKey: "test-key",
        retryDelaysMs: [0, 0],
        fetchImpl: async () => {
          calls += 1;
          return new Response(body, { status: 500 });
        },
      });

      const error = await provider
        .synthesize({
          title: "Story",
          text: "Body",
          outputPath: join(tempDir, "story.mp3"),
          allowOverBudget: false,
        })
        .catch((caught: unknown) => caught);

      expect(calls).toBe(3);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("xAI tts failed (500)");
      expect((error as Error).message).not.toContain(body);
      expect(logged).toEqual([`xAI tts 500: ${"s".repeat(80)}${"x".repeat(40)}`]);
    } finally {
      consoleError.mockRestore();
    }
  });

  test("does not retry a nonretryable 4xx response", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pirate-xai-tts-"));
    let calls = 0;
    const provider = new XaiTtsProvider({
      apiKey: "test-key",
      retryDelaysMs: [0, 0],
      fetchImpl: async () => {
        calls += 1;
        return new Response("bad request", { status: 400 });
      },
    });

    await expect(
      provider.synthesize({
        title: "Story",
        text: "Body",
        outputPath: join(tempDir, "story.mp3"),
        allowOverBudget: false,
      }),
    ).rejects.toThrow("xAI tts failed (400)");
    expect(calls).toBe(1);
  });

  test("does not retry a timestamp parse failure", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pirate-xai-tts-"));
    let calls = 0;
    const provider = new XaiTtsProvider({
      apiKey: "test-key",
      retryDelaysMs: [0, 0],
      fetchImpl: async () => {
        calls += 1;
        return Response.json({ audio_timestamps: {} });
      },
    });

    await expect(
      provider.synthesize({
        title: "Story",
        text: "Body",
        outputPath: join(tempDir, "story.mp3"),
        allowOverBudget: false,
        includeTimestamps: true,
      }),
    ).rejects.toThrow("xAI TTS timestamp response did not include audio.");
    expect(calls).toBe(1);
  });

  test("does not retry a generic fetch TypeError", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pirate-xai-tts-"));
    let calls = 0;
    const provider = new XaiTtsProvider({
      apiKey: "test-key",
      retryDelaysMs: [0, 0],
      fetchImpl: async () => {
        calls += 1;
        throw new TypeError("fetch failed");
      },
    });

    await expect(
      provider.synthesize({
        title: "Story",
        text: "Body",
        outputPath: join(tempDir, "story.mp3"),
        allowOverBudget: false,
      }),
    ).rejects.toThrow(TypeError);
    expect(calls).toBe(1);
  });

  test("keeps earlier chunk audio and retries only the failed chunk", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pirate-xai-tts-"));
    const outputPath = join(tempDir, "audio", "ordered.mp3");
    const title = "Chunked";
    const firstParagraph = "word ".repeat(800).trim();
    const secondParagraph = "tail ".repeat(800).trim();
    const seen: string[] = [];
    let tailAttempts = 0;

    const provider = new XaiTtsProvider({
      apiKey: "test-key",
      retryDelaysMs: [0, 0],
      fetchImpl: async (_url, init) => {
        const text = JSON.parse(String(init?.body)).text as string;
        seen.push(text);
        if (text === secondParagraph) {
          tailAttempts += 1;
          if (tailAttempts < 3) {
            return new Response("busy", { status: 503 });
          }
          return new Response(Buffer.from("two"), {
            status: 200,
            headers: { "Content-Type": "audio/mpeg" },
          });
        }
        return new Response(Buffer.from("one"), {
          status: 200,
          headers: { "Content-Type": "audio/mpeg" },
        });
      },
    });

    await provider.synthesize({
      title,
      text: `${firstParagraph}\n\n${secondParagraph}`,
      outputPath,
      allowOverBudget: true,
    });

    expect(seen).toEqual([
      `${title}\n\n${firstParagraph}`,
      secondParagraph,
      secondParagraph,
      secondParagraph,
    ]);
    expect(await readFile(outputPath)).toEqual(Buffer.concat([Buffer.from("one"), Buffer.from("two")]));
  });

  test("gives up on a chunk timeout without retrying earlier chunks", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pirate-xai-tts-"));
    const title = "Chunked";
    const firstParagraph = "word ".repeat(800).trim();
    const secondParagraph = "tail ".repeat(800).trim();
    const seen: string[] = [];

    const provider = new XaiTtsProvider({
      apiKey: "test-key",
      retryDelaysMs: [0, 0],
      fetchImpl: async (_url, init) => {
        const text = JSON.parse(String(init?.body)).text as string;
        seen.push(text);
        if (text === secondParagraph) {
          const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
          throw timeout;
        }
        return new Response(Buffer.from("one"), {
          status: 200,
          headers: { "Content-Type": "audio/mpeg" },
        });
      },
    });

    const error = await provider
      .synthesize({
        title,
        text: `${firstParagraph}\n\n${secondParagraph}`,
        outputPath: join(tempDir, "audio", "give-up.mp3"),
        allowOverBudget: true,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("TimeoutError");
    expect(seen).toEqual([
      `${title}\n\n${firstParagraph}`,
      secondParagraph,
      secondParagraph,
      secondParagraph,
    ]);
  });
});

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { splitSpeechInput } from "./chunk.js";
import { assertWithinBudget } from "./cost.js";
import { wordsFromGraphTimestamps } from "./timestamps.js";
import type { TimedWord, TtsProvider, TtsRequest, TtsResult } from "./types.js";
import {
  mapXaiHttpError,
  nextChunkTimeOffset,
  XAI_TTS_RETRY_DELAYS_MS,
  XAI_TTS_TIMEOUT_MS,
} from "./xaiHttp.js";

const XAI_TTS_URL = "https://api.x.ai/v1/tts";
const TTS_LANGUAGE = "en";

interface XaiTimestampResponse {
  audio: string;
  audio_timestamps: {
    graph_chars: string[];
    graph_times: [number, number][];
  };
  duration?: number;
}

export interface XaiTtsProviderOptions {
  apiKey?: string;
  voiceId?: string;
  fetchImpl?: typeof fetch;
  endpoint?: string;
  language?: string;
  timeoutMs?: number;
  retryDelaysMs?: readonly number[];
}

export class XaiTtsProvider implements TtsProvider {
  name = "xai";

  private readonly apiKey: string | undefined;
  private readonly voiceId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly endpoint: string;
  private readonly language: string;
  private readonly timeoutMs: number;
  private readonly retryDelaysMs: readonly number[];

  constructor(options: XaiTtsProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.XAI_API_KEY;
    this.voiceId = options.voiceId ?? "eve";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.endpoint = options.endpoint ?? XAI_TTS_URL;
    this.language = options.language ?? TTS_LANGUAGE;
    this.timeoutMs = options.timeoutMs ?? XAI_TTS_TIMEOUT_MS;
    this.retryDelaysMs = options.retryDelaysMs ?? XAI_TTS_RETRY_DELAYS_MS;
  }

  async synthesize(request: TtsRequest): Promise<TtsResult> {
    const apiKey = this.apiKey;
    if (!apiKey) {
      throw new Error("XAI_API_KEY is required for text-to-speech synthesis.");
    }

    const input = `${request.title}\n\n${request.text}`;
    const estimatedCostUsd = assertWithinBudget(input.length, request.allowOverBudget);
    const chunks = splitSpeechInput(request.title, request.text);
    const wantTimestamps = Boolean(request.includeTimestamps);

    await mkdir(dirname(request.outputPath), { recursive: true });
    const buffers: Buffer[] = [];
    const allWords: TimedWord[] = [];
    let timeOffset = 0;

    for (const chunk of chunks) {
      const parsed = await this.renderChunk(apiKey, chunk, wantTimestamps, timeOffset);
      buffers.push(parsed.audio);
      allWords.push(...parsed.words);
      timeOffset = nextChunkTimeOffset(timeOffset, parsed);
    }

    await writeFile(request.outputPath, Buffer.concat(buffers));

    return {
      provider: this.name,
      outputPath: request.outputPath,
      estimatedCostUsd,
      ...(wantTimestamps && allWords.length > 0 ? { words: allWords } : {}),
    };
  }

  private async renderChunk(
    apiKey: string,
    chunk: string,
    wantTimestamps: boolean,
    timeOffset: number,
  ): Promise<ParsedChunk> {
    const delays = this.retryDelaysMs;
    let attempt = 0;

    for (;;) {
      let result: ChunkAttempt;
      try {
        result = await this.attemptChunk(apiKey, chunk, wantTimestamps, timeOffset);
      } catch (error) {
        if (!isTimeoutError(error) || attempt >= delays.length) {
          throw error;
        }
        await wait(delays[attempt] ?? 0);
        attempt += 1;
        continue;
      }

      if (result.kind === "audio") {
        return result.parsed;
      }
      if (!isRetryableStatus(result.status) || attempt >= delays.length) {
        throw mapXaiHttpError("tts", result.status, result.body);
      }
      await wait(delays[attempt] ?? 0);
      attempt += 1;
    }
  }

  private async attemptChunk(
    apiKey: string,
    chunk: string,
    wantTimestamps: boolean,
    timeOffset: number,
  ): Promise<ChunkAttempt> {
    const body: Record<string, unknown> = {
      text: chunk,
      voice_id: this.voiceId,
      language: this.language,
    };
    if (wantTimestamps) {
      body.with_timestamps = true;
    }

    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      return { kind: "status", status: response.status, body: await response.text() };
    }

    return {
      kind: "audio",
      parsed: await parseTtsResponse(response, wantTimestamps, timeOffset),
    };
  }
}

type ParsedChunk = { audio: Buffer; words: TimedWord[]; duration?: number };

type ChunkAttempt =
  | { kind: "audio"; parsed: ParsedChunk }
  | { kind: "status"; status: number; body: string };

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

function isTimeoutError(error: unknown): boolean {
  return (error instanceof DOMException || error instanceof Error) && error.name === "TimeoutError";
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function parseTtsResponse(
  response: Response,
  wantTimestamps: boolean,
  timeOffset: number,
): Promise<ParsedChunk> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!wantTimestamps || !contentType.includes("json")) {
    return { audio: Buffer.from(await response.arrayBuffer()), words: [] };
  }

  const payload = (await response.json()) as Partial<XaiTimestampResponse>;
  if (typeof payload.audio !== "string") {
    throw new Error("xAI TTS timestamp response did not include audio.");
  }

  const stamps = payload.audio_timestamps;
  const words =
    stamps?.graph_chars && stamps.graph_times
      ? wordsFromGraphTimestamps(stamps.graph_chars, stamps.graph_times, timeOffset)
      : [];

  return {
    audio: Buffer.from(payload.audio, "base64"),
    words,
    duration: payload.duration,
  };
}

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { splitSpeechInput } from "./chunk.js";
import { assertWithinBudget } from "./cost.js";
import { wordsFromGraphTimestamps } from "./timestamps.js";
import type { TimedWord, TtsProvider, TtsRequest, TtsResult } from "./types.js";
import { mapXaiHttpError, nextChunkTimeOffset, XAI_TIMEOUT_MS } from "./xaiHttp.js";

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
}

export class XaiTtsProvider implements TtsProvider {
  name = "xai";

  private readonly apiKey: string | undefined;
  private readonly voiceId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly endpoint: string;
  private readonly language: string;
  private readonly timeoutMs: number;

  constructor(options: XaiTtsProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.XAI_API_KEY;
    this.voiceId = options.voiceId ?? "eve";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.endpoint = options.endpoint ?? XAI_TTS_URL;
    this.language = options.language ?? TTS_LANGUAGE;
    this.timeoutMs = options.timeoutMs ?? XAI_TIMEOUT_MS;
  }

  async synthesize(request: TtsRequest): Promise<TtsResult> {
    if (!this.apiKey) {
      throw new Error("XAI_API_KEY is required for text-to-speech synthesis.");
    }

    const input = `${request.title}\n\n${request.text}`;
    const estimatedCostUsd = assertWithinBudget(input.length, request.allowOverBudget);
    const chunks = splitSpeechInput(request.title, request.text);

    await mkdir(dirname(request.outputPath), { recursive: true });
    const buffers: Buffer[] = [];
    const allWords: TimedWord[] = [];
    let timeOffset = 0;

    for (const chunk of chunks) {
      const body: Record<string, unknown> = {
        text: chunk,
        voice_id: this.voiceId,
        language: this.language,
      };
      if (request.includeTimestamps) {
        body.with_timestamps = true;
      }

      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        throw mapXaiHttpError("tts", response.status, await response.text());
      }

      const parsed = await parseTtsResponse(response, Boolean(request.includeTimestamps), timeOffset);
      buffers.push(parsed.audio);
      allWords.push(...parsed.words);
      timeOffset = nextChunkTimeOffset(timeOffset, parsed);
    }

    await writeFile(request.outputPath, Buffer.concat(buffers));

    return {
      provider: this.name,
      outputPath: request.outputPath,
      estimatedCostUsd,
      ...(request.includeTimestamps && allWords.length > 0 ? { words: allWords } : {}),
    };
  }
}

async function parseTtsResponse(
  response: Response,
  wantTimestamps: boolean,
  timeOffset: number,
): Promise<{ audio: Buffer; words: TimedWord[]; duration?: number }> {
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

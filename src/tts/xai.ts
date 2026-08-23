import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { splitSpeechInput } from "./chunk.js";
import { assertWithinBudget } from "./cost.js";
import { wordsFromGraphTimestamps } from "./timestamps.js";
import type { TtsProvider, TtsRequest, TtsResult } from "./types.js";

const XAI_TTS_URL = "https://api.x.ai/v1/tts";

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
}

export class XaiTtsProvider implements TtsProvider {
  name = "xai";

  private readonly apiKey: string | undefined;
  private readonly voiceId: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: XaiTtsProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.XAI_API_KEY;
    this.voiceId = options.voiceId ?? "eve";
    this.fetchImpl = options.fetchImpl ?? fetch;
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
    const allWords: NonNullable<TtsResult["words"]> = [];
    let timeOffset = 0;

    for (const chunk of chunks) {
      const body: Record<string, unknown> = {
        text: chunk,
        voice_id: this.voiceId,
        language: "en",
      };
      if (request.includeTimestamps) {
        body.with_timestamps = true;
      }

      const response = await this.fetchImpl(XAI_TTS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new Error(`xAI TTS request failed: ${response.status} ${await response.text()}`);
      }

      if (request.includeTimestamps) {
        const payload = (await response.json()) as XaiTimestampResponse;
        buffers.push(Buffer.from(payload.audio, "base64"));

        const chunkWords = wordsFromGraphTimestamps(
          payload.audio_timestamps.graph_chars,
          payload.audio_timestamps.graph_times,
          timeOffset,
        );
        allWords.push(...chunkWords);

        if (payload.duration != null) {
          timeOffset += payload.duration;
        } else if (chunkWords.length > 0) {
          timeOffset = chunkWords[chunkWords.length - 1]!.end;
        }
      } else {
        buffers.push(Buffer.from(await response.arrayBuffer()));
      }
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

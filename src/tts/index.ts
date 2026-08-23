import { XaiTtsProvider } from "./xai.js";
import type { TtsProvider } from "./types.js";

export const DEFAULT_TTS_PROVIDER = "xai";

export function createTtsProvider(providerName = DEFAULT_TTS_PROVIDER): TtsProvider {
  if (providerName === "xai") {
    return new XaiTtsProvider();
  }

  throw new Error(`Unsupported TTS provider "${providerName}". Available providers: xai.`);
}

export { XaiTtsProvider, type XaiTtsProviderOptions } from "./xai.js";
export { splitSpeechInput } from "./chunk.js";
export { wordsFromGraphTimestamps } from "./timestamps.js";
export type { TimedWord, TtsProvider, TtsRequest, TtsResult } from "./types.js";

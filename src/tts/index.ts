import { XaiTtsProvider } from "./xai.js";
import type { TtsProvider } from "./types.js";

export function createTtsProvider(providerName: string): TtsProvider {
  if (providerName === "xai") {
    return new XaiTtsProvider();
  }

  throw new Error(`Unsupported TTS provider "${providerName}". Available providers: xai.`);
}

export type { TtsProvider, TtsRequest, TtsResult } from "./types.js";

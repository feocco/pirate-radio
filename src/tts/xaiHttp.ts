import { creditExhausted, redactCreditBody } from "../credits.js";

export const XAI_TIMEOUT_MS = 60_000;
export const XAI_TTS_TIMEOUT_MS = 120_000;
export const XAI_TTS_RETRY_DELAYS_MS = [1_000, 4_000] as const;
export const XAI_ERROR_BODY_LIMIT = 120;
const MP3_BYTES_PER_SECOND = 16_000;
const XAI_CREDIT_PHRASE = /used all available credits|monthly spending limit|doesn['’]t have any credits/i;

export function isXaiCreditExhausted(status: number, body: string): boolean {
  return (status === 403 || status === 429) && XAI_CREDIT_PHRASE.test(body);
}

export function mapXaiHttpError(operation: "tts" | "stt", status: number, body: string): Error {
  const snippet = redactCreditBody(body, XAI_ERROR_BODY_LIMIT);
  if (snippet.length > 0) {
    console.error(`xAI ${operation} ${status}: ${snippet}`);
  }
  if (isXaiCreditExhausted(status, body)) {
    return creditExhausted({ provider: "xai", status, body });
  }
  return new Error(`xAI ${operation} failed (${status})`);
}

export function nextChunkTimeOffset(
  currentOffset: number,
  chunk: { duration?: number; words: { end: number }[]; audio: Buffer },
): number {
  if (chunk.duration != null && Number.isFinite(chunk.duration) && chunk.duration >= 0) {
    return currentOffset + chunk.duration;
  }
  if (chunk.words.length > 0) {
    return chunk.words[chunk.words.length - 1]!.end;
  }
  return currentOffset + Math.max(chunk.audio.byteLength / MP3_BYTES_PER_SECOND, 0.01);
}

export const XAI_TIMEOUT_MS = 60_000;
export const XAI_ERROR_BODY_LIMIT = 120;
const MP3_BYTES_PER_SECOND = 16_000;

export function mapXaiHttpError(operation: "tts" | "stt", status: number, body: string): Error {
  const snippet = body.replace(/\s+/g, " ").trim().slice(0, XAI_ERROR_BODY_LIMIT);
  if (snippet.length > 0) {
    console.error(`xAI ${operation} ${status}: ${snippet}`);
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

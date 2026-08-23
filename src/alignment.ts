import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

export interface AlignmentWord {
  word: string;
  start: number;
  end: number;
}

export interface AlignmentResult {
  words: AlignmentWord[];
}

export interface AlignmentArtifact {
  alignmentPath: string;
  alignmentUrl: string;
}

export interface WriteAlignmentInput {
  libraryDir: string;
  slug: string;
  audioPath: string;
  words?: AlignmentWord[];
  transcribe?: (audioPath: string) => Promise<AlignmentResult>;
}

export async function writeAlignment(input: WriteAlignmentInput): Promise<AlignmentArtifact> {
  const result = input.words
    ? { words: input.words }
    : await (input.transcribe ?? transcribeWithXai)(input.audioPath);
  const alignmentDir = join(input.libraryDir, "alignment");
  const alignmentPath = join(alignmentDir, `${input.slug}.json`);
  await mkdir(alignmentDir, { recursive: true });
  await writeFile(alignmentPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return {
    alignmentPath,
    alignmentUrl: `/alignment/${input.slug}.json`,
  };
}

async function transcribeWithXai(audioPath: string): Promise<AlignmentResult> {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    throw new Error("XAI_API_KEY is required for speech-to-text alignment.");
  }

  const formData = new FormData();
  const audioBytes = await readFile(audioPath);
  formData.append("file", new Blob([audioBytes]), basename(audioPath));

  const response = await fetch("https://api.x.ai/v1/stt", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`xAI STT request failed: ${response.status} ${await response.text()}`);
  }

  const payload = (await response.json()) as {
    words?: Array<{ text?: string; word?: string; start: number; end: number }>;
  };
  const words = Array.isArray(payload.words) ? payload.words : [];
  return {
    words: words
      .map((entry) => ({
        word: String(entry.text ?? entry.word ?? ""),
        start: Number(entry.start),
        end: Number(entry.end),
      }))
      .filter((word) => word.word && Number.isFinite(word.start) && Number.isFinite(word.end)),
  };
}

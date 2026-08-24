import type { TimedWord } from "./types.js";

export function wordsFromGraphTimestamps(
  graph_chars: string[],
  graph_times: [number, number][],
  offsetSeconds = 0,
): TimedWord[] {
  const words: TimedWord[] = [];
  let currentWord = "";
  let wordStart: number | undefined;
  let wordEnd: number | undefined;

  for (let index = 0; index < graph_chars.length; index += 1) {
    const character = graph_chars[index] ?? "";
    const times = graph_times[index];
    if (!times) {
      continue;
    }
    const [start, end] = times;

    if (/\s/.test(character)) {
      if (currentWord) {
        words.push({
          word: currentWord,
          start: wordStart! + offsetSeconds,
          end: wordEnd! + offsetSeconds,
        });
        currentWord = "";
        wordStart = undefined;
        wordEnd = undefined;
      }
      continue;
    }

    if (!currentWord) {
      wordStart = start;
    }
    currentWord += character;
    wordEnd = end;
  }

  if (currentWord && wordStart !== undefined && wordEnd !== undefined) {
    words.push({
      word: currentWord,
      start: wordStart + offsetSeconds,
      end: wordEnd + offsetSeconds,
    });
  }

  return words;
}

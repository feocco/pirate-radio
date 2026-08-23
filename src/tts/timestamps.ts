export interface TimestampWord {
  word: string;
  start: number;
  end: number;
}

export function wordsFromGraphTimestamps(
  graph_chars: string[],
  graph_times: [number, number][],
  offsetSeconds = 0,
): TimestampWord[] {
  const words: TimestampWord[] = [];
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

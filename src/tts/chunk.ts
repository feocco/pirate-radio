const DEFAULT_MAX_SPEECH_CHARS = 5_000;

export function splitSpeechInput(
  title: string,
  text: string,
  maxChars = DEFAULT_MAX_SPEECH_CHARS,
): string[] {
  const chunks: string[] = [];
  let current = "";

  const flush = () => {
    if (current.length === 0) {
      return;
    }
    chunks.push(current);
    current = "";
  };

  const placeFitting = (part: string) => {
    if (part.length === 0 || part.length > maxChars) {
      return;
    }
    if (current.length === 0) {
      current = part;
      return;
    }
    if (current.length + part.length <= maxChars) {
      current += part;
      return;
    }
    flush();
    current = part;
  };

  const place = (part: string) => {
    if (part.length <= maxChars) {
      placeFitting(part);
      return;
    }
    for (let offset = 0; offset < part.length; ) {
      const piece = part.slice(offset, offset + maxChars);
      if (piece.length === 0) {
        break;
      }
      placeFitting(piece);
      offset += piece.length;
    }
  };

  const paragraphs = [title.trim(), ...splitParagraphs(text)].filter((part) => part.length > 0);
  for (const paragraph of paragraphs) {
    if (current.length > 0 && current.length + paragraph.length + 2 <= maxChars) {
      current = `${current}\n\n${paragraph}`;
      continue;
    }
    if (paragraph.length <= maxChars) {
      flush();
      current = paragraph;
      continue;
    }
    flush();
    for (const sentence of splitSentences(paragraph)) {
      if (sentence.length <= maxChars) {
        place(sentence);
        continue;
      }
      for (const token of splitTokens(sentence)) {
        place(token);
      }
    }
  }

  flush();
  return chunks;
}

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function splitSentences(paragraph: string): string[] {
  const sentences: string[] = [];
  let start = 0;
  for (let index = 0; index < paragraph.length; index += 1) {
    if (!isSentencePunctuation(paragraph[index] ?? "")) {
      continue;
    }
    let end = index + 1;
    while (end < paragraph.length && isSentencePunctuation(paragraph[end] ?? "")) {
      end += 1;
    }
    sentences.push(paragraph.slice(start, end));
    start = end;
    index = end - 1;
  }
  if (start < paragraph.length) {
    sentences.push(paragraph.slice(start));
  }
  return sentences;
}

function isSentencePunctuation(char: string): boolean {
  return char === "." || char === "!" || char === "?";
}

function splitTokens(sentence: string): string[] {
  return sentence.match(/\s+|\S+/g) ?? [];
}

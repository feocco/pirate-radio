const DEFAULT_MAX_SPEECH_CHARS = 14000;

export function splitSpeechInput(
  title: string,
  text: string,
  maxChars = DEFAULT_MAX_SPEECH_CHARS,
): string[] {
  const paragraphs = text.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = title.trim();

  for (const paragraph of paragraphs) {
    const next = current ? `${current}\n\n${paragraph}` : paragraph;
    if (next.length <= maxChars) {
      current = next;
      continue;
    }
    if (current) {
      chunks.push(current);
    }
    if (paragraph.length <= maxChars) {
      current = paragraph;
    } else {
      const sentences = paragraph.match(/[^.!?]+[.!?]+|\S[\s\S]{0,500}(?=\s|$)/g) ?? [paragraph];
      current = "";
      for (const sentence of sentences.map((value) => value.trim()).filter(Boolean)) {
        const sentenceNext = current ? `${current} ${sentence}` : sentence;
        if (sentenceNext.length <= maxChars) {
          current = sentenceNext;
        } else {
          if (current) {
            chunks.push(current);
          }
          current = sentence.slice(0, maxChars);
        }
      }
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

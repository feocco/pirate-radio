import type { ParsedArticle } from "./engine.js";

export type InvariantCode = "empty_title" | "empty_body" | "raw_html" | "script_text";

const SCRIPT_TEXT = /javascript\s*:|<\s*\/?\s*script\b|<\s*\/?\s*style\b/i;
const TAG_SHAPED = /<\/?[A-Za-z]/;
const ESCAPED_MARKUP = /&lt;/i;

export function checkInvariants(parsed: ParsedArticle): Array<{ code: InvariantCode; detail: string }> {
  const issues: Array<{ code: InvariantCode; detail: string }> = [];
  if (!parsed.title.trim()) issues.push({ code: "empty_title", detail: "title is empty" });
  if (!parsed.blocks.some((block) => block.text.trim())) {
    issues.push({ code: "empty_body", detail: "body has no text blocks" });
  }

  const fields: Array<[string, string | undefined]> = [
    ["title", parsed.title],
    ["byline", parsed.byline],
    ["publishedAt", parsed.publishedAt],
    ["heroImageUrl", parsed.heroImageUrl],
  ];
  parsed.blocks.forEach((block, index) => fields.push([`blocks[${index}]`, block.text]));
  parsed.images.forEach((image, index) => {
    fields.push([`images[${index}].src`, image.src]);
    fields.push([`images[${index}].alt`, image.alt]);
  });

  for (const [path, value] of fields) {
    if (!value) continue;
    if (SCRIPT_TEXT.test(value)) issues.push({ code: "script_text", detail: `${path} contains script content` });
    if (TAG_SHAPED.test(value) || ESCAPED_MARKUP.test(value)) {
      issues.push({ code: "raw_html", detail: `${path} contains raw HTML` });
    }
  }
  return issues;
}

import { selectAll } from "css-select";
import { isTag, isText, type ChildNode, type Document, type Element } from "domhandler";
import { removeElement } from "domutils";
import { parseDocument } from "htmlparser2";
import type { Story } from "../types.js";
import type { AllowedAttr, BlockKind, FieldRule, ParserSpecV1, TextCleanup, TextMatch } from "./spec.js";

export interface ParsedArticle {
  title: string;
  byline?: string;
  publishedAt?: string;
  heroImageUrl?: string;
  blocks: Array<{ kind: Exclude<BlockKind, "image">; text: string }>;
  images: Array<{ src: string; alt?: string }>;
}

const SKIPPED_TAGS = new Set(["script", "style", "template"]);
const INLINE_TAGS = new Set([
  "a",
  "abbr",
  "b",
  "bdi",
  "bdo",
  "cite",
  "code",
  "data",
  "dfn",
  "em",
  "i",
  "kbd",
  "mark",
  "q",
  "s",
  "samp",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "time",
  "u",
  "var",
]);

export class ParserRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParserRunError";
  }
}

function queryAll(selector: string, scope: Document | Element): Element[] {
  return selectAll<Document | Element, Element>(selector, scope);
}

export function runParser(spec: ParserSpecV1, html: string, pageUrl: string): ParsedArticle {
  assertPageUrl(pageUrl);
  const document = parseDocument(html);
  for (const template of queryAll("template", document)) removeElement(template);

  const title = readField(document, spec.title, pageUrl, false) ?? "";
  const byline = readField(document, spec.byline, pageUrl, false);
  const publishedAt = readField(document, spec.publishedAt, pageUrl, false);
  const heroImageUrl = readField(document, spec.heroImage, pageUrl, true);
  const roots = queryAll(spec.body.root, document);
  if (roots.length !== 1) {
    throw new ParserRunError(`body.root matched ${roots.length} elements; it must match exactly one`);
  }
  const root = roots[0];
  if (!root) {
    throw new ParserRunError("body.root matched 0 elements; it must match exactly one");
  }

  for (const selector of spec.body.remove ?? []) {
    for (const element of queryAll(selector, root)) removeElement(element);
  }
  const stop = firstInDocumentOrder(root, spec.body.stopAt ?? []);
  if (stop) truncateFrom(root, stop);

  const parsed: ParsedArticle = {
    title,
    blocks: collectBlocks(root, spec),
    images: collectImages(root, spec, pageUrl),
  };
  if (byline) parsed.byline = byline;
  if (publishedAt) parsed.publishedAt = publishedAt;
  if (heroImageUrl) parsed.heroImageUrl = heroImageUrl;
  return parsed;
}

export function toStory(parsed: ParsedArticle, sourceUrl: string, now: Date): Story {
  const contentBlocks = parsed.blocks.map((block) => ({ type: block.kind, text: block.text }));
  const text = contentBlocks.map((block) => block.text).join("\n\n");
  const sectionTitles = contentBlocks.filter((block) => block.type === "heading").map((block) => block.text);
  const story: Story = {
    sourceUrl,
    title: parsed.title,
    text,
    contentBlocks,
    wordCount: countWords(text),
    characterCount: text.length,
    extractedAt: now.toISOString(),
  };
  if (parsed.byline) story.author = parsed.byline;
  if (parsed.heroImageUrl) story.heroImageOriginalUrl = parsed.heroImageUrl;
  if (sectionTitles.length > 0) story.sectionTitles = sectionTitles;
  return story;
}

function assertPageUrl(pageUrl: string) {
  let parsed: URL;
  try {
    parsed = new URL(pageUrl);
  } catch {
    throw new ParserRunError("pageUrl must be an absolute http(s) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ParserRunError("pageUrl must be an absolute http(s) URL");
  }
}

function readField(document: Document, rule: FieldRule | undefined, pageUrl: string, resolveUrls: boolean): string | undefined {
  if (!rule) return undefined;
  for (const source of rule.from) {
    for (const element of queryAll(source.select, document)) {
      const cleaned = applyCleanups(readElementValue(element, source.attr), rule.cleanup);
      if (!cleaned) continue;
      return resolveUrls ? resolveUrl(cleaned, pageUrl) : cleaned;
    }
  }
  return undefined;
}

function readElementValue(element: Element, attr: AllowedAttr | undefined): string {
  if (!attr) return elementText(element);
  if (attr === "srcset") return firstSrcsetUrl(element.attribs.srcset ?? "");
  return element.attribs[attr] ?? "";
}

function collectBlocks(root: Element, spec: ParserSpecV1): ParsedArticle["blocks"] {
  const hits: Array<{ element: Element; kind: Exclude<BlockKind, "image">; index: number }> = [];
  spec.body.blocks.forEach((block, index) => {
    if (block.as === "image") return;
    for (const element of queryAll(block.select, root)) hits.push({ element, kind: block.as, index });
  });
  sortByDocumentOrder(root, hits);
  const emitted: Element[] = [];
  const seen = new Set<Element>();
  const blocks: ParsedArticle["blocks"] = [];
  for (const hit of hits) {
    if (seen.has(hit.element)) continue;
    seen.add(hit.element);
    if (emitted.some((parent) => isInside(parent, hit.element))) continue;
    emitted.push(hit.element);
    const text = applyCleanups(elementText(hit.element), spec.body.cleanup);
    if (!text || (spec.body.dropBlocksWhere ?? []).some((rule) => matchesText(text, rule))) continue;
    blocks.push({ kind: hit.kind, text });
  }
  return blocks;
}

function collectImages(root: Element, spec: ParserSpecV1, pageUrl: string): ParsedArticle["images"] {
  const hits: Array<{ element: Element; index: number }> = [];
  spec.body.blocks.forEach((block, index) => {
    if (block.as !== "image") return;
    for (const element of queryAll(block.select, root)) hits.push({ element, index });
  });
  sortByDocumentOrder(root, hits);
  const used = new Set<Element>();
  const images: ParsedArticle["images"] = [];
  for (const hit of hits) {
    const image = hit.element.name === "img" ? hit.element : firstImage(hit.element);
    if (!image || used.has(image)) continue;
    used.add(image);
    const rawSrc = (image.attribs.src ?? "").trim() || firstSrcsetUrl(image.attribs.srcset ?? "");
    if (!rawSrc) continue;
    const alt = collapseWhitespace(image.attribs.alt ?? "");
    if (alt && (spec.body.dropBlocksWhere ?? []).some((rule) => matchesText(alt, rule))) continue;
    const src = resolveUrl(rawSrc, pageUrl);
    images.push(alt ? { src, alt } : { src });
  }
  return images;
}

function firstInDocumentOrder(root: Element, selectors: readonly string[]): Element | undefined {
  const hits = selectors.flatMap((selector) => queryAll(selector, root).map((element) => ({ element, index: 0 })));
  sortByDocumentOrder(root, hits);
  return hits[0]?.element;
}

function sortByDocumentOrder<T extends { element: Element; index: number }>(root: Element, hits: T[]) {
  const order = documentOrder(root);
  hits.sort(
    (left, right) =>
      (order.get(left.element) ?? 0) - (order.get(right.element) ?? 0) || left.index - right.index,
  );
}

function documentOrder(root: Element): Map<Element, number> {
  const order = new Map<Element, number>();
  let next = 0;
  const visit = (element: Element) => {
    order.set(element, next);
    next += 1;
    for (const child of element.children) {
      if (isTag(child)) visit(child);
    }
  };
  visit(root);
  return order;
}

function truncateFrom(root: Element, stop: Element) {
  let current: ChildNode | null = stop;
  let removeCurrent = true;
  while (current && current !== root) {
    let sibling: ChildNode | null = current.nextSibling;
    while (sibling) {
      const next: ChildNode | null = sibling.nextSibling;
      removeElement(sibling);
      sibling = next;
    }
    const parent: ChildNode | null = current.parent;
    if (removeCurrent) {
      removeElement(current);
      removeCurrent = false;
    }
    current = parent;
  }
}

function isInside(ancestor: Element, node: Element): boolean {
  let current = node.parent;
  while (current) {
    if (current === ancestor) return true;
    if (!isTag(current)) return false;
    current = current.parent;
  }
  return false;
}

function firstImage(element: Element): Element | undefined {
  for (const child of element.children) {
    if (!isTag(child) || SKIPPED_TAGS.has(child.name)) continue;
    if (child.name === "img") return child;
    const nested = firstImage(child);
    if (nested) return nested;
  }
  return undefined;
}

function elementText(element: Element): string {
  if (SKIPPED_TAGS.has(element.name)) return "";
  return collapseWhitespace(rawText(element));
}

function rawText(element: Element): string {
  let text = "";
  for (const child of element.children) {
    if (isText(child)) {
      text += child.data;
      continue;
    }
    if (!isTag(child)) continue;
    if (child.name === "br") {
      text += " ";
      continue;
    }
    if (SKIPPED_TAGS.has(child.name)) continue;
    const inner = rawText(child);
    text += INLINE_TAGS.has(child.name) ? inner : ` ${inner} `;
  }
  return text;
}

function applyCleanups(value: string, cleanups: readonly TextCleanup[] | undefined): string {
  let text = collapseWhitespace(value);
  for (const step of cleanups ?? []) {
    if (step.op === "replaceExact") {
      if (text === step.from) text = step.to;
      continue;
    }
    text = stripAffix(text, step.value, step.caseInsensitive === true, step.op === "stripPrefix" ? "start" : "end");
  }
  return text.trim();
}

function stripAffix(text: string, token: string, caseInsensitive: boolean, edge: "start" | "end"): string {
  if (token.length === 0 || text.length < token.length) return text;
  const slice = edge === "start" ? text.slice(0, token.length) : text.slice(-token.length);
  const actual = caseInsensitive ? slice.toLowerCase() : slice;
  const expected = caseInsensitive ? token.toLowerCase() : token;
  if (actual !== expected) return text;
  const next = edge === "start" ? text.slice(token.length) : text.slice(0, -token.length);
  return next.trim();
}

function matchesText(text: string, rule: TextMatch): boolean {
  if ("equals" in rule) {
    return rule.caseInsensitive === true ? text.toLowerCase() === rule.equals.toLowerCase() : text === rule.equals;
  }
  if ("startsWith" in rule) {
    return rule.caseInsensitive === true
      ? text.toLowerCase().startsWith(rule.startsWith.toLowerCase())
      : text.startsWith(rule.startsWith);
  }
  return rule.caseInsensitive === true
    ? text.toLowerCase().includes(rule.contains.toLowerCase())
    : text.includes(rule.contains);
}

function firstSrcsetUrl(srcset: string): string {
  const first = srcset.split(",")[0]?.trim() ?? "";
  const unquoted = first.replace(/^["']|["']$/g, "");
  return unquoted.split(/\s+/)[0] ?? "";
}

function resolveUrl(value: string, pageUrl: string): string {
  try {
    return new URL(value, pageUrl).href;
  } catch {
    return value;
  }
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

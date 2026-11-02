import { createHash } from "node:crypto";
import { runParser, toStory, type ParsedArticle } from "./engine.js";
import { markupIssues } from "./invariants.js";
import type { ParserSpecV1 } from "./spec.js";

type Words5 = [string, string, string, string, string];

export interface ParserCriteriaV1 {
  schema: "pirate-radio/parser-criteria@1";
  parserId: string;
  host: string;
  digest: string;
  examples: CriteriaExample[];
}

export interface CriteriaExample {
  submissionId: string;
  url: string;
  fixture: string;
  rawSnapshotSha256: string;
  title: string;
  firstWords: Words5;
  lastWords: Words5;
  phrases: string[];
}

export type AcceptanceGate =
  | "title"
  | "first_words"
  | "last_words"
  | "phrases_ordered"
  | "no_script_or_raw_html";

export interface ExtractionMetadata {
  author?: string;
  publishedAt?: string;
  heroImageUrl?: string;
  wordCount: number;
  characterCount: number;
  imageCount: number;
}

const SCHEMA = "pirate-radio/parser-criteria@1";
const TOP_KEYS = ["schema", "parserId", "host", "digest", "examples"];
const EXAMPLE_KEYS = [
  "submissionId",
  "url",
  "fixture",
  "rawSnapshotSha256",
  "title",
  "firstWords",
  "lastWords",
  "phrases",
];
const GATES: readonly AcceptanceGate[] = [
  "title",
  "first_words",
  "last_words",
  "phrases_ordered",
  "no_script_or_raw_html",
];
export const fixtureBytesMax = 1_000_000;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const FIXTURE_PATH = /^fixtures\/[0-9a-f]{64}\.html$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

export class CriteriaError extends Error {
  readonly issues: ReadonlyArray<{ path: string; message: string }>;

  constructor(issues: ReadonlyArray<{ path: string; message: string }>) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"));
    this.name = "CriteriaError";
    this.issues = issues;
  }
}

class Issues {
  readonly items: Array<{ path: string; message: string }> = [];

  add(path: string, message: string) {
    this.items.push({ path, message });
  }
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function criteriaDigest(examples: readonly CriteriaExample[]): string {
  return sha256Hex(canonicalJson(examples));
}

export function parseParserCriteria(raw: unknown): ParserCriteriaV1 {
  if (!isRecord(raw)) {
    throw new CriteriaError([{ path: "$", message: "criteria must be a JSON object" }]);
  }

  const issues = new Issues();
  rejectUnknown(raw, "", TOP_KEYS, issues);
  if (raw.schema !== SCHEMA) issues.add("schema", `schema must be "${SCHEMA}"`);
  const parserId = readParserId(raw.parserId, issues);
  const host = readHost(raw.host, issues);
  const examples = readExamples(raw.examples, host, issues);
  const digest = readDigest(raw.digest, issues);
  if (examples && digest && digest !== criteriaDigest(examples)) {
    issues.add("digest", "digest must be the sha256 of the canonical examples");
  }

  if (issues.items.length > 0 || !parserId || !host || !examples || !digest) {
    throw new CriteriaError(issues.items.length > 0 ? issues.items : [{ path: "$", message: "criteria are invalid" }]);
  }

  return freeze({ schema: SCHEMA, parserId, host, digest, examples });
}

export function evaluateCriteria(
  spec: ParserSpecV1,
  criteria: ParserCriteriaV1,
  readFixture: (path: string) => string,
): {
  gates: Array<{ example: number; gate: AcceptanceGate; ok: boolean; detail?: string }>;
  metadata: ExtractionMetadata[];
} {
  assertBound(spec, criteria);
  const gates: Array<{ example: number; gate: AcceptanceGate; ok: boolean; detail?: string }> = [];
  const metadata: ExtractionMetadata[] = [];

  criteria.examples.forEach((example, index) => {
    const html = readHtml(example.fixture, index, readFixture);
    const parsed = runParser(spec, html, example.url);
    const story = toStory(parsed, example.url, new Date(0));
    gates.push(...judgeExample(index, example, parsed, story.text));
    metadata.push(reportMetadata(parsed, story));
  });

  return { gates, metadata };
}

function assertBound(spec: ParserSpecV1, criteria: ParserCriteriaV1) {
  const issues = new Issues();
  if (criteria.parserId !== spec.id) issues.add("parserId", "parserId must equal the spec id");
  if (!spec.hosts.includes(criteria.host)) issues.add("host", "host must be listed in spec.hosts");
  if (criteria.digest !== criteriaDigest(criteria.examples)) {
    issues.add("digest", "digest must be the sha256 of the canonical examples");
  }
  criteria.examples.forEach((example, index) => {
    if (hostOf(example.url) !== criteria.host) issues.add(`examples[${index}].url`, "url host must equal host");
  });
  if (issues.items.length > 0) throw new CriteriaError(issues.items);
}

function readHtml(fixture: string, index: number, readFixture: (path: string) => string): string {
  const path = `examples[${index}].fixture`;
  if (!FIXTURE_PATH.test(fixture)) {
    throw new CriteriaError([{ path, message: "fixture must be fixtures/<sha256>.html" }]);
  }
  const html = readFixture(fixture);
  if (typeof html !== "string") {
    throw new CriteriaError([{ path, message: "readFixture must return the fixture HTML string" }]);
  }
  const bytes = new TextEncoder().encode(html).byteLength;
  if (bytes > fixtureBytesMax) {
    throw new CriteriaError([{ path, message: `fixture is larger than ${fixtureBytesMax} bytes` }]);
  }
  const named = fixture.slice("fixtures/".length, -".html".length);
  const actual = sha256Hex(html);
  if (actual !== named) {
    throw new CriteriaError([{ path, message: "content sha256 does not match the fixture name" }]);
  }
  return html;
}

function judgeExample(
  index: number,
  example: CriteriaExample,
  parsed: ParsedArticle,
  bodyText: string,
): Array<{ example: number; gate: AcceptanceGate; ok: boolean; detail?: string }> {
  const words = bodyWords(bodyText);
  const first = words.slice(0, 5);
  const last = words.slice(-5);
  const middle = words.length >= 10 ? words.slice(5, -5) : [];
  const phraseDetail = orderedPhraseDetail(example.phrases, middle);
  const markup = [
    ...markupIssues("title", parsed.title),
    ...parsed.blocks.flatMap((block, blockIndex) => markupIssues(`blocks[${blockIndex}]`, block.text)),
  ];
  const extractedTitle = collapse(parsed.title);
  const results = new Map<AcceptanceGate, string | undefined>([
    ["title", extractedTitle === example.title ? undefined : mismatch(example.title, extractedTitle)],
    [
      "first_words",
      sameWords(example.firstWords, first) ? undefined : mismatch(example.firstWords.join(" "), first.join(" ")),
    ],
    [
      "last_words",
      sameWords(example.lastWords, last) ? undefined : mismatch(example.lastWords.join(" "), last.join(" ")),
    ],
    ["phrases_ordered", phraseDetail],
    ["no_script_or_raw_html", markup.length > 0 ? markup.map((issue) => issue.detail).join("; ") : undefined],
  ]);

  return GATES.map((gate) => {
    const detail = results.get(gate);
    const row: { example: number; gate: AcceptanceGate; ok: boolean; detail?: string } = {
      example: index,
      gate,
      ok: detail === undefined,
    };
    if (detail !== undefined) row.detail = detail;
    return row;
  });
}

function reportMetadata(parsed: ParsedArticle, story: ReturnType<typeof toStory>): ExtractionMetadata {
  const metadata: ExtractionMetadata = {
    wordCount: story.wordCount,
    characterCount: story.characterCount,
    imageCount: parsed.images.length,
  };
  if (story.author) metadata.author = story.author;
  if (parsed.publishedAt) metadata.publishedAt = parsed.publishedAt;
  if (story.heroImageOriginalUrl) metadata.heroImageUrl = story.heroImageOriginalUrl;
  return metadata;
}

function orderedPhraseDetail(phrases: readonly string[], middle: readonly string[]): string | undefined {
  let from = 0;
  for (let index = 0; index < phrases.length; index += 1) {
    const phrase = phrases[index] ?? "";
    const parts = phrase.split(" ");
    const at = findPhrase(middle, parts, from);
    if (at < 0) return `phrase ${index + 1} "${phrase}" is not between the anchors in order`;
    from = at + parts.length;
  }
  return undefined;
}

function findPhrase(words: readonly string[], phrase: readonly string[], from: number): number {
  const width = phrase.length;
  for (let index = from; index + width <= words.length; index += 1) {
    let matches = true;
    for (let offset = 0; offset < width; offset += 1) {
      if (words[index + offset] !== phrase[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) return index;
  }
  return -1;
}

function bodyWords(text: string): string[] {
  const collapsed = collapse(text);
  return collapsed ? collapsed.split(" ") : [];
}

function sameWords(expected: readonly string[], actual: readonly string[]): boolean {
  return expected.length === actual.length && expected.every((word, index) => word === actual[index]);
}

function mismatch(expected: string, actual: string): string {
  return `expected "${expected}", extracted "${actual}"`;
}

function readParserId(value: unknown, issues: Issues): string | undefined {
  if (typeof value !== "string" || value.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    issues.add("parserId", "parserId must be kebab-case");
    return undefined;
  }
  return value;
}

function readHost(value: unknown, issues: Issues): string | undefined {
  if (typeof value !== "string" || value.startsWith("www.") || !HOSTNAME.test(value) || isIpv4(value)) {
    issues.add("host", "host must be a lowercase hostname with www. already removed");
    return undefined;
  }
  return value;
}

function readDigest(value: unknown, issues: Issues): string | undefined {
  if (typeof value !== "string" || !SHA256_HEX.test(value)) {
    issues.add("digest", "digest must be a lowercase sha256 hex string");
    return undefined;
  }
  return value;
}

function readExamples(value: unknown, host: string | undefined, issues: Issues): CriteriaExample[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) {
    issues.add("examples", "examples must contain 1 to 3 examples");
    return undefined;
  }
  const examples: CriteriaExample[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const example = readExample(value[index], host, index, issues);
    if (example) examples.push(example);
  }
  return examples.length === value.length ? examples : undefined;
}

function readExample(value: unknown, host: string | undefined, index: number, issues: Issues): CriteriaExample | undefined {
  const path = `examples[${index}]`;
  if (!isRecord(value)) {
    issues.add(path, "example must be an object");
    return undefined;
  }
  rejectUnknown(value, path, EXAMPLE_KEYS, issues);
  const submissionId = readSubmissionId(value.submissionId, `${path}.submissionId`, issues);
  const url = readUrl(value.url, host, `${path}.url`, issues);
  const fixture = readFixturePath(value.fixture, `${path}.fixture`, issues);
  const rawSnapshotSha256 = readSha(value.rawSnapshotSha256, `${path}.rawSnapshotSha256`, issues);
  const title = readTitle(value.title, `${path}.title`, issues);
  const firstWords = readWords(value.firstWords, `${path}.firstWords`, issues);
  const lastWords = readWords(value.lastWords, `${path}.lastWords`, issues);
  const phrases = readPhrases(value.phrases, `${path}.phrases`, issues);
  if (!submissionId || !url || !fixture || !rawSnapshotSha256 || !title || !firstWords || !lastWords || !phrases) {
    return undefined;
  }
  return { submissionId, url, fixture, rawSnapshotSha256, title, firstWords, lastWords, phrases };
}

function readSubmissionId(value: unknown, path: string, issues: Issues): string | undefined {
  if (typeof value !== "string" || !UUID.test(value)) {
    issues.add(path, "submissionId must be a lowercase UUID");
    return undefined;
  }
  return value;
}

function readUrl(value: unknown, host: string | undefined, path: string, issues: Issues): string | undefined {
  if (typeof value !== "string") {
    issues.add(path, "url must be an absolute http(s) URL");
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    issues.add(path, "url must be an absolute http(s) URL");
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    issues.add(path, "url must be an absolute http(s) URL");
    return undefined;
  }
  if (parsed.username || parsed.password) {
    issues.add(path, "url must not include credentials");
    return undefined;
  }
  if (host && parsed.hostname !== host) {
    issues.add(path, "url host must equal host");
    return undefined;
  }
  return value;
}

function readFixturePath(value: unknown, path: string, issues: Issues): string | undefined {
  if (typeof value !== "string" || !FIXTURE_PATH.test(value)) {
    issues.add(path, "fixture must be fixtures/<sha256>.html");
    return undefined;
  }
  return value;
}

function readSha(value: unknown, path: string, issues: Issues): string | undefined {
  if (typeof value !== "string" || !SHA256_HEX.test(value)) {
    issues.add(path, "must be a lowercase sha256 hex string");
    return undefined;
  }
  return value;
}

function readTitle(value: unknown, path: string, issues: Issues): string | undefined {
  if (typeof value !== "string") {
    issues.add(path, "title must not be empty");
    return undefined;
  }
  const title = collapse(value);
  if (!title) {
    issues.add(path, "title must not be empty");
    return undefined;
  }
  return title;
}

function readWords(value: unknown, path: string, issues: Issues): Words5 | undefined {
  if (!Array.isArray(value) || value.length !== 5) {
    issues.add(path, "must be five words");
    return undefined;
  }
  const words: string[] = [];
  for (let index = 0; index < 5; index += 1) {
    const word = readWord(value[index], `${path}[${index}]`, issues);
    if (word) words.push(word);
  }
  return words.length === 5 ? (words as Words5) : undefined;
}

function readWord(value: unknown, path: string, issues: Issues): string | undefined {
  if (typeof value !== "string") {
    issues.add(path, "must be one word");
    return undefined;
  }
  const word = collapse(value);
  if (!word || word.includes(" ")) {
    issues.add(path, "must be one word");
    return undefined;
  }
  return word;
}

function readPhrases(value: unknown, path: string, issues: Issues): string[] | undefined {
  if (!Array.isArray(value) || value.length < 2 || value.length > 3) {
    issues.add(path, "phrases must contain 2 or 3 phrases");
    return undefined;
  }
  const phrases: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const phrase = readPhrase(value[index], `${path}[${index}]`, issues);
    if (phrase) phrases.push(phrase);
  }
  if (phrases.length !== value.length) return undefined;
  const seen = new Set<string>();
  for (const phrase of phrases) {
    if (seen.has(phrase)) {
      issues.add(path, "phrases must be distinct");
      return undefined;
    }
    seen.add(phrase);
  }
  return phrases;
}

function readPhrase(value: unknown, path: string, issues: Issues): string | undefined {
  if (typeof value !== "string") {
    issues.add(path, "phrase must be 3 to 15 words");
    return undefined;
  }
  const phrase = collapse(value);
  const count = phrase ? phrase.split(" ").length : 0;
  if (count < 3 || count > 15) {
    issues.add(path, "phrase must be 3 to 15 words");
    return undefined;
  }
  return phrase;
}

function hostOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    if (parsed.username || parsed.password) return undefined;
    return parsed.hostname;
  } catch {
    return undefined;
  }
}

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) sorted[key] = canonicalize(value[key]);
    return sorted;
  }
  return value;
}

function isIpv4(host: string): boolean {
  const labels = host.split(".");
  return labels.length === 4 && labels.every((label) => /^\d{1,3}$/.test(label) && Number(label) <= 255);
}

function rejectUnknown(value: Record<string, unknown>, path: string, allowed: readonly string[], issues: Issues) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) issues.add(path ? `${path}.${key}` : key, `unknown key "${key}"`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

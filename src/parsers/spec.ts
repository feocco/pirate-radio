import { compile } from "css-select";
import { AttributeAction, parse, SelectorType, type Selector as CssToken } from "css-what";

declare const selectorBrand: unique symbol;

export type Selector = string & { readonly __brand: "Selector" };

export type AllowedAttr = "content" | "datetime" | "src" | "srcset" | "href" | "alt" | "title";

export type BlockKind = "paragraph" | "heading" | "list" | "quote" | "image";

export type TextMatch =
  | { equals: string; caseInsensitive?: boolean }
  | { startsWith: string; caseInsensitive?: boolean }
  | { contains: string; caseInsensitive?: boolean };

export type TextCleanup =
  | { op: "stripPrefix"; value: string; caseInsensitive?: boolean }
  | { op: "stripSuffix"; value: string; caseInsensitive?: boolean }
  | { op: "replaceExact"; from: string; to: string };

export interface FieldRule {
  from: Array<{ select: Selector; attr?: AllowedAttr }>;
  cleanup?: TextCleanup[];
}

export interface BodyRule {
  root: Selector;
  remove?: Selector[];
  stopAt?: Selector[];
  blocks: Array<{ select: Selector; as: BlockKind }>;
  dropBlocksWhere?: TextMatch[];
  cleanup?: TextCleanup[];
}

export interface ParserSpecV1 {
  schema: "pirate-radio/parser-spec@1";
  id: string;
  displayName: string;
  hosts: string[];
  paths?: { prefixes: string[] };
  title: FieldRule;
  byline?: FieldRule;
  publishedAt?: FieldRule;
  heroImage?: FieldRule;
  body: BodyRule;
}

export const parserSpecLimits = Object.freeze({
  id: 64,
  displayName: 80,
  hosts: 4,
  hostname: 253,
  pathPrefixes: 8,
  pathPrefixLength: 128,
  selector: 160,
  fieldSources: 8,
  cleanups: 8,
  textValue: 200,
  remove: 16,
  stopAt: 8,
  blocks: 16,
  dropBlocks: 16,
});

const SCHEMA = "pirate-radio/parser-spec@1";
const BLOCK_KINDS: readonly BlockKind[] = ["paragraph", "heading", "list", "quote", "image"];
const ALLOWED_ATTRS: readonly AllowedAttr[] = ["content", "datetime", "src", "srcset", "href", "alt", "title"];
const TOP_KEYS = ["schema", "id", "displayName", "hosts", "paths", "title", "byline", "publishedAt", "heroImage", "body"];
const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

export class ParserSpecError extends Error {
  readonly issues: ReadonlyArray<{ path: string; message: string }>;

  constructor(issues: ReadonlyArray<{ path: string; message: string }>) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"));
    this.name = "ParserSpecError";
    this.issues = issues;
  }
}

class Issues {
  readonly items: Array<{ path: string; message: string }> = [];

  add(path: string, message: string) {
    this.items.push({ path, message });
  }
}

export function parseParserSpec(raw: unknown): ParserSpecV1 {
  if (!isRecord(raw)) {
    throw new ParserSpecError([{ path: "$", message: "parser spec must be a JSON object" }]);
  }

  const issues = new Issues();
  rejectUnknown(raw, "", TOP_KEYS, issues);

  if (raw.schema !== SCHEMA) {
    issues.add("schema", `schema must be "${SCHEMA}"`);
  }
  const id = readId(raw.id, issues);
  const displayName = readDisplayName(raw.displayName, issues);
  const hosts = readHosts(raw.hosts, issues);
  const paths = readPaths(raw.paths, issues);
  const title = readField(raw.title, "title", issues, true);
  const byline = readField(raw.byline, "byline", issues, false);
  const publishedAt = readField(raw.publishedAt, "publishedAt", issues, false);
  const heroImage = readField(raw.heroImage, "heroImage", issues, false);
  const body = readBody(raw.body, issues);

  if (issues.items.length > 0 || !id || !displayName || !hosts || !title || !body) {
    throw new ParserSpecError(
      issues.items.length > 0 ? issues.items : [{ path: "$", message: "parser spec is invalid" }],
    );
  }

  const spec: ParserSpecV1 = {
    schema: SCHEMA,
    id,
    displayName,
    hosts,
    title,
    body,
  };
  if (paths) spec.paths = paths;
  if (byline) spec.byline = byline;
  if (publishedAt) spec.publishedAt = publishedAt;
  if (heroImage) spec.heroImage = heroImage;
  return freeze(spec);
}

function readId(value: unknown, issues: Issues): string | undefined {
  if (typeof value !== "string") {
    issues.add("id", "id must be kebab-case");
    return undefined;
  }
  if (value.length > parserSpecLimits.id) {
    issues.add("id", `id must be at most ${parserSpecLimits.id} characters`);
    return undefined;
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    issues.add("id", "id must be kebab-case");
    return undefined;
  }
  return value;
}

function readDisplayName(value: unknown, issues: Issues): string | undefined {
  if (typeof value !== "string") {
    issues.add("displayName", "displayName must be 1 to 80 characters");
    return undefined;
  }
  if (value !== value.trim()) {
    issues.add("displayName", "displayName must not have leading or trailing whitespace");
    return undefined;
  }
  if (value.length === 0 || value.length > parserSpecLimits.displayName) {
    issues.add("displayName", `displayName must be 1 to ${parserSpecLimits.displayName} characters`);
    return undefined;
  }
  if (/[<>\u0000-\u001f\u007f]/.test(value)) {
    issues.add("displayName", "displayName must not contain HTML");
    return undefined;
  }
  return value;
}

function readHosts(value: unknown, issues: Issues): string[] | undefined {
  const items = readList(value, "hosts", issues, 1, parserSpecLimits.hosts);
  if (!items) return undefined;
  const hosts: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < Math.min(items.length, parserSpecLimits.hosts); index += 1) {
    const host = items[index];
    const path = `hosts[${index}]`;
    if (typeof host !== "string") {
      issues.add(path, "hosts must be a lowercase hostname of at most 253 characters");
      continue;
    }
    if (host.startsWith("www.")) {
      issues.add(path, "hosts must be lowercase hostnames with the www. prefix already removed");
      continue;
    }
    if (seen.has(host)) {
      issues.add(path, "duplicate host");
      continue;
    }
    if (!HOSTNAME.test(host) || isIpv4(host)) {
      issues.add(path, "hosts must be a lowercase hostname of at most 253 characters");
      continue;
    }
    seen.add(host);
    hosts.push(host);
  }
  return hosts;
}

function readPaths(value: unknown, issues: Issues): { prefixes: string[] } | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    issues.add("paths", "paths must be an object");
    return undefined;
  }
  rejectUnknown(value, "paths", ["prefixes"], issues);
  const items = readList(value.prefixes, "paths.prefixes", issues, 1, parserSpecLimits.pathPrefixes);
  if (!items) return undefined;
  const prefixes: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < Math.min(items.length, parserSpecLimits.pathPrefixes); index += 1) {
    const prefix = items[index];
    const path = `paths.prefixes[${index}]`;
    if (typeof prefix !== "string" || !isPathPrefix(prefix)) {
      issues.add(
        path,
        "path prefixes must start with / and must not contain a query, hash, or ..",
      );
      continue;
    }
    if (seen.has(prefix)) {
      issues.add(path, "duplicate path prefix");
      continue;
    }
    seen.add(prefix);
    prefixes.push(prefix);
  }
  return prefixes.length > 0 ? { prefixes } : undefined;
}

function readField(value: unknown, path: string, issues: Issues, required: boolean): FieldRule | undefined {
  if (value === undefined) {
    if (required) issues.add(path, `${path} is required`);
    return undefined;
  }
  if (!isRecord(value)) {
    issues.add(path, `${path} must be an object`);
    return undefined;
  }
  rejectUnknown(value, path, ["from", "cleanup"], issues);
  const items = readList(value.from, `${path}.from`, issues, 1, parserSpecLimits.fieldSources);
  const from: FieldRule["from"] = [];
  if (items) {
    for (let index = 0; index < Math.min(items.length, parserSpecLimits.fieldSources); index += 1) {
      const source = readSource(items[index], `${path}.from[${index}]`, issues);
      if (source) from.push(source);
    }
  }
  const cleanup = readCleanups(value.cleanup, `${path}.cleanup`, issues);
  if (!items || from.length !== Math.min(items.length, parserSpecLimits.fieldSources)) return undefined;
  return cleanup && cleanup.length > 0 ? { from, cleanup } : { from };
}

function readSource(
  value: unknown,
  path: string,
  issues: Issues,
): { select: Selector; attr?: AllowedAttr } | undefined {
  if (!isRecord(value)) {
    issues.add(path, "field source must be an object");
    return undefined;
  }
  rejectUnknown(value, path, ["select", "attr"], issues);
  const select = readSelector(value.select, `${path}.select`, issues);
  if (value.attr === undefined) return select ? { select } : undefined;
  if (typeof value.attr !== "string" || !ALLOWED_ATTRS.includes(value.attr as AllowedAttr)) {
    issues.add(path + ".attr", "attr must be one of content, datetime, src, srcset, href, alt, title");
    return undefined;
  }
  return select ? { select, attr: value.attr as AllowedAttr } : undefined;
}

function readBody(value: unknown, issues: Issues): BodyRule | undefined {
  if (!isRecord(value)) {
    issues.add("body", "body must be an object");
    return undefined;
  }
  rejectUnknown(value, "body", ["root", "remove", "stopAt", "blocks", "dropBlocksWhere", "cleanup"], issues);
  const root = readSelector(value.root, "body.root", issues);
  const remove = readSelectors(value.remove, "body.remove", issues, parserSpecLimits.remove);
  const stopAt = readSelectors(value.stopAt, "body.stopAt", issues, parserSpecLimits.stopAt);
  const blockItems = readList(value.blocks, "body.blocks", issues, 1, parserSpecLimits.blocks);
  const blocks: BodyRule["blocks"] = [];
  if (blockItems) {
    for (let index = 0; index < Math.min(blockItems.length, parserSpecLimits.blocks); index += 1) {
      const block = readBlock(blockItems[index], `body.blocks[${index}]`, issues);
      if (block) blocks.push(block);
    }
  }
  const dropBlocksWhere = readMatches(value.dropBlocksWhere, "body.dropBlocksWhere", issues);
  const cleanup = readCleanups(value.cleanup, "body.cleanup", issues);
  if (!root || !blockItems || blocks.length !== Math.min(blockItems.length, parserSpecLimits.blocks)) return undefined;
  const body: BodyRule = { root, blocks };
  if (remove && remove.length > 0) body.remove = remove;
  if (stopAt && stopAt.length > 0) body.stopAt = stopAt;
  if (dropBlocksWhere && dropBlocksWhere.length > 0) body.dropBlocksWhere = dropBlocksWhere;
  if (cleanup && cleanup.length > 0) body.cleanup = cleanup;
  return body;
}

function readBlock(
  value: unknown,
  path: string,
  issues: Issues,
): { select: Selector; as: BlockKind } | undefined {
  if (!isRecord(value)) {
    issues.add(path, "block must be an object");
    return undefined;
  }
  rejectUnknown(value, path, ["select", "as"], issues);
  const select = readSelector(value.select, `${path}.select`, issues);
  if (typeof value.as !== "string" || !BLOCK_KINDS.includes(value.as as BlockKind)) {
    issues.add(`${path}.as`, "as must be one of paragraph, heading, list, quote, image");
    return undefined;
  }
  return select ? { select, as: value.as as BlockKind } : undefined;
}

function readSelectors(value: unknown, path: string, issues: Issues, max: number): Selector[] | undefined {
  if (value === undefined) return undefined;
  const items = readList(value, path, issues, 0, max);
  if (!items) return undefined;
  const selectors: Selector[] = [];
  for (let index = 0; index < Math.min(items.length, max); index += 1) {
    const selector = readSelector(items[index], `${path}[${index}]`, issues);
    if (selector) selectors.push(selector);
  }
  return selectors;
}

function readMatches(value: unknown, path: string, issues: Issues): TextMatch[] | undefined {
  if (value === undefined) return undefined;
  const items = readList(value, path, issues, 0, parserSpecLimits.dropBlocks);
  if (!items) return undefined;
  const matches: TextMatch[] = [];
  for (let index = 0; index < Math.min(items.length, parserSpecLimits.dropBlocks); index += 1) {
    const match = readTextMatch(items[index], `${path}[${index}]`, issues);
    if (match) matches.push(match);
  }
  return matches;
}

function readTextMatch(value: unknown, path: string, issues: Issues): TextMatch | undefined {
  if (!isRecord(value)) {
    issues.add(path, "text match must set exactly one of equals, startsWith, or contains");
    return undefined;
  }
  rejectUnknown(value, path, ["equals", "startsWith", "contains", "caseInsensitive"], issues);
  const operators = (["equals", "startsWith", "contains"] as const).filter((key) => Object.hasOwn(value, key));
  if (operators.length !== 1) {
    issues.add(path, "text match must set exactly one of equals, startsWith, or contains");
    return undefined;
  }
  const key = operators[0] ?? "equals";
  const text = readTextValue(value[key], `${path}.${key}`, issues, false);
  const caseInsensitive = readCaseFlag(value.caseInsensitive, `${path}.caseInsensitive`, issues);
  if (text === undefined) return undefined;
  if (key === "equals") return caseInsensitive === undefined ? { equals: text } : { equals: text, caseInsensitive };
  if (key === "startsWith") {
    return caseInsensitive === undefined ? { startsWith: text } : { startsWith: text, caseInsensitive };
  }
  return caseInsensitive === undefined ? { contains: text } : { contains: text, caseInsensitive };
}

function readCleanups(value: unknown, path: string, issues: Issues): TextCleanup[] | undefined {
  if (value === undefined) return undefined;
  const items = readList(value, path, issues, 0, parserSpecLimits.cleanups);
  if (!items) return undefined;
  const cleanups: TextCleanup[] = [];
  for (let index = 0; index < Math.min(items.length, parserSpecLimits.cleanups); index += 1) {
    const cleanup = readCleanup(items[index], `${path}[${index}]`, issues);
    if (cleanup) cleanups.push(cleanup);
  }
  return cleanups;
}

function readCleanup(value: unknown, path: string, issues: Issues): TextCleanup | undefined {
  if (!isRecord(value)) {
    issues.add(path, "cleanup must be an object");
    return undefined;
  }
  if (value.op === "stripPrefix" || value.op === "stripSuffix") {
    rejectUnknown(value, path, ["op", "value", "caseInsensitive"], issues);
    const text = readTextValue(value.value, `${path}.value`, issues, false);
    const caseInsensitive = readCaseFlag(value.caseInsensitive, `${path}.caseInsensitive`, issues);
    if (text === undefined) return undefined;
    return caseInsensitive === undefined ? { op: value.op, value: text } : { op: value.op, value: text, caseInsensitive };
  }
  if (value.op === "replaceExact") {
    rejectUnknown(value, path, ["op", "from", "to"], issues);
    const from = readTextValue(value.from, `${path}.from`, issues, false);
    const to = readTextValue(value.to, `${path}.to`, issues, true);
    if (from === undefined || to === undefined) return undefined;
    return { op: "replaceExact", from, to };
  }
  issues.add(`${path}.op`, "op must be one of stripPrefix, stripSuffix, or replaceExact");
  return undefined;
}

function readTextValue(value: unknown, path: string, issues: Issues, allowEmpty: boolean): string | undefined {
  if (typeof value !== "string") {
    issues.add(path, `${path} must be a string`);
    return undefined;
  }
  if (!allowEmpty && value.length === 0) {
    issues.add(path, `${path} must not be empty`);
    return undefined;
  }
  if (value.length > parserSpecLimits.textValue) {
    issues.add(path, `${path} must be at most ${parserSpecLimits.textValue} characters`);
    return undefined;
  }
  return value;
}

function readCaseFlag(value: unknown, path: string, issues: Issues): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    issues.add(path, "caseInsensitive must be a boolean");
    return undefined;
  }
  return value;
}

function readSelector(value: unknown, path: string, issues: Issues): Selector | undefined {
  if (typeof value !== "string") {
    issues.add(path, path.endsWith(".root") ? "body.root is required" : "selector is empty; provide a type, id, class, or attribute selector");
    return undefined;
  }
  if (!validateSelector(value, path, issues)) return undefined;
  return value as Selector;
}

function readList(value: unknown, path: string, issues: Issues, min: number, max: number): unknown[] | undefined {
  if (!Array.isArray(value)) {
    issues.add(path, min > 0 ? `${path} must contain at least ${min}` : `${path} must be an array`);
    return undefined;
  }
  if (min > 0 && value.length < min) issues.add(path, `${path} must contain at least ${min}`);
  if (value.length > max) issues.add(path, `${path} accepts at most ${max}`);
  return value;
}

function validateSelector(selector: string, path: string, issues: Issues): boolean {
  if (selector.trim() === "") {
    issues.add(path, "selector is empty; provide a type, id, class, or attribute selector");
    return false;
  }
  if (selector.length > parserSpecLimits.selector) {
    issues.add(path, `selector is ${selector.length} characters; the maximum is ${parserSpecLimits.selector}`);
    return false;
  }
  let parsed: CssToken[][];
  try {
    parsed = parse(selector);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "parse failed";
    issues.add(path, `selector is not in the allowlisted grammar (${detail})`);
    return false;
  }
  if (parsed.length === 0) {
    issues.add(path, "selector is empty; provide a type, id, class, or attribute selector");
    return false;
  }
  const before = issues.items.length;
  for (const group of parsed) {
    if (group.length === 0) {
      issues.add(path, "selector is empty; provide a type, id, class, or attribute selector");
      continue;
    }
    for (const token of group) validateToken(token, path, issues, false);
  }
  if (issues.items.length > before) return false;
  try {
    compile(selector);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "compile failed";
    issues.add(path, `selector is not supported by the parser engine (${detail})`);
    return false;
  }
  return true;
}

function validateToken(token: CssToken, path: string, issues: Issues, insideNot: boolean) {
  if (token.type === SelectorType.Tag) {
    if (token.namespace) issues.add(path, "namespaces are not allowed");
    else if (!/^[A-Za-z][-A-Za-z0-9]*$/.test(token.name)) issues.add(path, "type selector is not allowed");
    return;
  }
  if (token.type === SelectorType.Attribute) {
    if (token.namespace) {
      issues.add(path, "namespaces are not allowed");
      return;
    }
    if (token.ignoreCase === true) issues.add(path, "attribute case flag is not allowed");
    const allowedActions: readonly AttributeAction[] = [
      AttributeAction.Exists,
      AttributeAction.Equals,
      AttributeAction.Element,
      AttributeAction.Start,
      AttributeAction.Any,
    ];
    if (!allowedActions.includes(token.action)) {
      issues.add(path, "attribute operator is not allowed; use presence, =, ~=, ^=, or *=");
    }
    if (!/^[A-Za-z_:][-A-Za-z0-9_:]*$/.test(token.name)) issues.add(path, "attribute name is not allowed");
    return;
  }
  if (token.type === SelectorType.Universal) {
    issues.add(path, "universal selectors are not allowed");
    return;
  }
  if (token.type === SelectorType.PseudoElement) {
    issues.add(path, "pseudo-elements are not allowed");
    return;
  }
  if (token.type === SelectorType.Child || token.type === SelectorType.Descendant) {
    if (insideNot) issues.add(path, ":not() accepts one simple selector, such as :not(.ad)");
    return;
  }
  if (
    token.type === SelectorType.Adjacent ||
    token.type === SelectorType.Sibling ||
    token.type === SelectorType.Parent ||
    token.type === SelectorType.ColumnCombinator
  ) {
    issues.add(path, "only descendant and > combinators are allowed");
    return;
  }
  if (token.type === SelectorType.Pseudo) {
    if (token.name === "not") {
      const group = Array.isArray(token.data) ? token.data[0] : undefined;
      const only = group?.length === 1 ? group[0] : undefined;
      if (insideNot || !Array.isArray(token.data) || token.data.length !== 1 || !only) {
        issues.add(path, ":not() accepts one simple selector, such as :not(.ad)");
        return;
      }
      validateToken(only, path, issues, true);
      return;
    }
    if (token.name === "first-of-type") {
      if (token.data !== null) issues.add(path, ":first-of-type does not take an argument");
      return;
    }
    if (token.name === "nth-of-type") {
      if (typeof token.data !== "string" || !isNthFormula(token.data)) {
        issues.add(path, ":nth-of-type() accepts an An+B index such as n, odd, even, or 2n+1");
      }
      return;
    }
    issues.add(path, `:${token.name} is not allowed; use :not(simple), :first-of-type, or :nth-of-type(An+B)`);
  }
}

function isNthFormula(data: string): boolean {
  if (data.toLowerCase().includes("of")) return false;
  const compact = data.replace(/\s+/g, "").toLowerCase();
  return /^(?:odd|even|[+-]?\d+|[+-]?\d*n(?:[+-]\d+)?)$/.test(compact);
}

function isPathPrefix(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= parserSpecLimits.pathPrefixLength &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.includes("?") &&
    !value.includes("#") &&
    !value.includes("\\") &&
    !value.includes("..") &&
    !/\s/.test(value)
  );
}

function isIpv4(host: string): boolean {
  const labels = host.split(".");
  return labels.length === 4 && labels.every((label) => /^\d{1,3}$/.test(label) && Number(label) <= 255);
}

function rejectUnknown(value: Record<string, unknown>, path: string, allowed: readonly string[], issues: Issues) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      issues.add(path ? `${path}.${key}` : key, `unknown key "${key}"`);
    }
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

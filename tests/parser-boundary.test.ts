import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const parserRoot = "src/parsers";
const allowedPackages = new Set([
  "htmlparser2",
  "domhandler",
  "domutils",
  "css-select",
  "css-what",
  "entities",
]);
const forbidden = [
  "node:fs",
  "node:http",
  "node:https",
  "node:net",
  "node:child_process",
  "node:timers",
  "node:vm",
  "node:crypto",
  "new RegExp",
  "eval(",
  "Function(",
  "fetch(",
  "require(",
  "process.",
  "globalThis",
  "XMLHttpRequest",
  "WebSocket",
  "setTimeout",
  "setInterval",
  "setImmediate",
];

function walk(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      files.push(...walk(path));
    } else if (path.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
}

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
    specifiers.push(match[1] ?? "");
  }
  for (const match of source.matchAll(/import\s*\(\s*["']([^"']+)["']/g)) {
    specifiers.push(match[1] ?? "");
  }
  return specifiers;
}

describe("parser module boundary", () => {
  test("ships the trusted pure modules and one redacted criteria fixture", () => {
    expect(existsSync("src/parsers/spec.ts")).toBe(true);
    expect(existsSync("src/parsers/engine.ts")).toBe(true);
    expect(existsSync("src/parsers/invariants.ts")).toBe(true);
    expect(existsSync("src/parsers/criteria.ts")).toBe(true);
    expect(existsSync("src/parsers/registry.ts")).toBe(false);

    const domains = join(parserRoot, "domains");
    expect(readdirSync(domains).sort()).toEqual(["first-things"]);
    const domain = join(domains, "first-things");
    expect(readdirSync(domain).sort()).toEqual(["criteria.json", "fixtures"]);
    expect(existsSync(join(domain, "parser.json"))).toBe(false);
    const fixtures = readdirSync(join(domain, "fixtures"));
    expect(fixtures).toHaveLength(1);
    expect(fixtures[0]).toMatch(/^[0-9a-f]{64}\.html$/);
  });

  test("imports only the pure HTML packages, relative parser modules, and story types", () => {
    const files = walk(parserRoot);
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const specifier of importSpecifiers(source)) {
        if (specifier === "node:crypto") {
          expect(file, "only criteria.ts may import node:crypto").toBe(join(parserRoot, "criteria.ts"));
          continue;
        }
        const allowed =
          allowedPackages.has(specifier) ||
          specifier === "../types.js" ||
          (specifier.startsWith("./") && specifier.endsWith(".js") && !specifier.includes(".."));
        expect(allowed, `${file} imports ${specifier}`).toBe(true);
      }
      for (const token of forbidden) {
        if (token === "node:crypto" && file === join(parserRoot, "criteria.ts")) continue;
        expect(source, `${file} contains ${token}`).not.toContain(token);
      }
    }
  });

  test("stays unwired from runtime sources", () => {
    for (const file of walk("src")) {
      if (file.split(/[\\/]/).includes("parsers")) {
        continue;
      }
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toContain("parsers/");
      expect(source, file).not.toMatch(/from\s+["'][^"']*parsers/);
    }
  });
});

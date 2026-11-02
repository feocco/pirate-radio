import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { isFirstPartyArticleHost, validateArticleUrl } from "../src/backlog.js";
import { criteriaDigest, type CriteriaExample } from "../src/parsers/criteria.js";
import {
  activeParsers,
  compileDomainFiles,
  disabledParserIds,
  matchParser,
  matchSpecs,
  RegistryError,
  renderCompiledRegistry,
  type DomainSourceFile,
} from "../src/parsers/registry.js";
import { parseParserSpec } from "../src/parsers/spec.js";
import { generateRegistry } from "../scripts/parsers/generate-registry.js";

const none = new Set<string>();

function file(path: string, text: string, byteLength = Buffer.byteLength(text)): DomainSourceFile {
  return { path, kind: "file", text, byteLength };
}

function specJson(id: string, hosts: string[], prefixes?: string[]): string {
  return JSON.stringify({
    schema: "pirate-radio/parser-spec@1",
    id,
    displayName: "Example News",
    hosts,
    ...(prefixes ? { paths: { prefixes } } : {}),
    title: { from: [{ select: "h1" }] },
    body: { root: "article", blocks: [{ select: "p", as: "paragraph" }] },
  });
}

function criteriaBundle(id: string, host: string): DomainSourceFile[] {
  const html = "<article><h1>Pinned Title</h1><p>one two three four five alpha beta gamma delta epsilon zeta six seven eight nine ten</p></article>";
  const sha = createHash("sha256").update(html).digest("hex");
  const examples: CriteriaExample[] = [
    {
      submissionId: "6f8c2a1e-4b37-4c5d-9e10-a1b2c3d4e5f6",
      url: `https://${host}/story`,
      fixture: `fixtures/${sha}.html`,
      rawSnapshotSha256: "ab".repeat(32),
      title: "Pinned Title",
      firstWords: ["one", "two", "three", "four", "five"],
      lastWords: ["six", "seven", "eight", "nine", "ten"],
      phrases: ["alpha beta gamma", "delta epsilon zeta"],
    },
  ];
  const criteria = {
    schema: "pirate-radio/parser-criteria@1",
    parserId: id,
    host,
    digest: criteriaDigest(examples),
    examples,
  };
  return [file(`${id}/criteria.json`, JSON.stringify(criteria)), file(`${id}/fixtures/${sha}.html`, html)];
}

function repoDomainFiles(domainDir: string): DomainSourceFile[] {
  const root = "src/parsers/domains";
  const files: DomainSourceFile[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const absolute = join(dir, name);
      const relative = absolute.slice(root.length + 1).replaceAll("\\", "/");
      const info = statSync(absolute);
      if (info.isDirectory()) {
        files.push({ path: relative, kind: "directory", text: "", byteLength: 0 });
        walk(absolute);
      } else {
        const text = readFileSync(absolute, "utf8");
        files.push(file(relative, text, info.size));
      }
    }
  };
  walk(domainDir);
  return files;
}

describe("disabled parser ids", () => {
  test("parses a comma-separated list and rejects a token that is not kebab-case", () => {
    expect(disabledParserIds(undefined)).toEqual(new Set());
    expect(disabledParserIds("")).toEqual(new Set());
    expect(disabledParserIds("  ,  ")).toEqual(new Set());
    expect(disabledParserIds(" first-things, other-host, first-things ")).toEqual(
      new Set(["first-things", "other-host"]),
    );

    expect(() => disabledParserIds("First-Things")).toThrow(RegistryError);
    try {
      disabledParserIds("First-Things");
    } catch (error) {
      expect(error).toBeInstanceOf(RegistryError);
      const issue = (error as RegistryError).issues[0];
      expect(issue?.path).toContain("PIRATE_RADIO_DISABLED_PARSERS");
      expect(issue?.message).toContain("kebab-case");
    }
    expect(() => disabledParserIds("a".repeat(65))).toThrow(RegistryError);
  });
});

describe("matchSpecs", () => {
  test("matches the host with www removed and keeps path prefixes on a slash boundary", () => {
    const news = parseParserSpec(JSON.parse(specJson("news", ["news.example"], ["/news"])));
    expect(matchSpecs([news], new URL("https://news.example/news"), none)).toBe(news);
    expect(matchSpecs([news], new URL("http://www.news.example/news/1?x=1#y"), none)).toBe(news);
    expect(matchSpecs([news], new URL("https://news.example:8443/news"), none)).toBe(news);
    expect(matchSpecs([news], new URL("https://news.example/newsroom"), none)).toBeUndefined();
    expect(matchSpecs([news], new URL("https://other.example/news"), none)).toBeUndefined();
    expect(matchSpecs([news], new URL("https://news.example/news"), new Set(["news"]))).toBeUndefined();
    expect(matchSpecs([news], new URL("https://news.example/news"), new Set(["other"]))).toBe(news);

    const open = parseParserSpec(JSON.parse(specJson("open-news", ["open-news.example"])));
    expect(matchSpecs([open], new URL("https://open-news.example/"), none)).toBe(open);
    expect(matchSpecs([open], new URL("https://open-news.example/a/b"), none)).toBe(open);
  });

  test("throws when two enabled specs claim the same host and skips a disabled one", () => {
    const alpha = parseParserSpec(JSON.parse(specJson("alpha", ["news.example"])));
    const beta = parseParserSpec(JSON.parse(specJson("beta", ["news.example"])));
    expect(() => matchSpecs([alpha, beta], new URL("https://www.news.example/a"), none)).toThrow(RegistryError);
    expect(matchSpecs([alpha, beta], new URL("https://news.example/a"), new Set(["alpha"]))).toBe(beta);
    expect(matchSpecs([], new URL("https://firstthings.com/voyages-to-the-end-of-the-world/"), none)).toBeUndefined();
  });
});

describe("domain compile", () => {
  test("keeps a criteria-only directory out of the registry and emits a spec that round-trips", () => {
    const criteriaOnly = compileDomainFiles(criteriaBundle("pinned", "pinned.example"), isFirstPartyArticleHost);
    expect(criteriaOnly.issues).toEqual([]);
    expect(criteriaOnly.specs).toEqual([]);

    const active = compileDomainFiles(
      [...criteriaBundle("harbor", "harbor.example"), file("harbor/parser.json", specJson("harbor", ["harbor.example"], ["/a"]))],
      isFirstPartyArticleHost,
    );
    expect(active.issues).toEqual([]);
    expect(active.specs.map((spec) => spec.id)).toEqual(["harbor"]);
    const rendered = renderCompiledRegistry(active.specs);
    const raw = JSON.parse(rendered.slice(rendered.indexOf("=") + 1).replace(/;\s*$/, "")) as unknown[];
    expect(raw.map((item) => parseParserSpec(item))).toEqual(active.specs);
  });

  test("names the file and the fix for layout, identity, schema, and fixture bytes", () => {
    const extra = compileDomainFiles(
      [...criteriaBundle("harbor", "harbor.example"), file("harbor/parser.js", "export {}")],
      isFirstPartyArticleHost,
    );
    expect(extra.specs).toEqual([]);
    expect(extra.issues).toEqual([
      {
        path: "src/parsers/domains/harbor/parser.js",
        message: "domains may contain only parser.json, criteria.json, and fixtures/<sha256>.html. Remove parser.js.",
      },
    ]);

    const renamed = compileDomainFiles(
      [file("harbor/parser.json", specJson("other-name", ["harbor.example"]))],
      isFirstPartyArticleHost,
    );
    expect(renamed.issues).toEqual([
      {
        path: "src/parsers/domains/harbor/parser.json",
        message: 'id must equal the directory name "harbor". Set id to "harbor".',
      },
    ]);

    const prefixed = compileDomainFiles(
      [file("harbor/parser.json", specJson("harbor", ["www.harbor.example"]))],
      isFirstPartyArticleHost,
    );
    expect(prefixed.issues[0]?.path).toBe("src/parsers/domains/harbor/parser.json");
    expect(prefixed.issues[0]?.message).toContain("www. prefix");

    const bundle = criteriaBundle("harbor", "harbor.example");
    const fixture = bundle[1];
    expect(fixture).toBeDefined();
    const wrongSha = compileDomainFiles(
      [bundle[0] as DomainSourceFile, file("harbor/fixtures/" + "ab".repeat(32) + ".html", fixture?.text ?? "")],
      isFirstPartyArticleHost,
    );
    expect(wrongSha.issues.some((issue) => issue.message.includes("Rename it"))).toBe(true);

    const unbound = compileDomainFiles(
      [...criteriaBundle("harbor", "harbor.example"), file("harbor/parser.json", specJson("harbor", ["other.example"]))],
      isFirstPartyArticleHost,
    );
    expect(unbound.specs).toEqual([]);
    expect(unbound.issues).toEqual([
      {
        path: "src/parsers/domains/harbor/criteria.json",
        message: 'host "harbor.example" must be listed in src/parsers/domains/harbor/parser.json hosts.',
      },
    ]);

    const huge = compileDomainFiles(
      [file("harbor/fixtures/" + "cd".repeat(32) + ".html", "", 1_000_001)],
      isFirstPartyArticleHost,
    );
    expect(huge.issues[0]?.message).toContain("1000000");
  });

  test("rejects a built-in host, a shared host, and a host reserved by criteria", () => {
    for (const host of ["piratewires.com", "foo.substack.com", "x.com", "mobile.twitter.com", "hyperdimensional.co"]) {
      const result = compileDomainFiles(
        [file("harbor/parser.json", specJson("harbor", [host]))],
        isFirstPartyArticleHost,
      );
      expect(result.specs, host).toEqual([]);
      expect(result.issues[0]?.message, host).toContain(`host "${host}" belongs to a built-in article source`);
    }

    const overlap = compileDomainFiles(
      [
        file("alpha/parser.json", specJson("alpha", ["news.example"])),
        file("beta/parser.json", specJson("beta", ["news.example"])),
      ],
      isFirstPartyArticleHost,
    );
    expect(overlap.specs).toEqual([]);
    expect(overlap.issues).toEqual([
      {
        path: "src/parsers/domains/beta/parser.json",
        message:
          'host "news.example" is already claimed by src/parsers/domains/alpha/parser.json. Keep the host on one parser.',
      },
    ]);

    const reserved = compileDomainFiles(
      [...repoDomainFiles("src/parsers/domains/first-things"), file("other/parser.json", specJson("other", ["firstthings.com"]))],
      isFirstPartyArticleHost,
    );
    expect(reserved.specs).toEqual([]);
    expect(reserved.issues).toEqual([
      {
        path: "src/parsers/domains/other/parser.json",
        message:
          'host "firstthings.com" is reserved by src/parsers/domains/first-things/criteria.json for "first-things". Remove "firstthings.com" from hosts or move this spec to first-things.',
      },
    ]);
  });

  test("the merged First Things fixture is criteria-only and compiles to no active parser", () => {
    const files = repoDomainFiles("src/parsers/domains/first-things");
    expect(files.map((entry) => entry.path).sort()).toEqual([
      "first-things/criteria.json",
      "first-things/fixtures",
      expect.stringMatching(/^first-things\/fixtures\/[0-9a-f]{64}\.html$/),
    ]);
    const result = compileDomainFiles(files, isFirstPartyArticleHost);
    expect(result.issues).toEqual([]);
    expect(result.specs).toEqual([]);
  });
});

describe("shipped registry", () => {
  test("matches nothing while the compiled module is empty", () => {
    expect(activeParsers()).toEqual([]);
    const disabled = disabledParserIds("first-things");
    const urls = [
      "https://firstthings.com/voyages-to-the-end-of-the-world/",
      "https://www.firstthings.com/voyages-to-the-end-of-the-world/",
      "https://www.piratewires.com/p/test-story",
      "https://foo.substack.com/p/test-story",
      "https://x.com/someone/status/1",
      "https://example.com/p/test-story",
    ];
    for (const url of urls) {
      expect(matchParser(new URL(url), none), url).toBeUndefined();
      expect(matchParser(new URL(url), disabled), url).toBeUndefined();
    }

    const source = readFileSync("src/parsers/registry.ts", "utf8");
    expect(source).toContain('from "./generated/registry.js"');
    expect(source).not.toContain("node:fs");
    expect(source).not.toContain("process.");
  });

  test("first-party hosts stay with validateArticleUrl and an unknown host stays cloud-extract", async () => {
    const rows: Array<[string, string]> = [
      ["https://piratewires.com/p/example-story", "pirate-wires"],
      ["https://www.piratewires.com/p/example-story", "pirate-wires"],
      ["https://piratewires.substack.com/p/example-story", "pirate-wires"],
      ["https://hyperdimensional.co/p/example-story", "substack"],
      ["https://www.hyperdimensional.co/p/example-story", "substack"],
      ["https://foo.substack.com/p/example-story", "substack"],
      ["https://x.com/someone/status/1", "x"],
      ["https://www.x.com/someone/status/1", "x"],
      ["https://mobile.x.com/someone/status/1", "x"],
      ["https://twitter.com/someone/status/1", "x"],
      ["https://www.twitter.com/someone/status/1", "x"],
      ["https://mobile.twitter.com/someone/status/1", "x"],
      ["https://firstthings.com/voyages-to-the-end-of-the-world/", "cloud-extract"],
      ["https://www.firstthings.com/voyages-to-the-end-of-the-world/", "cloud-extract"],
      ["https://example.com/p/example-story", "cloud-extract"],
    ];
    for (const [url, sourceType] of rows) {
      const result = await validateArticleUrl(url);
      expect(result.ok, url).toBe(true);
      if (result.ok) expect(result.sourceType, url).toBe(sourceType);
      expect(isFirstPartyArticleHost(new URL(url).hostname), url).toBe(sourceType !== "cloud-extract");
    }

    const open = await validateArticleUrl("https://open.substack.com/pub/hyperdimensional/p/story", {
      resolveUrl: async () => "https://www.hyperdimensional.co/p/story",
    });
    expect(open.ok).toBe(true);
    if (open.ok) expect(open.sourceType).toBe("substack");
    expect(isFirstPartyArticleHost("open.substack.com")).toBe(true);
    expect(matchParser(new URL("https://open.substack.com/pub/hyperdimensional/p/story"), none)).toBeUndefined();
  });

  test("request sources do not call the registry", () => {
    const walk = (dir: string): string[] => {
      const found: string[] = [];
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) found.push(...walk(path));
        else if (path.endsWith(".ts")) found.push(path);
      }
      return found;
    };
    for (const path of walk("src")) {
      if (path.split(/[\\/]/).includes("parsers")) continue;
      const source = readFileSync(path, "utf8");
      expect(source, path).not.toContain("matchParser");
      expect(source, path).not.toContain("PIRATE_RADIO_DISABLED_PARSERS");
      expect(source, path).not.toContain("compileDomainFiles");
    }
  });
});

describe("registry generator", () => {
  test("writes only when the tree is valid and refuses a symlink without reading it", () => {
    const root = mkdtempSync(join(tmpdir(), "pirate-registry-"));
    const harbor = join(root, "harbor");
    mkdirSync(harbor);
    writeFileSync(join(harbor, "parser.json"), specJson("harbor", ["harbor.example"]));
    const outFile = join(root, "registry.ts");
    const written = generateRegistry({ domainsDir: root, outFile });
    expect(written.issues).toEqual([]);
    expect(written.specs.map((spec) => spec.id)).toEqual(["harbor"]);
    expect(readFileSync(outFile, "utf8")).toBe(renderCompiledRegistry(written.specs));

    const blocked = mkdtempSync(join(tmpdir(), "pirate-registry-blocked-"));
    mkdirSync(join(blocked, "harbor"));
    writeFileSync(join(blocked, "harbor", "parser.json"), specJson("harbor", ["piratewires.com"]));
    const blockedOut = join(blocked, "registry.ts");
    const rejected = generateRegistry({ domainsDir: blocked, outFile: blockedOut });
    expect(rejected.specs).toEqual([]);
    expect(rejected.issues[0]?.message).toContain("piratewires.com");
    expect(existsSync(blockedOut)).toBe(false);

    const linked = mkdtempSync(join(tmpdir(), "pirate-registry-link-"));
    const domain = join(linked, "harbor");
    mkdirSync(domain);
    writeFileSync(join(linked, "secret.txt"), "SECRET_TOKEN_VALUE");
    symlinkSync(join(linked, "missing-secret.txt"), join(domain, "parser.json"));
    const linkOut = join(linked, "registry.ts");
    const symlinkResult = generateRegistry({ domainsDir: linked, outFile: linkOut });
    const reported = symlinkResult.issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n");
    expect(reported).not.toContain("SECRET_TOKEN_VALUE");
    expect(reported).toContain("symlink");
    expect(existsSync(linkOut)).toBe(false);
  });

  test("pretest compiles the real domains tree to the committed empty registry", () => {
    execFileSync(join("node_modules", ".bin", "tsx"), ["scripts/parsers/generate-registry.ts"], { stdio: "pipe" });
    expect(readFileSync("src/parsers/generated/registry.ts", "utf8")).toBe(renderCompiledRegistry([]));
    expect(activeParsers()).toEqual([]);
    if (!gitWorkTree()) return;
    expect(() =>
      execFileSync("git", ["diff", "--exit-code", "--", "src/parsers/generated/registry.ts"], { stdio: "pipe" }),
    ).not.toThrow();
  });

  test("package hooks, the image build, and the env example expose this slice", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts.prebuild).toBe("tsx scripts/parsers/generate-registry.ts");
    expect(pkg.scripts.pretest).toBe("tsx scripts/parsers/generate-registry.ts");
    const documented = existsSync("Dockerfile") && existsSync(".env.example") && existsSync("docs/configuration.md");
    if (!documented) {
      expect(gitWorkTree(), "a checkout includes the Dockerfile, .env.example, and docs/configuration.md").toBe(false);
      return;
    }
    expect(readFileSync("Dockerfile", "utf8")).toContain("COPY scripts/parsers ./scripts/parsers");
    expect(readFileSync(".env.example", "utf8")).toMatch(/^PIRATE_RADIO_DISABLED_PARSERS=$/m);
    const configuration = readFileSync("docs/configuration.md", "utf8");
    expect(configuration).toContain("PIRATE_RADIO_DISABLED_PARSERS");
    expect(configuration).toContain("matchParser");
  });
});

function gitWorkTree(): boolean {
  try {
    const output = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { encoding: "utf8", stdio: "pipe" }).trim();
    return output === "true";
  } catch {
    return false;
  }
}

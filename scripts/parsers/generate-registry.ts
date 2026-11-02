import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { isFirstPartyArticleHost } from "../../src/backlog.js";
import { fixtureBytesMax } from "../../src/parsers/criteria.js";
import {
  compileDomainFiles,
  renderCompiledRegistry,
  type DomainSourceFile,
  type RegistryIssue,
} from "../../src/parsers/registry.js";
import type { ParserSpecV1 } from "../../src/parsers/spec.js";

const defaultDomainsDir = join("src", "parsers", "domains");
const defaultOutFile = join("src", "parsers", "generated", "registry.ts");

export function generateRegistry(options: {
  domainsDir?: string;
  outFile?: string;
  isFirstPartyHost?: (host: string) => boolean;
} = {}): { specs: ParserSpecV1[]; issues: RegistryIssue[] } {
  const domainsDir = options.domainsDir ?? defaultDomainsDir;
  const outFile = options.outFile ?? defaultOutFile;
  const compiled = compileDomainFiles(readDomainFiles(domainsDir), options.isFirstPartyHost ?? isFirstPartyArticleHost);
  if (compiled.issues.length === 0) writeRegistry(outFile, renderCompiledRegistry(compiled.specs));
  return compiled;
}

function readDomainFiles(domainsDir: string): DomainSourceFile[] {
  const files: DomainSourceFile[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const absolute = join(dir, name);
      const info = lstatSync(absolute);
      const path = relative(domainsDir, absolute).split("\\").join("/");
      if (info.isSymbolicLink()) {
        files.push({ path, kind: "symlink", text: "", byteLength: 0 });
        continue;
      }
      if (info.isDirectory()) {
        files.push({ path, kind: "directory", text: "", byteLength: 0 });
        walk(absolute);
        continue;
      }
      if (info.size > fixtureBytesMax) {
        files.push({ path, kind: "file", text: "", byteLength: info.size });
        continue;
      }
      const text = readFileSync(absolute, "utf8");
      files.push({ path, kind: "file", text, byteLength: info.size });
    }
  };
  walk(domainsDir);
  return files;
}

function writeRegistry(outFile: string, body: string) {
  mkdirSync(dirname(outFile), { recursive: true });
  const temporary = `${outFile}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, body);
  renameSync(temporary, outFile);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  const result = generateRegistry();
  if (result.issues.length > 0) {
    console.error(result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"));
    process.exit(1);
  }
}

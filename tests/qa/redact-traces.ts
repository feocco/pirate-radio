import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";

export const REDACTED = "[redacted]";

const TEXT_EXTENSIONS = new Set(["", ".trace", ".network", ".stacks", ".txt", ".json", ".html", ".css", ".js"]);

const REDACTIONS: Array<[RegExp, string]> = [
  [/(pirate_radio_(?:session|oidc)=)[^;"\\\s]+/g, `$1${REDACTED}`],
  [/("name":\s*"(?:cookie|set-cookie|authorization|x-api-key)",\s*"value":\s*")(?:[^"\\]|\\.)*"/gi, `$1${REDACTED}"`],
  [/("(?:cookie|set-cookie|authorization|x-api-key)":\s*")(?:[^"\\]|\\.)*"/gi, `$1${REDACTED}"`],
  [/(\\"(?:cookie|set-cookie|authorization|x-api-key)\\":\s*\\")(?:[^\\]|\\(?!"))*\\"/gi, `$1${REDACTED}\\"`],
  [/(\b(?:cookie|set-cookie|authorization|x-api-key):[ \t]+)[^"\\\n]+/gi, `$1${REDACTED}`],
  [/([?&](?:code|state|nonce|code_challenge|code_verifier)=)[^&"\\\s]+/g, `$1${REDACTED}`],
];

const LEAKS = [
  /pirate_radio_(?:session|oidc)=(?!\[redacted\])[A-Za-z0-9_-]{20,}/,
  /"name":\s*"(?:cookie|set-cookie|authorization|x-api-key)",\s*"value":\s*"(?!\[redacted\])/i,
  /"(?:cookie|set-cookie|authorization|x-api-key)":\s*"(?!\[redacted\])/i,
  /\\"(?:cookie|set-cookie|authorization|x-api-key)\\":\s*\\"(?!\[redacted\])/i,
  /\b(?:cookie|set-cookie|authorization|x-api-key):[ \t]+(?!\[redacted\])[^"\\\n\s]/i,
  /[?&]code=(?!\[redacted\])[A-Za-z0-9_-]{10,}/,
];

export function redactTraceText(text: string): string {
  return REDACTIONS.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), text);
}

export function findTraceLeak(text: string): string | undefined {
  return LEAKS.find((pattern) => pattern.test(text))?.source;
}

export async function redactTraceZip(zipPath: string): Promise<void> {
  const workDir = await mkdtemp(join(tmpdir(), "pirate-radio-trace-"));
  try {
    execFileSync("unzip", ["-q", zipPath, "-d", workDir]);
    for (const file of await listFiles(workDir)) {
      if (!TEXT_EXTENSIONS.has(extname(file))) continue;
      const original = await readFile(file, "utf8");
      const redacted = redactTraceText(original);
      const leak = findTraceLeak(redacted);
      if (leak) throw new Error(`Trace ${zipPath} still matches ${leak} in ${file} after redaction.`);
      if (redacted !== original) await writeFile(file, redacted);
    }
    const absoluteZip = resolve(zipPath);
    await rm(absoluteZip);
    execFileSync("zip", ["-q", "-r", "-X", absoluteZip, "."], { cwd: workDir });
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

export default async function redactAllTraces(): Promise<void> {
  const resultsDir = join(import.meta.dirname, "..", "..", "output", "qa", "test-results");
  if (!existsSync(resultsDir)) return;
  const traces = (await listFiles(resultsDir)).filter((file) => file.endsWith("trace.zip"));
  for (const trace of traces) await redactTraceZip(trace);
  if (traces.length > 0) console.log(`[qa] redacted cookies, auth headers, and OIDC codes in ${traces.length} trace(s)`);
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
}

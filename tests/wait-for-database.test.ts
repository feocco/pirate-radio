import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const repoRoot = join(import.meta.dirname, "..");
const waitScript = join(repoRoot, "scripts/dev/wait-for-database.sh");
const databaseUrl = "postgres://app:secret@database.test:5432/pirate_radio";

function runWait(fakePsql: string, extraEnv: Record<string, string> = {}) {
  const binDir = mkdtempSync(join(tmpdir(), "pirate-radio-test-bin-"));
  const psqlPath = join(binDir, "psql");
  writeFileSync(psqlPath, `#!/usr/bin/env bash\n${fakePsql}\n`);
  chmodSync(psqlPath, 0o755);

  const result = spawnSync("bash", [waitScript], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      DATABASE_URL: databaseUrl,
      ...extraEnv,
    },
    encoding: "utf8",
  });
  rmSync(binDir, { recursive: true, force: true });
  return result;
}

function readServeScript() {
  return readFileSync(join(repoRoot, "scripts/dev/serve.sh"), "utf8");
}

describe("wait-for-database dev script", () => {
  test("succeeds when the application database accepts connections", () => {
    const result = runWait("exit 0");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[wait-for-database] database is ready");
    expect(`${result.stdout}${result.stderr}`).not.toContain("app:secret");
  });

  test("fails with bounded retries and clear output when the database is unreachable", () => {
    const result = runWait('echo "connection refused" >&2; exit 1', {
      WAIT_FOR_DATABASE_MAX_ATTEMPTS: "2",
      WAIT_FOR_DATABASE_SLEEP_SECONDS: "0",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("database not ready after 2 attempt(s)");
    expect(result.stderr).toContain("last error: connection refused");
    expect(`${result.stdout}${result.stderr}`).not.toContain("app:secret");
    expect(`${result.stdout}${result.stderr}`).toContain("postgres://***@database.test:5432/pirate_radio");
  });

  test("serve exits if database readiness times out", () => {
    const contents = readServeScript();
    expect(contents).toContain("bash scripts/dev/wait-for-database.sh || exit 1");
  });

  test("serve waits for the database before launching the CLI", () => {
    const contents = readServeScript();
    expect(contents.indexOf("wait-for-database.sh")).toBeLessThan(
      contents.indexOf("exec node dist/src/cli.js serve"),
    );
  });
});

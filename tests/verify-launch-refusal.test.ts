import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

const root = join(import.meta.dirname, "..");
const script = join(root, ".cursor/skills/verify-pirate-radio/verify.sh");
const statePath = join(root, "output/qa/verify/state.json");
const ownedRunIds = new Set(["refusalcheck", "baddbcheck", "sudofailcheck"]);

function readState(): { runId?: string } | undefined {
  if (!existsSync(statePath)) return undefined;
  return JSON.parse(readFileSync(statePath, "utf8")) as { runId?: string };
}

function removeOwned(scratch: string, evidence: string) {
  const state = readState();
  if (state?.runId && ownedRunIds.has(state.runId)) rmSync(statePath, { force: true });
  rmSync(scratch, { recursive: true, force: true });
  rmSync(evidence, { recursive: true, force: true });
}

afterEach(() => {
  const state = readState();
  if (state?.runId && ownedRunIds.has(state.runId)) rmSync(statePath, { force: true });
});

test("verify database names stay per-run and a second launch does not clean the first", () => {
  const existing = readState();
  if (existing) throw new Error("output/qa/verify/state.json already exists. Refusing to touch a live verify run.");

  const derived = execFileSync(
    "bash",
    ["-c", "run_id='20261102T120000Z-99'; printf '%s' \"pirate_radio_verify_$(printf '%s' \"$run_id\" | tr '[:upper:]-' '[:lower:]_')\""],
    { encoding: "utf8" },
  );
  expect(derived).toBe("pirate_radio_verify_20261102t120000z_99");
  expect(derived).toMatch(/^pirate_radio_verify_[a-z0-9_]+$/);
  expect("pirate_radio").not.toMatch(/^pirate_radio_verify_[a-z0-9_]+$/);
  expect("pirate_radio_qa").not.toMatch(/^pirate_radio_verify_[a-z0-9_]+$/);

  const source = readFileSync(script, "utf8");
  const launch = source.slice(source.indexOf("launch() {"), source.indexOf("\ndoctor() {"));
  const stateCheck = launch.indexOf('if [ -f "$STATE" ]');
  const trap = launch.indexOf("trap ");
  expect(stateCheck).toBeGreaterThanOrEqual(0);
  expect(trap).toBeGreaterThan(stateCheck);
  expect(launch).toContain('bash "$SCRIPT" cleanup');
  expect(launch).not.toContain('"$0" cleanup');

  const bin = join(tmpdir(), `verify-refusal-bin-${process.pid}`);
  const sudoLog = join(tmpdir(), `verify-refusal-sudo-${process.pid}.log`);
  const scratch = "/tmp/pirate-radio-verify-refusalcheck";
  const evidence = join(root, "output/qa/verify/refusalcheck");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "sudo"), `#!/bin/sh\necho "$@" >> ${JSON.stringify(sudoLog)}\nexit 0\n`);
  chmodSync(join(bin, "sudo"), 0o755);
  mkdirSync(scratch, { recursive: true });
  mkdirSync(evidence, { recursive: true });
  writeFileSync(join(scratch, "marker"), "keep-scratch\n");
  writeFileSync(join(evidence, "marker"), "keep-evidence\n");
  const state = {
    runId: "refusalcheck",
    publicUrl: "http://localhost:9",
    serviceHost: "127.0.0.1",
    servicePort: 9,
    oidcIssuer: "https://localhost:9",
    oidcPort: 9,
    libraryDir: join(scratch, "library"),
    devDir: scratch,
    databaseName: "pirate_radio_verify_refusalcheck",
    pids: { oidc: 0, serve: 0 },
    evidenceDir: evidence,
    startedAt: "2026-01-01T00:00:00Z",
  };
  mkdirSync(join(root, "output/qa/verify"), { recursive: true });
  const stateText = `${JSON.stringify(state, null, 2)}\n`;
  writeFileSync(statePath, stateText);

  const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` };
  try {
    let launchFailed = false;
    try {
      execFileSync("bash", [script, "launch"], { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      launchFailed = true;
      const failed = error as { status?: number; stdout?: string; stderr?: string };
      expect(failed.status).toBe(1);
      expect(String(failed.stderr ?? "")).toContain("state exists");
      expect(String(failed.stdout ?? "")).not.toContain("cleanup done");
      expect(String(failed.stdout ?? "")).not.toContain("launch ok");
    }
    expect(launchFailed).toBe(true);
    expect(readFileSync(statePath, "utf8")).toBe(stateText);
    expect(readFileSync(join(scratch, "marker"), "utf8")).toBe("keep-scratch\n");
    expect(readFileSync(join(evidence, "marker"), "utf8")).toBe("keep-evidence\n");
    expect(existsSync(sudoLog)).toBe(false);

    writeFileSync(statePath, `${JSON.stringify({ ...state, runId: "baddbcheck", databaseName: "pirate_radio" }, null, 2)}\n`);
    let doctorFailed = false;
    try {
      execFileSync("bash", [script, "doctor"], { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      doctorFailed = true;
      const failed = error as { status?: number; stderr?: string };
      expect(failed.status).toBe(1);
      expect(String(failed.stderr ?? "")).toContain("databaseName failed");
    }
    expect(doctorFailed).toBe(true);
    expect(existsSync(sudoLog)).toBe(false);
    expect(readFileSync(join(scratch, "marker"), "utf8")).toBe("keep-scratch\n");

    let cleanupFailed = false;
    try {
      execFileSync("bash", [script, "cleanup"], { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      cleanupFailed = true;
      const failed = error as { status?: number; stderr?: string };
      expect(failed.status).toBe(1);
      expect(String(failed.stderr ?? "")).toContain("refusing database name pirate_radio");
    }
    expect(cleanupFailed).toBe(true);
    expect(existsSync(sudoLog)).toBe(false);
    expect(existsSync(statePath)).toBe(true);
    expect(readFileSync(join(scratch, "marker"), "utf8")).toBe("keep-scratch\n");
    expect(readFileSync(join(evidence, "marker"), "utf8")).toBe("keep-evidence\n");
  } finally {
    removeOwned(scratch, evidence);
    rmSync(bin, { recursive: true, force: true });
    rmSync(sudoLog, { force: true });
  }
});

test("cleanup removes an unstarted stack when the database drop fails", () => {
  const existing = readState();
  if (existing) throw new Error("output/qa/verify/state.json already exists. Refusing to touch a live verify run.");

  const bin = join(tmpdir(), `verify-unstarted-bin-${process.pid}`);
  const scratch = "/tmp/pirate-radio-verify-sudofailcheck";
  const evidence = join(root, "output/qa/verify/sudofailcheck");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "sudo"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(bin, "sudo"), 0o755);
  mkdirSync(scratch, { recursive: true });
  mkdirSync(evidence, { recursive: true });
  writeFileSync(join(scratch, "marker"), "drop-scratch\n");
  writeFileSync(join(evidence, "marker"), "keep-evidence\n");
  const state = {
    runId: "sudofailcheck",
    publicUrl: "http://localhost:9",
    serviceHost: "127.0.0.1",
    servicePort: 9,
    oidcIssuer: "https://localhost:9",
    oidcPort: 9,
    libraryDir: join(scratch, "library"),
    devDir: scratch,
    databaseName: "pirate_radio_verify_sudofailcheck",
    pids: { oidc: 0, serve: 0 },
    evidenceDir: evidence,
    startedAt: "2026-01-01T00:00:00Z",
  };
  mkdirSync(join(root, "output/qa/verify"), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);

  const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` };
  try {
    let failed = false;
    try {
      execFileSync("bash", [script, "cleanup"], { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      failed = true;
      const result = error as { status?: number; stderr?: string };
      expect(result.status).not.toBe(0);
      expect(String(result.stderr ?? "")).toContain("pirate_radio_verify_sudofailcheck");
    }
    expect(failed).toBe(true);
    expect(existsSync(statePath)).toBe(false);
    expect(existsSync(scratch)).toBe(false);
    expect(readFileSync(join(evidence, "marker"), "utf8")).toBe("keep-evidence\n");
  } finally {
    removeOwned(scratch, evidence);
    rmSync(bin, { recursive: true, force: true });
  }
});

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PirateRadioDatabase } from "../src/database.js";

const databaseUrl = process.env.PIRATE_RADIO_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("Postgres application state", () => {
  let database: PirateRadioDatabase;

  beforeAll(async () => {
    database = new PirateRadioDatabase(databaseUrl!);
    await database.migrate();
    await database.pool.query("TRUNCATE legacy_imports, submissions, playback_progress, oidc_transactions, sessions, app_users CASCADE");
  });

  afterAll(async () => {
    await database?.close();
  });

  test("isolates users and preserves the 95 percent completion latch", async () => {
    const first = await database.upsertUser({ issuer: "https://issuer/", subject: "one", username: "one", displayName: "One", email: "one@example.com", groups: ["pirate-radio-users"] });
    const second = await database.upsertUser({ issuer: "https://issuer/", subject: "two", username: "two", displayName: "Two", email: "two@example.com", groups: ["pirate-radio-users"] });
    expect((await database.saveProgress(first.id, "story", 94.9, 100)).completedAt).toBeUndefined();
    const completed = await database.saveProgress(first.id, "story", 95, 100);
    expect(completed.completedAt).toBeDefined();
    expect((await database.saveProgress(first.id, "story", 1, 100)).completedAt).toBe(completed.completedAt);
    expect(await database.progress(second.id, "story")).toBeUndefined();
    expect((await database.saveProgress(second.id, "ended", 1, 100, true)).completedAt).toBeDefined();
  });

  test("imports exactly 12 legacy rows once and exports a rollback-compatible round trip", async () => {
    const user = await database.upsertUser({ issuer: "https://issuer/", subject: "legacy", username: "joe", displayName: "Joe", email: "joe@example.com", groups: ["pirate-radio-users", "pirate-radio-admins"] });
    const libraryDir = await mkdtemp(join(tmpdir(), "pirate-radio-legacy-"));
    const entries = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`story-${index + 1}`, { positionSeconds: index + 0.5, durationSeconds: 100, updatedAt: "2026-07-13T00:00:00.000Z" }]));
    await writeFile(join(libraryDir, "progress.json"), `${JSON.stringify({ version: 1, updatedAt: "2026-07-13T00:00:00.000Z", users: { default: entries } }, null, 2)}\n`);

    const first = await database.importLegacyProgress(libraryDir, user.id);
    const second = await database.importLegacyProgress(libraryDir, user.id);
    expect(first).toMatchObject({ sourceCount: 12, destinationCount: 12, alreadyImported: false });
    expect(first.backupPath).toContain("progress.pre-postgres");
    expect(second).toMatchObject({ sourceCount: 12, destinationCount: 12, alreadyImported: true });

    const exported = await database.exportLegacyProgress(libraryDir, user.id);
    const parsed = JSON.parse(await readFile(exported.path, "utf8"));
    expect(exported.count).toBe(12);
    expect(Object.keys(parsed.users.default)).toHaveLength(12);
    expect(parsed.users.default["story-1"].positionSeconds).toBe(0.5);
  });

  test("uses current usernames for article attribution and preserves submission snapshots", async () => {
    const user = await database.upsertUser({ issuer: "https://issuer/", subject: "submitter", username: "old-name", displayName: "Submitter", email: "submitter@example.com", groups: ["pirate-radio-users"] });
    const humanTypes = ["feed", "url", "custom_text"] as const;
    const humanSubmissions = [];
    for (const type of humanTypes) {
      const submission = await database.createSubmission({ slug: `attributed-${type}`, type, submittedBy: user });
      await database.updateSubmission(submission.id, "processing");
      await database.updateSubmission(submission.id, "succeeded");
      humanSubmissions.push(submission);
    }
    const automated = await database.createSubmission({ slug: "attributed-automated", type: "automated" });
    await database.updateSubmission(automated.id, "failed", { error: "conversion failed" });
    await database.upsertUser({ issuer: "https://issuer/", subject: "submitter", username: "new-name", displayName: "Submitter", email: "submitter@example.com", groups: [] });
    for (const type of humanTypes) {
      expect((await database.firstSuccessfulSubmitter(`attributed-${type}`))?.username).toBe("new-name");
    }
    expect(await database.firstSuccessfulSubmitter("attributed-automated")).toBeUndefined();
    const stored = await database.submissions();
    for (const submission of humanSubmissions) {
      expect(stored.find((item) => item.id === submission.id)).toMatchObject({
        status: "succeeded",
        submittedByUsername: "old-name",
      });
    }
    expect(stored.find((item) => item.id === automated.id)).toMatchObject({
      status: "failed",
      error: "conversion failed",
    });
  });
});

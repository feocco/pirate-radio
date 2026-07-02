import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { progressPath, readPlaybackProgress, writePlaybackProgress } from "../src/progress.js";

describe("playback progress", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pirate-progress-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("stores per-article playback progress in a durable single-user file", async () => {
    await writePlaybackProgress(tempDir, "test-story", {
      positionSeconds: 119.4,
      durationSeconds: 1800.1,
    });

    const progress = await readPlaybackProgress(tempDir, "test-story");

    expect(progress).toMatchObject({
      positionSeconds: 119.4,
      durationSeconds: 1800.1,
    });
    expect(progress?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(progressPath(tempDir)).toBe(join(tempDir, "progress.json"));
  });

  test("returns undefined for stories without saved progress", async () => {
    await expect(readPlaybackProgress(tempDir, "missing-story")).resolves.toBeUndefined();
  });
});

import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { cacheStoryImage, contentTypeForAsset } from "../src/assets.js";
import { expectTimeoutBudget } from "./support/timeouts.js";

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("article assets", () => {
  test("caches article art under the library images directory", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pirate-assets-"));
    await mkdir(join(tempDir, "images"), { recursive: true });
    const fetchImage = vi.fn<typeof fetch>(
      async () =>
        new Response(new TextEncoder().encode("fake image"), {
          headers: { "content-type": "image/png" },
        }),
    );

    const result = await cacheStoryImage({
      libraryDir: tempDir,
      slug: "inside-microns-attempts",
      imageUrl: "https://www.piratewires.com/_next/image?url=https%3A%2F%2Fexample.com%2Fhero.png&w=1920&q=75",
      fetchImage,
    });

    expect(result).toEqual({
      imagePath: join(tempDir, "images", "inside-microns-attempts.png"),
      imageUrl: "/images/inside-microns-attempts.png",
    });
    expect(await readFile(result!.imagePath, "utf8")).toBe("fake image");
  });

  test("identifies common image content types", () => {
    expect(contentTypeForAsset("hero.png")).toBe("image/png");
    expect(contentTypeForAsset("hero.jpg")).toBe("image/jpeg");
    expect(contentTypeForAsset("hero.webp")).toBe("image/webp");
  });

  test("an image download past its 30s budget rejects with the timeout", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pirate-assets-"));
    const timeout = expectTimeoutBudget(30_000);
    await expect(
      cacheStoryImage({
        libraryDir: tempDir,
        slug: "public-piece",
        imageUrl: "https://cdn.example/hero.png",
        fetchImage: timeout.fetch,
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    timeout.verify();
  });
});

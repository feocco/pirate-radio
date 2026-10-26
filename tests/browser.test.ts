import { describe, expect, test } from "vitest";
import {
  PirateWiresAuthRequiredError,
  canonicalPirateWiresUrl,
  extractStoryFromUrl,
  profileDirFromEnv,
  validatePirateWiresAccess,
} from "../src/browser.js";
import { expectTimeoutBudget } from "./support/timeouts.js";

describe("browser extraction URLs", () => {
  test("normalizes Substack feed URLs to Pirate Wires article pages", () => {
    expect(
      canonicalPirateWiresUrl("https://piratewires.substack.com/p/inside-microns-attempts-to-reindustrialize"),
    ).toBe("https://www.piratewires.com/p/inside-microns-attempts-to-reindustrialize");
  });

  test("leaves Pirate Wires URLs unchanged", () => {
    expect(canonicalPirateWiresUrl("https://www.piratewires.com/p/what-happened-to-medium")).toBe(
      "https://www.piratewires.com/p/what-happened-to-medium",
    );
  });

  test("allows the Playwright profile path to be configured for Docker", () => {
    expect(profileDirFromEnv({ PWR_PROFILE_DIR: "/data/playwright-profile" })).toBe(
      "/data/playwright-profile",
    );
    expect(profileDirFromEnv({})).toBe(".playwright-profile");
  });

  test("rejects public preview pages before returning truncated article text", () => {
    expect(() =>
      validatePirateWiresAccess({
        pageText: "Pirate Wires Technology Gift a Sub",
        articleWordCount: 362,
        profileDir: "/data/playwright-profile",
      }),
    ).toThrow(PirateWiresAuthRequiredError);
  });

  test("accepts logged-in pages with full article access", () => {
    expect(() =>
      validatePirateWiresAccess({
        pageText: "Pirate Wires Technology My Account",
        articleWordCount: 2017,
        profileDir: "/data/playwright-profile",
      }),
    ).not.toThrow();
  });

  test("a public article fetch past its 30s budget rejects with the timeout", async () => {
    const timeout = expectTimeoutBudget(30_000, { globalFetch: true });
    await expect(extractStoryFromUrl("https://www.hyperdimensional.co/p/public-piece")).rejects.toMatchObject({
      name: "TimeoutError",
    });
    timeout.verify();
  });
});

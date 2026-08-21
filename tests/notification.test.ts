import { describe, expect, test } from "vitest";
import {
  buildArticleFailureNotification,
  buildArticleNotification,
  buildArticleReadyNotification,
  parsePirateRadioAction,
} from "../src/notifications.js";
import { PirateWiresAuthRequiredError, WsjAuthRequiredError } from "../src/browser.js";

describe("Pirate Radio notifications", () => {
  const article = {
    id: "https://piratewires.substack.com/p/inside-microns-attempts",
    title: "Inside Micron's Attempts",
    url: "https://piratewires.substack.com/p/inside-microns-attempts",
    author: "Ryan Hassan",
    publishedAt: "Mon, 22 Jun 2026 17:07:10 GMT",
    description: "following nonsense regulations",
  };

  test("builds stable Yes/No mobile action IDs", () => {
    const notification = buildArticleNotification(article, "https://pirate-radio.example.test");

    expect(notification.title).toBe("Pirate Radio");
    expect(notification.message).toContain("Inside Micron's Attempts");
    expect(notification.buttons).toEqual([
      {
        title: "Yes",
        action: "PIRATE_RADIO_ACCEPT::inside-microns-attempts",
      },
      {
        title: "No",
        action: "PIRATE_RADIO_SKIP::inside-microns-attempts",
      },
    ]);
  });

  test("parses accepted and skipped action IDs", () => {
    expect(parsePirateRadioAction("PIRATE_RADIO_ACCEPT::inside-microns-attempts")).toEqual({
      decision: "accept",
      slug: "inside-microns-attempts",
    });
    expect(parsePirateRadioAction("PIRATE_RADIO_SKIP::inside-microns-attempts")).toEqual({
      decision: "skip",
      slug: "inside-microns-attempts",
    });
    expect(parsePirateRadioAction("OTHER_ACTION")).toBeNull();
  });

  test("builds a ready notification with a direct article URL", () => {
    const notification = buildArticleReadyNotification(
      {
        slug: "inside-microns-attempts",
        title: "Inside Micron's Attempts",
      },
      "https://pirate-radio.example.test/",
    );

    expect(notification.title).toBe("Pirate Radio Ready");
    expect(notification.message).toContain("Inside Micron's Attempts");
    expect(notification.url).toBe("https://pirate-radio.example.test/article/inside-microns-attempts");
    expect(notification.buttons).toEqual([]);
  });

  test("builds an actionable failure notification", () => {
    const notification = buildArticleFailureNotification(
      article,
      new Error("Pirate Wires login required for /data/playwright-profile"),
      "https://pirate-radio.example.test/",
    );

    expect(notification.title).toBe("Pirate Radio Failed");
    expect(notification.message).toContain("Inside Micron's Attempts");
    expect(notification.message).toContain("login required");
    expect(notification.url).toBe("https://pirate-radio.example.test/");
    expect(notification.buttons).toEqual([]);
  });

  test("builds a direct login notification for auth failures when reauth URL is configured", () => {
    const notification = buildArticleFailureNotification(
      article,
      new PirateWiresAuthRequiredError("/data/playwright-profile"),
      "https://pirate-radio.example.test/",
      "http://maclabs-mac-mini.taildf3445.ts.net:5801/",
    );

    expect(notification.title).toBe("Pirate Radio Login Required");
    expect(notification.message).toContain("fresh Pirate Wires login");
    expect(notification.url).toBe("http://maclabs-mac-mini.taildf3445.ts.net:5801/");
    expect(notification.buttons).toEqual([
      {
        title: "Open Login",
        action: "URI",
        uri: "http://maclabs-mac-mini.taildf3445.ts.net:5801/",
      },
    ]);
  });

  test("builds a WSJ login notification for auth failures when reauth URL is configured", () => {
    const notification = buildArticleFailureNotification(
      {
        ...article,
        title: "Steve Jobs, Apple and the CIA",
        sourceName: "WSJ",
      },
      new WsjAuthRequiredError("/data/playwright-profile"),
      "https://pirate-radio.example.test/",
      "http://maclabs-mac-mini.taildf3445.ts.net:5801/",
    );

    expect(notification.title).toBe("Pirate Radio Login Required");
    expect(notification.message).toContain("fresh WSJ login");
    expect(notification.url).toBe("http://maclabs-mac-mini.taildf3445.ts.net:5801/");
  });
});

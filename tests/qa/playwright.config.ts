import { defineConfig } from "@playwright/test";

const evidence = process.env.PIRATE_RADIO_QA_EVIDENCE === "1";

export default defineConfig({
  testDir: ".",
  outputDir: "../../output/qa/test-results",
  timeout: 120_000,
  workers: 1,
  forbidOnly: true,
  globalTeardown: "./redact-traces.ts",
  reporter: [["list"]],
  use: {
    browserName: "chromium",
    headless: true,
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 900 },
    trace: evidence ? "on" : "retain-on-failure",
    video: evidence ? { mode: "on", size: { width: 1280, height: 900 } } : "off",
    launchOptions: evidence ? { slowMo: 300 } : {},
  },
});

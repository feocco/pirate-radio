#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import { openLoginBrowser, extractStoryFromUrl } from "./browser.js";
import { configFromEnv } from "./config.js";
import { validateIdentityConfig } from "./config.js";
import { PirateRadioDatabase } from "./database.js";
import { writeStoryOutputs } from "./output.js";
import { PirateRadioService } from "./server.js";
import { looksLikeUrl, readStoryJson } from "./storyFile.js";
import { createTtsProvider } from "./tts/index.js";
import type { Story } from "./types.js";

const program = new Command();

program
  .name("pirate-radio")
  .description("Monitor articles, generate TTS audio, and serve the Pirate Radio reader.")
  .version("0.1.0");

program
  .command("login")
  .description("Open a browser with an isolated profile for Pirate Wires login.")
  .action(async () => {
    await openLoginBrowser();
  });

program
  .command("extract")
  .argument("<url>", "Pirate Wires story URL")
  .description("Extract story text, reader metadata, and write txt/json outputs.")
  .action(async (url: string) => {
    const story = await extractStoryFromUrl(url);
    const written = await writeStoryOutputs(story);
    console.log(`Text: ${written.textPath}`);
    console.log(`JSON: ${written.jsonPath}`);
  });

program
  .command("speak")
  .argument("<json-or-url>", "Story JSON file or supported article URL")
  .option("--provider <provider>", "TTS provider", "openai")
  .option("--allow-over-budget", "Allow audio generation over the $1 estimate", false)
  .description("Generate audio from extracted story JSON or from a story URL.")
  .action(async (input: string, options: { provider: string; allowOverBudget: boolean }) => {
    const story = await loadStory(input);
    const audioPath = await storyAudioPath(story);
    const provider = createTtsProvider(options.provider);
    const result = await provider.synthesize({
      title: story.title,
      text: story.text,
      outputPath: audioPath,
      allowOverBudget: options.allowOverBudget,
    });

    console.log(`Provider: ${result.provider}`);
    console.log(`Estimated cost: $${result.estimatedCostUsd.toFixed(4)}`);
    console.log(`Audio: ${result.outputPath}`);
  });

program
  .command("read")
  .argument("<url>", "Pirate Wires story URL")
  .option("--provider <provider>", "TTS provider", "openai")
  .option("--allow-over-budget", "Allow audio generation over the $1 estimate", false)
  .description("Extract a story and generate audio in one command.")
  .action(async (url: string, options: { provider: string; allowOverBudget: boolean }) => {
    const story = await extractStoryFromUrl(url);
    const written = await writeStoryOutputs(story);
    const audioPath = await storyAudioPath(story);
    const provider = createTtsProvider(options.provider);
    const result = await provider.synthesize({
      title: story.title,
      text: story.text,
      outputPath: audioPath,
      allowOverBudget: options.allowOverBudget,
    });

    console.log(`Text: ${written.textPath}`);
    console.log(`JSON: ${written.jsonPath}`);
    console.log(`Provider: ${result.provider}`);
    console.log(`Estimated cost: $${result.estimatedCostUsd.toFixed(4)}`);
    console.log(`Audio: ${result.outputPath}`);
  });

program
  .command("serve")
  .description("Run the deployed Pirate Radio service: monitor, approvals, library, and reader.")
  .action(async () => {
    const service = new PirateRadioService({ config: configFromEnv() });
    await service.start();
  });

program
  .command("poll")
  .description("Run one Pirate Radio RSS monitor poll.")
  .action(async () => {
    const service = new PirateRadioService({ config: configFromEnv() });
    await service.pollOnce();
  });

program
  .command("simulate")
  .argument("<decision>", "accept or skip")
  .argument("<slug>", "Article slug from pending state")
  .description("Simulate a Home Assistant mobile action for local validation.")
  .action(async (decision: "accept" | "skip", slug: string) => {
    if (decision !== "accept" && decision !== "skip") {
      throw new Error('Decision must be "accept" or "skip".');
    }
    const service = new PirateRadioService({ config: configFromEnv() });
    await service.decide(slug, decision);
  });

program
  .command("migrate-progress")
  .requiredOption("--user-id <id>", "Application user id returned by /auth/me")
  .option("--expect-count <count>", "Required legacy record count", "12")
  .description("Import legacy progress.json users.default rows into an OIDC application user.")
  .action(async (options: { userId: string; expectCount: string }) => {
    const config = configFromEnv();
    validateIdentityConfig(config);
    const database = new PirateRadioDatabase(config.databaseUrl!);
    try {
      await database.migrate();
      if (!(await database.applicationUser(options.userId))) throw new Error(`Application user ${options.userId} does not exist. Log in normally first.`);
      const result = await database.importLegacyProgress(config.libraryDir, options.userId);
      const expected = Number(options.expectCount);
      if (result.sourceCount !== expected || result.destinationCount !== expected) {
        throw new Error(`Expected ${expected} legacy rows, got source=${result.sourceCount}, destination=${result.destinationCount}.`);
      }
      console.log(JSON.stringify(result));
    } finally {
      await database.close();
    }
  });

program
  .command("export-progress")
  .requiredOption("--user-id <id>", "Application user id returned by /auth/me")
  .description("Export one application user's database progress as rollback-compatible legacy JSON.")
  .action(async (options: { userId: string }) => {
    const config = configFromEnv();
    validateIdentityConfig(config);
    const database = new PirateRadioDatabase(config.databaseUrl!);
    try {
      await database.migrate();
      if (!(await database.applicationUser(options.userId))) throw new Error(`Application user ${options.userId} does not exist.`);
      console.log(JSON.stringify(await database.exportLegacyProgress(config.libraryDir, options.userId)));
    } finally {
      await database.close();
    }
  });

await program.parseAsync();

async function loadStory(input: string): Promise<Story> {
  if (looksLikeUrl(input)) {
    const story = await extractStoryFromUrl(input);
    await writeStoryOutputs(story);
    return story;
  }

  return readStoryJson(input);
}

async function storyAudioPath(story: Story): Promise<string> {
  const outputDir = join("output", "audio");
  await mkdir(outputDir, { recursive: true });
  const { storySlug } = await import("./output.js");
  return join(outputDir, `${storySlug(story)}.mp3`);
}

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { extractStoryFromUrl } from "../src/browser.js";
import {
  buildHostAdapterPrompt,
  HOST_ADAPTER_TIMEOUT_MESSAGE,
  PIRATE_RADIO_REPO_URL,
  proposeHostAdapter,
  queueHostAdapterProposal,
  type CloudAgentFactory,
} from "../src/cloudExtract.js";
import {
  markCloudHostAdapterRequested,
  readCloudHostStore,
  recordCloudHostExtract,
} from "../src/cloudHosts.js";

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("cloud host adapter factory", () => {
  test("records a host fingerprint after a successful cloud extract", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pirate-cloud-hosts-"));
    const sourceUrl = "https://darioamodei.com/post/we-must-pace-the-frontier";
    const createAgent: CloudAgentFactory = vi.fn(async () => ({
      send: vi.fn(async () => ({
        wait: async () => ({ status: "finished" as const }),
      })),
      listArtifacts: async () => [{ path: "artifacts/story.json" }],
      downloadArtifact: async () =>
        new Uint8Array(
          Buffer.from(
            JSON.stringify({
              title: "We Must Pace the Frontier",
              text: "I think we should pace.\n\nThat is the work.",
              sourceUrl,
              characterCount: 10,
              wordCount: 2,
              extractedAt: "2026-09-13T12:00:00.000Z",
              selectors: ["article", "main .post"],
            }),
          ),
        ),
      close: vi.fn(),
    }));

    await extractStoryFromUrl(sourceUrl, {
      firstSentence: "I think we should pace.",
      lastSentence: "That is the work.",
      apiKey: "crsr_test",
      createAgent,
      libraryDir: tempDir,
    });

    const store = await readCloudHostStore(tempDir);
    expect(store.hosts["darioamodei.com"]).toMatchObject({
      host: "darioamodei.com",
      lastSourceUrl: sourceUrl,
      adapterStatus: "none",
      fingerprint: {
        anchors: {
          firstSentence: "I think we should pace.",
          lastSentence: "That is the work.",
        },
        selectors: ["article", "main .post"],
      },
    });
  });

  test("propose-adapter launches a repo agent and does not merge", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pirate-cloud-hosts-"));
    await recordCloudHostExtract({
      libraryDir: tempDir,
      sourceUrl: "https://darioamodei.com/post/we-must-pace-the-frontier",
      selectors: ["article"],
    });

    const send = vi.fn(async () => ({
      wait: async () => ({
        status: "finished" as const,
        git: {
          branches: [
            {
              repoUrl: PIRATE_RADIO_REPO_URL,
              prUrl: "https://github.com/feocco/pirate-radio/pull/99",
            },
          ],
        },
      }),
    }));
    const createAgent: CloudAgentFactory = vi.fn(async () => ({
      agentId: "bc-adapter",
      send,
      listArtifacts: async () => [],
      downloadArtifact: async () => new Uint8Array(),
      close: vi.fn(),
    }));

    const result = await proposeHostAdapter({
      hostOrUrl: "https://www.darioamodei.com/post/we-must-pace-the-frontier",
      libraryDir: tempDir,
      apiKey: "crsr_test",
      createAgent,
    });

    expect(createAgent).toHaveBeenCalledWith({
      apiKey: "crsr_test",
      cloud: {
        repos: [{ url: PIRATE_RADIO_REPO_URL, startingRef: "main" }],
        autoCreatePR: true,
      },
    });
    const prompt = String(send.mock.calls.at(0)?.at(0) ?? "");
    expect(prompt).toContain("Do not merge or enable auto-merge.");
    expect(prompt).toContain("darioamodei.com");
    expect(result).toEqual({
      host: "darioamodei.com",
      agentId: "bc-adapter",
      prUrl: "https://github.com/feocco/pirate-radio/pull/99",
    });
    expect((await readCloudHostStore(tempDir)).hosts["darioamodei.com"]).toMatchObject({
      adapterStatus: "requested",
      adapterPrUrl: "https://github.com/feocco/pirate-radio/pull/99",
    });
  });

  test("queueHostAdapterProposal returns before the agent wait finishes", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pirate-cloud-hosts-"));
    let finish!: (value: { status: "finished" }) => void;
    const wait = new Promise<{ status: "finished" }>((resolve) => {
      finish = resolve;
    });
    const createAgent: CloudAgentFactory = vi.fn(async () => ({
      send: async () => ({ wait: () => wait }),
      listArtifacts: async () => [],
      downloadArtifact: async () => new Uint8Array(),
      close: vi.fn(),
    }));

    const first = await queueHostAdapterProposal({
      hostOrUrl: "https://slow.example/post/article",
      libraryDir: tempDir,
      apiKey: "crsr_test",
      createAgent,
    });
    const second = await queueHostAdapterProposal({
      hostOrUrl: "slow.example",
      libraryDir: tempDir,
      apiKey: "crsr_test",
      createAgent,
    });

    expect(first).toEqual({ ok: true, status: "queued", host: "slow.example" });
    expect(second).toEqual({ ok: true, status: "processing", host: "slow.example" });
    await vi.waitFor(() => expect(createAgent).toHaveBeenCalledTimes(1));
    finish({ status: "finished" });
  });

  test("queueHostAdapterProposal returns an already opened PR without launching", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pirate-cloud-hosts-"));
    await markCloudHostAdapterRequested({
      libraryDir: tempDir,
      host: "opened.example",
      prUrl: "https://github.com/feocco/pirate-radio/pull/7",
    });
    const createAgent = vi.fn();

    await expect(
      queueHostAdapterProposal({
        hostOrUrl: "opened.example",
        libraryDir: tempDir,
        apiKey: "crsr_test",
        createAgent,
      }),
    ).resolves.toEqual({
      ok: true,
      status: "opened",
      host: "opened.example",
      prUrl: "https://github.com/feocco/pirate-radio/pull/7",
    });
    expect(createAgent).not.toHaveBeenCalled();
  });

  test("adapter prompt names the extractor patterns and fingerprint", () => {
    const prompt = buildHostAdapterPrompt({
      host: "darioamodei.com",
      sourceUrl: "https://darioamodei.com/post/we-must-pace-the-frontier",
      fingerprint: { selectors: ["article"], anchors: { firstSentence: "Hello." } },
    });
    expect(prompt).toContain("src/extractor.ts");
    expect(prompt).toContain("Do not add Mozilla Readability");
    expect(prompt).toContain("article");
    expect(prompt).toContain("Hello.");
  });

  test("fails closed when the adapter agent create hangs", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pirate-cloud-hosts-"));
    await expect(
      proposeHostAdapter({
        hostOrUrl: "slow.example",
        libraryDir: tempDir,
        apiKey: "crsr_test",
        timeoutMs: 20,
        createAgent: () => new Promise(() => {}),
      }),
    ).rejects.toThrow(HOST_ADAPTER_TIMEOUT_MESSAGE);
  });

  test("can mark an adapter request without a prior extract", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pirate-cloud-hosts-"));
    const record = await markCloudHostAdapterRequested({
      libraryDir: tempDir,
      host: "darioamodei.com",
      agentId: "bc-1",
    });
    expect(record.adapterStatus).toBe("requested");
    expect(record.adapterAgentId).toBe("bc-1");
  });
});

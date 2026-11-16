import { afterEach, describe, expect, test, vi } from "vitest";
import { createCursorSdkAgent } from "../src/cloudExtract.js";

const create = vi.hoisted(() => vi.fn());

vi.mock("@cursor/sdk", () => ({
  Agent: { create },
}));

afterEach(() => {
  create.mockReset();
  delete process.env.PIRATE_RADIO_CLOUD_MODEL;
});

describe("cloud extract model", () => {
  test("Agent.create receives grok-4.7 unless PIRATE_RADIO_CLOUD_MODEL overrides it", async () => {
    create.mockResolvedValue({ close() {} });
    const cloud = { repos: [{ url: "https://github.com/feocco/pirate-radio", startingRef: "main" }] };

    await createCursorSdkAgent({ apiKey: "crsr_test", cloud });
    expect(create).toHaveBeenCalledWith({
      apiKey: "crsr_test",
      model: { id: "grok-4.7" },
      cloud,
    });

    process.env.PIRATE_RADIO_CLOUD_MODEL = " composer-2.5 ";
    await createCursorSdkAgent({ apiKey: "crsr_test", cloud });
    expect(create).toHaveBeenLastCalledWith({
      apiKey: "crsr_test",
      model: { id: "composer-2.5" },
      cloud,
    });
  });
});

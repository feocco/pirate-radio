import vm from "node:vm";
import { describe, expect, test } from "vitest";
import { renderAdminHtml } from "../src/reader.js";

interface AdapterOutcome {
  statusText: string;
  statusClass: string;
  host: string;
  button: string;
  postedHost: string | null;
}

function element(initial: { text?: string; className?: string; value?: string } = {}) {
  const listeners = new Map<string, (event: { preventDefault: () => void }) => unknown>();
  return {
    textContent: initial.text ?? "",
    className: initial.className ?? "",
    value: initial.value ?? "",
    disabled: false,
    addEventListener(type: string, fn: (event: { preventDefault: () => void }) => unknown) {
      listeners.set(type, fn);
    },
    async emit(type: string) {
      const fn = listeners.get(type);
      if (!fn) throw new Error(`no ${type} listener`);
      await fn({ preventDefault() {} });
    },
  };
}

async function submitAdapter(response: { status: number; body: Record<string, unknown> }, host: string): Promise<AdapterOutcome> {
  const html = renderAdminHtml();
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]).find((source) => source.includes("adapter-form"));
  if (!script) throw new Error("admin page did not include the adapter form script");

  const health = element({ text: "Checking...", className: "admin-value" });
  const form = element();
  const hostInput = element({ value: host });
  const submit = element({ text: "Propose adapter PR" });
  const status = element({ className: "status" });
  const elements: Record<string, ReturnType<typeof element>> = {
    health,
    "adapter-form": form,
    "adapter-host": hostInput,
    "adapter-submit": submit,
    "adapter-status": status,
  };
  let postedHost: string | null = null;

  const context = vm.createContext({
    document: {
      getElementById(id: string) {
        const found = elements[id];
        if (!found) throw new Error(`missing #${id}`);
        return found;
      },
    },
    fetch: async (url: string, init?: { body?: string }) => {
      if (url === "/health") {
        return { ok: true, status: 200, async json() { return { ok: true }; } };
      }
      if (url !== "/admin/propose-adapter") throw new Error(`unexpected fetch ${url}`);
      postedHost = JSON.parse(init?.body ?? "{}").host ?? null;
      return {
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        async json() { return response.body; },
      };
    },
  });
  vm.runInContext(script, context);
  await form.emit("submit");

  return {
    statusText: status.textContent,
    statusClass: status.className,
    host: hostInput.value,
    button: submit.textContent,
    postedHost,
  };
}

describe("admin adapter proposal", () => {
  test("shows the provider error and keeps the host when the proposal is refused", async () => {
    const outcome = await submitAdapter(
      { status: 422, body: { ok: false, error: "Host is not allowed" } },
      "https://example.com/essay",
    );

    expect(outcome.postedHost).toBe("https://example.com/essay");
    expect(outcome.statusText).toBe("Host is not allowed");
    expect(outcome.statusClass).toBe("status error");
    expect(outcome.host).toBe("https://example.com/essay");
    expect(outcome.button).toBe("Propose adapter PR");
    expect(outcome.button).not.toBe("Queueing");
  });

  test("shows the fallback and keeps the host when a refusal has no error text", async () => {
    const outcome = await submitAdapter({ status: 500, body: { ok: false } }, "https://example.com/note");

    expect(outcome.statusText).toBe("Could not propose an adapter.");
    expect(outcome.statusClass).toBe("status error");
    expect(outcome.host).toBe("https://example.com/note");
  });

  test("shows the pull request and clears the host when a proposal is accepted", async () => {
    const outcome = await submitAdapter(
      { status: 200, body: { ok: true, prUrl: "https://github.com/feocco/pirate-radio/pull/40" } },
      "https://example.com/essay",
    );

    expect(outcome.statusText).toBe("Opened https://github.com/feocco/pirate-radio/pull/40. Review it; do not auto-merge.");
    expect(outcome.statusClass).toBe("status");
    expect(outcome.host).toBe("");
    expect(outcome.button).toBe("Propose adapter PR");
  });
});

import { afterEach, describe, expect, test } from "vitest";
import { attachCastControl } from "../src/mediaPlayerCast.js";
import { renderMediaPlayerClient } from "../src/mediaPlayer.js";

type Listener = () => void;

function createButton() {
  const attributes = new Map<string, string>();
  const listeners = new Map<string, Listener>();
  return {
    type: "",
    className: "",
    hidden: true,
    innerHTML: "",
    title: "",
    setAttribute(name: string, value: string) {
      attributes.set(name, value);
    },
    getAttribute(name: string) {
      return attributes.get(name);
    },
    addEventListener(name: string, handler: Listener) {
      listeners.set(name, handler);
    },
    removeEventListener(name: string) {
      listeners.delete(name);
    },
    remove() {
      this.removed = true;
    },
    click() {
      listeners.get("click")?.();
    },
    removed: false,
    attributes,
  };
}

function createRemote(available = true) {
  const listeners = new Map<string, Listener>();
  return {
    state: "disconnected",
    watchAvailability(callback: (available: boolean) => void) {
      callback(available);
      return Promise.resolve(7);
    },
    cancelWatchAvailability() {},
    prompt() {
      this.state = "connected";
      listeners.get("connect")?.();
      return Promise.resolve();
    },
    addEventListener(name: string, handler: Listener) {
      listeners.set(name, handler);
    },
    removeEventListener(name: string) {
      listeners.delete(name);
    },
    listeners,
  };
}

describe("attachCastControl", () => {
  const originalDocument = (globalThis as { document?: unknown }).document;

  afterEach(() => {
    (globalThis as { document?: unknown }).document = originalDocument;
  });

  test("hides the control when Remote Playback is missing", () => {
    const extra = { appended: undefined as unknown, append() {} };
    const player = {
      audio: {},
      el: {
        querySelector: () => extra,
        toggleAttribute() {},
        removeAttribute() {},
      },
    };
    const detach = attachCastControl(player);
    expect(extra.appended).toBeUndefined();
    detach();
  });

  test("shows a Cast button when a receiver is available and prompts on click", async () => {
    const button = createButton();
    (globalThis as unknown as { document: { createElement(): typeof button } }).document = {
      createElement: () => button,
    };
    const extra = { appended: undefined as unknown, append(node: unknown) { this.appended = node; } };
    const remote = createRemote(true);
    const player = {
      audio: { remote, disableRemotePlayback: true as boolean | undefined },
      el: {
        querySelector: (selector: string) => (selector === ".shk-controls_extra" ? extra : null),
        toggleAttribute() {},
        removeAttribute() {},
      },
    };

    const detach = attachCastControl(player);
    expect(player.audio.disableRemotePlayback).toBe(false);
    expect(extra.appended).toBe(button);
    expect(button.hidden).toBe(false);
    expect(button.getAttribute("aria-label")).toBe("Cast");

    button.click();
    await Promise.resolve();
    expect(remote.state).toBe("connected");
    expect(button.getAttribute("aria-label")).toBe("Stop casting");

    detach();
    expect(button.removed).toBe(true);
  });

  test("keeps the Cast button hidden when no receiver is available", () => {
    const button = createButton();
    (globalThis as unknown as { document: { createElement(): typeof button } }).document = {
      createElement: () => button,
    };
    const extra = { append() {} };
    const player = {
      audio: { remote: createRemote(false) },
      el: {
        querySelector: () => extra,
        toggleAttribute() {},
        removeAttribute() {},
      },
    };
    attachCastControl(player);
    expect(button.hidden).toBe(true);
  });
});

describe("media player client cast wiring", () => {
  test("embeds the Remote Playback helper and keeps audio session-protected", () => {
    const client = renderMediaPlayerClient();
    expect(client).toContain("function attachCastControl");
    expect(client).toContain("watchAvailability");
    expect(client).toContain("remote.prompt()");
    expect(client).toContain("audio.disableRemotePlayback = false");
    expect(client).toContain("detachCast()");
    expect(client).toContain("window.dispatchEvent(new Event(\"resize\"))");
    expect(client).not.toContain("/cast");
    expect(client).not.toContain("cast=");
  });
});

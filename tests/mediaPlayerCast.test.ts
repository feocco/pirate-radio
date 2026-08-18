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
    disabled: false,
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
  const remote = {
    state: "disconnected",
    watchAvailability(callback: (available: boolean) => void) {
      callback(available);
      return Promise.resolve(7);
    },
    cancelWatchAvailability() {},
    async prompt() {
      remote.state = "connecting";
      listeners.get("connecting")?.();
      remote.state = "connected";
      listeners.get("connect")?.();
    },
    addEventListener(name: string, handler: Listener) {
      listeners.set(name, handler);
    },
    removeEventListener(name: string) {
      listeners.delete(name);
    },
    listeners,
  };
  return remote;
}

function createAudio(remote: ReturnType<typeof createRemote>) {
  return {
    remote,
    disableRemotePlayback: true as boolean | undefined,
    currentTime: 42.5,
    paused: false,
    playbackRate: 1.25,
    readyState: 4,
    playCalls: 0,
    pauseCalls: 0,
    play() {
      this.playCalls += 1;
      this.paused = false;
      return Promise.resolve();
    },
    pause() {
      this.pauseCalls += 1;
      this.paused = true;
    },
    addEventListener() {},
  };
}

function createPlayer(audio: ReturnType<typeof createAudio>) {
  const attributes = new Set<string>();
  const extra = {
    appended: undefined as unknown,
    append(node: unknown) {
      this.appended = node;
    },
  };
  return {
    audio,
    el: {
      querySelector: (selector: string) => (selector === ".shk-controls_extra" ? extra : null),
      toggleAttribute(name: string, force?: boolean) {
        if (force === false) attributes.delete(name);
        else attributes.add(name);
      },
      removeAttribute(name: string) {
        attributes.delete(name);
      },
      hasAttribute(name: string) {
        return attributes.has(name);
      },
    },
    extra,
  };
}

async function flushPrompt() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
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
    const remote = createRemote(true);
    const audio = createAudio(remote);
    const player = createPlayer(audio);

    const detach = attachCastControl(player);
    expect(audio.disableRemotePlayback).toBe(false);
    expect(player.extra.appended).toBe(button);
    expect(button.hidden).toBe(false);
    expect(button.getAttribute("aria-label")).toBe("Cast");

    button.click();
    await flushPrompt();
    expect(remote.state).toBe("connected");
    expect(button.getAttribute("aria-label")).toBe("Stop casting");
    expect(player.el.hasAttribute("data-cast")).toBe(true);
    expect(audio.currentTime).toBe(42.5);
    expect(audio.paused).toBe(false);

    detach();
    expect(button.removed).toBe(true);
  });

  test("keeps the Cast button hidden when no receiver is available", () => {
    const button = createButton();
    (globalThis as unknown as { document: { createElement(): typeof button } }).document = {
      createElement: () => button,
    };
    const remote = createRemote(false);
    const audio = createAudio(remote);
    const player = createPlayer(audio);
    attachCastControl(player);
    expect(button.hidden).toBe(true);
  });

  test("restores playback when Cast prompt finds no device", async () => {
    const button = createButton();
    (globalThis as unknown as { document: { createElement(): typeof button } }).document = {
      createElement: () => button,
    };
    const remote = createRemote(true);
    const audio = createAudio(remote);
    remote.prompt = async () => {
      remote.state = "connecting";
      remote.listeners.get("connecting")?.();
      // Mimic Chrome clobbering local playback when the picker fails.
      audio.currentTime = 0;
      audio.paused = true;
      remote.state = "disconnected";
      remote.listeners.get("disconnect")?.();
      throw new DOMException("No cast devices available", "NotFoundError");
    };
    const player = createPlayer(audio);
    const hooks = { starts: 0, ends: 0 };

    attachCastControl(player, {
      onPromptStart() {
        hooks.starts += 1;
      },
      onPromptEnd() {
        hooks.ends += 1;
      },
    });

    button.click();
    await flushPrompt();

    expect(remote.state).toBe("disconnected");
    expect(audio.currentTime).toBe(42.5);
    expect(audio.paused).toBe(false);
    expect(audio.playbackRate).toBe(1.25);
    expect(audio.playCalls).toBe(1);
    expect(button.getAttribute("aria-label")).toBe("Cast");
    expect(button.disabled).toBe(false);
    expect(player.el.hasAttribute("data-cast")).toBe(false);
    expect(hooks).toEqual({ starts: 1, ends: 1 });
  });

  test("restores playback when the user cancels the Cast picker", async () => {
    const button = createButton();
    (globalThis as unknown as { document: { createElement(): typeof button } }).document = {
      createElement: () => button,
    };
    const remote = createRemote(true);
    const audio = createAudio(remote);
    remote.prompt = async () => {
      audio.currentTime = 0;
      audio.paused = true;
      throw new DOMException("The user canceled the cast picker", "AbortError");
    };
    const player = createPlayer(audio);

    attachCastControl(player);
    button.click();
    await flushPrompt();

    expect(audio.currentTime).toBe(42.5);
    expect(audio.paused).toBe(false);
    expect(remote.state).toBe("disconnected");
  });

  test("does not rewind local playback after a successful Cast connection", async () => {
    const button = createButton();
    (globalThis as unknown as { document: { createElement(): typeof button } }).document = {
      createElement: () => button,
    };
    const remote = createRemote(true);
    const audio = createAudio(remote);
    remote.prompt = async () => {
      remote.state = "connecting";
      remote.listeners.get("connecting")?.();
      // Connected remotes may report a different timeline; leave it alone.
      audio.currentTime = 1;
      audio.paused = false;
      remote.state = "connected";
      remote.listeners.get("connect")?.();
    };
    const player = createPlayer(audio);

    attachCastControl(player);
    button.click();
    await flushPrompt();

    expect(remote.state).toBe("connected");
    expect(audio.currentTime).toBe(1);
    expect(button.getAttribute("aria-label")).toBe("Stop casting");
    expect(player.el.hasAttribute("data-cast")).toBe(true);
  });

  test("ignores a second click while a Cast prompt is open", async () => {
    const button = createButton();
    (globalThis as unknown as { document: { createElement(): typeof button } }).document = {
      createElement: () => button,
    };
    let resolvePrompt!: () => void;
    let promptCalls = 0;
    const remote = createRemote(true);
    const audio = createAudio(remote);
    remote.prompt = () => {
      promptCalls += 1;
      return new Promise<void>((resolve) => {
        resolvePrompt = resolve;
      });
    };
    const player = createPlayer(audio);

    attachCastControl(player);
    button.click();
    button.click();
    expect(promptCalls).toBe(1);
    expect(button.disabled).toBe(true);

    resolvePrompt();
    await flushPrompt();
    expect(button.disabled).toBe(false);
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
    expect(client).toContain("suppressProgressSaves");
    expect(client).toContain("onPromptStart");
    expect(client).toContain("onPromptEnd");
    expect(client).toContain("restorePlayback(snapshot)");
    expect(client).toContain("window.dispatchEvent(new Event(\"resize\"))");
    expect(client).toContain("button.innerHTML");
    expect(client).toContain("svg aria-hidden=");
    expect(client).not.toContain("CAST_ICON");
    expect(client).not.toContain("/cast");
    expect(client).not.toContain("cast=");
  });
});

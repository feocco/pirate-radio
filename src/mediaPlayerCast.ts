export interface CastPlaybackSnapshot {
  currentTime: number;
  paused: boolean;
  playbackRate: number;
}

export interface CastPlayerHandle {
  audio: {
    currentTime?: number;
    paused?: boolean;
    playbackRate?: number;
    readyState?: number;
    play?: () => Promise<void> | void;
    pause?: () => void;
    addEventListener?: (name: string, handler: () => void, options?: { once?: boolean }) => void;
    remote?: {
      state?: string;
      watchAvailability(callback: (available: boolean) => void): Promise<number> | number;
      cancelWatchAvailability?(id?: number): Promise<void> | void;
      prompt(): Promise<void>;
      addEventListener(name: string, handler: () => void): void;
      removeEventListener(name: string, handler: () => void): void;
    };
    disableRemotePlayback?: boolean;
  };
  el: {
    querySelector(selector: string): { append(node: unknown): void } | null;
    toggleAttribute(name: string, force?: boolean): void;
    removeAttribute(name: string): void;
  };
  ui?: {
    hideExtraControl?(element: { addEventListener(name: string, handler: () => void): void }): void;
  };
}

export interface CastControlHooks {
  onPromptStart?: () => void;
  onPromptEnd?: () => void;
}

type CastButton = {
  type: string;
  className: string;
  hidden: boolean;
  disabled: boolean;
  innerHTML: string;
  title: string;
  setAttribute(name: string, value: string): void;
  addEventListener(name: string, handler: () => void): void;
  removeEventListener(name: string, handler: () => void): void;
  remove(): void;
};

export function attachCastControl(player: CastPlayerHandle, hooks: CastControlHooks = {}): () => void {
  const audio = player.audio;
  const extra = player.el.querySelector(".shk-controls_extra");
  const remote = audio.remote;
  if (
    !extra ||
    !remote ||
    typeof remote.watchAvailability !== "function" ||
    typeof remote.prompt !== "function"
  ) {
    return () => {};
  }
  audio.disableRemotePlayback = false;

  const documentRef = (globalThis as { document?: { createElement(tagName: string): CastButton } }).document;
  if (!documentRef) {
    return () => {};
  }
  const button = documentRef.createElement("button");
  button.type = "button";
  button.className = "shk-btn shk-btn_cast";
  button.hidden = true;
  button.disabled = false;
  button.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 16.1A5 5 0 0 1 5.9 20M2 12.05A9 9 0 0 1 9.95 20M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6"/><line x1="2" y1="20" x2="2.01" y2="20"/></svg>';
  button.title = "Cast";
  button.setAttribute("aria-label", "Cast");
  button.setAttribute("aria-pressed", "false");

  let prompting = false;

  const isRemoteSessionActive = (state: string | undefined) =>
    state === "connected" || state === "connecting";

  const snapshotPlayback = (): CastPlaybackSnapshot | undefined => {
    const currentTime = Number(audio.currentTime);
    if (!Number.isFinite(currentTime)) return undefined;
    return {
      currentTime,
      paused: Boolean(audio.paused),
      playbackRate: Number.isFinite(Number(audio.playbackRate)) ? Number(audio.playbackRate) : 1,
    };
  };

  const restorePlayback = (snapshot: CastPlaybackSnapshot) => {
    const apply = () => {
      if (Number.isFinite(audio.currentTime) && Math.abs(Number(audio.currentTime) - snapshot.currentTime) > 0.25) {
        audio.currentTime = snapshot.currentTime;
      } else if (!Number.isFinite(Number(audio.currentTime))) {
        audio.currentTime = snapshot.currentTime;
      }
      if (Number.isFinite(snapshot.playbackRate) && audio.playbackRate !== snapshot.playbackRate) {
        audio.playbackRate = snapshot.playbackRate;
      }
      if (snapshot.paused) {
        if (!audio.paused && typeof audio.pause === "function") audio.pause();
        return;
      }
      if (audio.paused && typeof audio.play === "function") {
        Promise.resolve(audio.play()).catch(() => {});
      }
    };

    apply();
    const readyState = Number(audio.readyState);
    if (!Number.isFinite(readyState) || readyState >= 1) return;
    if (typeof audio.addEventListener === "function") {
      audio.addEventListener("loadedmetadata", apply, { once: true });
    }
  };

  const syncState = () => {
    const connected = isRemoteSessionActive(remote.state);
    button.setAttribute("aria-pressed", connected ? "true" : "false");
    button.setAttribute("aria-label", connected ? "Stop casting" : "Cast");
    button.title = connected ? "Stop casting" : "Cast";
    player.el.toggleAttribute("data-cast", connected);
  };
  const onClick = () => {
    if (prompting) return;
    const snapshot = snapshotPlayback();
    prompting = true;
    button.disabled = true;
    if (typeof hooks.onPromptStart === "function") hooks.onPromptStart();
    Promise.resolve(remote.prompt())
      .catch(() => {})
      .then(() => {
        if (!isRemoteSessionActive(remote.state) && snapshot) {
          restorePlayback(snapshot);
        }
      })
      .finally(() => {
        prompting = false;
        button.disabled = false;
        syncState();
        if (typeof hooks.onPromptEnd === "function") hooks.onPromptEnd();
      });
  };
  button.addEventListener("click", onClick);
  extra.append(button);
  if (typeof player.ui?.hideExtraControl === "function") {
    player.ui.hideExtraControl(button);
  }

  let cancelWatch: (() => void) | undefined;
  try {
    const watched = remote.watchAvailability((available) => {
      button.hidden = !available;
    });
    Promise.resolve(watched)
      .then((id) => {
        cancelWatch = () => {
          if (typeof remote.cancelWatchAvailability === "function") {
            remote.cancelWatchAvailability(id);
          }
        };
      })
      .catch(() => {
        button.hidden = true;
      });
  } catch {
    button.hidden = true;
  }

  remote.addEventListener("connecting", syncState);
  remote.addEventListener("connect", syncState);
  remote.addEventListener("disconnect", syncState);
  syncState();

  return () => {
    if (cancelWatch) cancelWatch();
    button.removeEventListener("click", onClick);
    remote.removeEventListener("connecting", syncState);
    remote.removeEventListener("connect", syncState);
    remote.removeEventListener("disconnect", syncState);
    button.remove();
    player.el.removeAttribute("data-cast");
  };
}

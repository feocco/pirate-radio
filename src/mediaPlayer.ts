import type { LibraryItem } from "./library.js";
import { attachCastControl } from "./mediaPlayerCast.js";
import { ACCENT } from "./theme.js";

export interface MediaPlayerTrack {
  slug: string;
  title: string;
  sourceName: string;
  audioUrl: string;
  coverUrl?: string;
}

export function mediaPlayerTrack(item: LibraryItem): MediaPlayerTrack {
  const track: MediaPlayerTrack = {
    slug: item.slug,
    title: item.title,
    sourceName: item.sourceName || "Unknown Source",
    audioUrl: item.audioUrl,
  };
  if (typeof item.imageUrl === "string" && item.imageUrl.startsWith("/images/")) {
    track.coverUrl = item.imageUrl;
  }
  return track;
}

export function serializeMediaPlayerTrackForScript(track: MediaPlayerTrack): string {
  return JSON.stringify(track).replace(/[<>&\u2028\u2029]/g, (character) => {
    if (character === "<") return "\\u003c";
    if (character === ">") return "\\u003e";
    if (character === "&") return "\\u0026";
    if (character === "\u2028") return "\\u2028";
    return "\\u2029";
  });
}

export function renderMediaPlayerAssets(): string {
  return `<link rel="stylesheet" href="/vendor/shikwasa/style.css">
  <script src="/vendor/shikwasa/shikwasa.iife.js"></script>`;
}

export function renderMediaPlayerClient(userId?: string): string {
  const progressUserId = JSON.stringify(userId ?? "anonymous");
  return `
    const progressUserId = ${progressUserId};
    const progressTimers = new Map();
    const progressRestoreTimeoutMs = 10_000;
    const keyFor = (slug) => "pirate-radio-position:" + progressUserId + ":" + slug;

    function escapePlayerText(value) {
      return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    function trustedCoverUrl(url) {
      return typeof url === "string" && url.startsWith("/images/") ? url : undefined;
    }

    function mediaPlayerTrack(item) {
      const track = {
        slug: item.slug,
        title: item.title,
        sourceName: item.sourceName || "Unknown Source",
        audioUrl: item.audioUrl,
      };
      const coverUrl = trustedCoverUrl(item.imageUrl);
      if (coverUrl) track.coverUrl = coverUrl;
      return track;
    }

    function applySavedProgress(audio, value) {
      const saved = Number(value || 0);
      if (Number.isFinite(saved) && saved > 0 && saved < audio.duration) {
        audio.currentTime = saved;
        return true;
      }
      return false;
    }

    function readSavedProgress(slug) {
      return fetch("/progress/" + encodeURIComponent(slug), {
        cache: "no-store",
        signal: AbortSignal.timeout(progressRestoreTimeoutMs),
      })
        .then((response) => (response.ok ? response.json() : undefined))
        .then((progress) => progress?.positionSeconds, () => undefined);
    }

    let suppressProgressSaves = false;

    function saveProgress(slug, audio, immediate = false, ended = false) {
      if (suppressProgressSaves) return;
      if (!audio || !Number.isFinite(audio.currentTime)) return;
      localStorage.setItem(keyFor(slug), String(audio.currentTime));
      clearTimeout(progressTimers.get(slug));
      const write = () => {
        fetch("/progress/" + encodeURIComponent(slug), {
          method: "PUT",
          headers: { "content-type": "application/json" },
          keepalive: immediate,
          body: JSON.stringify({
            positionSeconds: audio.currentTime,
            durationSeconds: Number.isFinite(audio.duration) ? audio.duration : undefined,
            ended,
          }),
        }).catch(() => {});
      };
      if (immediate) {
        write();
      } else {
        progressTimers.set(slug, setTimeout(write, 2500));
      }
    }

    function mountMediaPlayer(container, track, mode) {
      if (mode !== "library" && mode !== "article") {
        throw new Error("Unsupported media player mode");
      }
      const { Player } = window.Shikwasa;
      const title = escapePlayerText(track.title);
      const artist = escapePlayerText(track.sourceName);
      const cover = trustedCoverUrl(track.coverUrl) ?? null;
      const eager = mode === "article";
      const player = new Player({
        container,
        fixed: { type: "static" },
        themeColor: ${JSON.stringify(ACCENT)},
        download: true,
        preload: eager ? "metadata" : "none",
        speedOptions: [0.75, 1, 1.25, 1.5, 1.75, 2],
        audio: {
          title,
          artist,
          cover,
          src: track.audioUrl,
        },
      });
      const audio = player.audio;
      audio.disableRemotePlayback = false;
      ${attachCastControl.toString()}
      const detachCast = attachCastControl(player, {
        onPromptStart() { suppressProgressSaves = true; },
        onPromptEnd() { suppressProgressSaves = false; },
      });
      let state = "idle";
      const listeners = [];
      const listen = (target, type, handler, options) => {
        target.addEventListener(type, handler, options);
        listeners.push(() => target.removeEventListener(type, handler, options));
      };
      const next = (type) => new Promise((resolve) => listen(audio, type, resolve, { once: true }));
      const save = (immediate = false, ended = false) => {
        if (state === "listening") saveProgress(track.slug, audio, immediate, ended);
      };
      async function restore() {
        state = "restoring";
        const saved = readSavedProgress(track.slug);
        if (audio.readyState < 1) await next("loadedmetadata");
        const position = await saved;
        if (state !== "restoring") return;
        if (applySavedProgress(audio, position) || applySavedProgress(audio, localStorage.getItem(keyFor(track.slug)))) await next("seeked");
        if (state === "restoring") state = audio.paused ? "ready" : "listening";
      }
      listen(audio, "play", () => {
        if (state === "idle") {
          const muted = audio.muted;
          audio.muted = true;
          Promise.race([restore(), new Promise((resolve) => setTimeout(resolve, 3000))]).finally(() => { audio.muted = muted; });
        } else if (state === "ready") {
          state = "listening";
        }
        if (typeof player.initMediaSession === "function") player.initMediaSession();
      });
      listen(audio, "seeked", () => {
        if (state === "ready") state = "listening";
        save(true);
      });
      listen(audio, "timeupdate", () => save());
      listen(audio, "pause", () => save(true));
      listen(audio, "ended", () => save(true, true));
      listen(window, "pagehide", () => save(true));
      if (eager) restore();
      requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
      function destroy() {
        save(true);
        state = "closed";
        clearTimeout(progressTimers.get(track.slug));
        progressTimers.delete(track.slug);
        // Shikwasa's teardown fires pause and timeupdate at 0, so listeners come off first.
        for (const remove of listeners) remove();
        player.destroy();
        detachCast();
      }
      return { player, audio, destroy };
    }
`;
}

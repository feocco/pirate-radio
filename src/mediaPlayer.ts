import type { LibraryItem } from "./library.js";

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

    async function restoreProgress(slug, audio) {
      try {
        const response = await fetch("/progress/" + encodeURIComponent(slug), { cache: "no-store" });
        if (response.ok) {
          const progress = await response.json();
          if (applySavedProgress(audio, progress.positionSeconds)) return;
        }
      } catch {}
      applySavedProgress(audio, localStorage.getItem(keyFor(slug)));
    }

    function saveProgress(slug, audio, immediate = false, ended = false) {
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

    function mountMediaPlayer(container, track) {
      const { Player } = window.Shikwasa;
      const title = escapePlayerText(track.title);
      const artist = escapePlayerText(track.sourceName);
      const cover = trustedCoverUrl(track.coverUrl) ?? null;
      const player = new Player({
        container,
        fixed: { type: "static" },
        themeColor: "#58ad5c",
        download: true,
        preload: "metadata",
        speedOptions: [0.75, 1, 1.25, 1.5, 1.75, 2],
        audio: {
          title,
          artist,
          cover,
          src: track.audioUrl,
        },
      });
      const audio = player.audio;
      const onPageHide = () => saveProgress(track.slug, audio, true);
      const onPlay = () => {
        if (typeof player.initMediaSession === "function") player.initMediaSession();
      };
      const onSeeked = () => saveProgress(track.slug, audio, true);
      audio.addEventListener("loadedmetadata", () => restoreProgress(track.slug, audio));
      audio.addEventListener("timeupdate", () => saveProgress(track.slug, audio));
      audio.addEventListener("pause", () => saveProgress(track.slug, audio, true));
      audio.addEventListener("ended", () => saveProgress(track.slug, audio, true, true));
      audio.addEventListener("seeked", onSeeked);
      audio.addEventListener("play", onPlay);
      window.addEventListener("pagehide", onPageHide);
      function destroy() {
        saveProgress(track.slug, audio, true);
        window.removeEventListener("pagehide", onPageHide);
        audio.removeEventListener("play", onPlay);
        audio.removeEventListener("seeked", onSeeked);
        clearTimeout(progressTimers.get(track.slug));
        progressTimers.delete(track.slug);
        player.destroy();
      }
      return { player, audio, destroy };
    }
`;
}

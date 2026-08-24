import type { LibraryItem } from "./library.js";
import type { ApplicationUser } from "./identity.js";
import {
  mediaPlayerTrack,
  renderMediaPlayerAssets,
  renderMediaPlayerClient,
  serializeMediaPlayerTrackForScript,
} from "./mediaPlayer.js";
import { ACCENT, ACCENT_DARK } from "./theme.js";
import type { Story, StoryContentBlock } from "./types.js";

const sharedCss = `
  :root {
    color-scheme: light dark;

    --paper: #f3f1ea;
    --paper-raised: #fbfaf6;
    --paper-sunken: #e8e4d9;
    --ink: #16150f;
    --ink-muted: #5c584c;
    --ink-faint: #8b8677;
    --rule: #16150f;
    --rule-soft: #cfcabb;
    --accent: ${ACCENT};
    --on-accent: #fff8f4;
    --danger: #9d1111;
    --on-danger: #fff5f5;

    --text-xs: 12px;
    --text-sm: 14px;
    --text-md: 16px;
    --text-lg: 18px;
    --text-xl: clamp(20px, 1.7vw, 23px);
    --text-2xl: clamp(25px, 2.6vw, 33px);
    --text-3xl: clamp(32px, 4.4vw, 50px);
    --text-4xl: clamp(36px, 5.4vw, 62px);

    --space-1: 6px;
    --space-2: 10px;
    --space-3: 16px;
    --space-4: 24px;
    --space-5: 36px;
    --space-6: 56px;

    --sans: "Helvetica Neue", Arial, Helvetica, sans-serif;
    --serif: Georgia, "Iowan Old Style", "Times New Roman", serif;

    font-family: var(--sans);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --paper: #14130e;
      --paper-raised: #1e1c15;
      --paper-sunken: #0d0c09;
      --ink: #efece2;
      --ink-muted: #a49e8e;
      --ink-faint: #7c7768;
      --rule: #d9d5c8;
      --rule-soft: #3b382e;
      --accent: ${ACCENT_DARK};
      --on-accent: #1a0c05;
      --danger: #e26060;
      --on-danger: #200606;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; color: var(--ink); background: var(--paper); line-height: 1.45; -webkit-font-smoothing: antialiased; }
  a { color: inherit; }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  .masthead { border-bottom: 2px solid var(--rule); background: var(--paper); }
  .masthead-inner { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); padding: var(--space-3) 0; }
  .brandlink { display: flex; align-items: center; gap: var(--space-2); text-decoration: none; }
  .mark { display: grid; place-items: center; min-width: 40px; height: 34px; padding: 0 7px; background: var(--accent); color: var(--on-accent); font-size: 19px; font-weight: 800; letter-spacing: -.03em; }
  .wordmark { font-size: var(--text-lg); font-weight: 700; letter-spacing: -.01em; }
  .chrome-note { color: var(--ink-muted); font-size: var(--text-sm); font-weight: 600; }

  .account-menu { position: relative; }
  .account-menu summary { display: flex; align-items: center; gap: var(--space-1); list-style: none; padding: 5px 10px 5px 6px; border: 1px solid var(--rule-soft); border-radius: 999px; background: var(--paper-raised); cursor: pointer; font-weight: 600; font-size: var(--text-sm); }
  .account-menu summary::-webkit-details-marker { display: none; }
  .account-menu summary:hover { border-color: var(--rule); }
  .account-avatar { display: grid; place-items: center; width: 26px; height: 26px; border-radius: 50%; background: var(--ink); color: var(--paper); font-size: var(--text-xs); font-weight: 700; }
  .account-chevron { width: 7px; height: 7px; margin: -3px 2px 0 2px; border-right: 2px solid currentColor; border-bottom: 2px solid currentColor; transform: rotate(45deg); transition: transform .15s ease; }
  .account-menu[open] .account-chevron { margin-top: 3px; transform: rotate(225deg); }
  .account-popover { position: absolute; z-index: 10; top: calc(100% + 8px); right: 0; min-width: 190px; padding: 5px; border: 1px solid var(--rule); background: var(--paper-raised); box-shadow: 3px 3px 0 rgba(0, 0, 0, .16); }
  .account-action { display: block; width: 100%; padding: 9px 11px; border: 0; background: transparent; color: var(--ink); text-align: left; text-decoration: none; font: inherit; font-size: var(--text-sm); font-weight: 600; cursor: pointer; }
  .account-action:hover { background: var(--paper-sunken); }
  .account-logout { margin: 0; }

  .topbar { border-bottom: 1px solid var(--rule-soft); background: var(--paper); }
  .topbar-inner { display: flex; gap: var(--space-4); }
  .navlink { display: block; padding: 11px 0; border-bottom: 2px solid transparent; margin-bottom: -1px; color: var(--ink-muted); font-size: var(--text-sm); font-weight: 700; letter-spacing: .02em; text-decoration: none; }
  .navlink:hover { color: var(--ink); }
  .navlink.active { color: var(--ink); border-bottom-color: var(--accent); }

  .wrap { width: min(1180px, calc(100% - 32px)); max-width: 100%; margin: 0 auto; }
  .hero { padding: var(--space-6) 0 var(--space-4); }
  .kicker { font-weight: 700; text-transform: uppercase; font-size: var(--text-xs); letter-spacing: .12em; color: var(--ink-muted); margin-bottom: var(--space-2); }
  h1, h2, h3 { margin: 0; letter-spacing: -.02em; line-height: 1.08; }
  h1 { font-size: var(--text-4xl); font-weight: 800; letter-spacing: -.03em; max-width: 20ch; }
  .deck { max-width: 62ch; margin-top: var(--space-3); font-size: var(--text-xl); line-height: 1.4; color: var(--ink-muted); }

  .library { display: grid; gap: 0; margin: var(--space-4) auto var(--space-6); border-top: 2px solid var(--rule); }
  .item { display: grid; grid-template-columns: minmax(0, 260px) 1fr; gap: var(--space-4); padding: var(--space-4) 0; border-bottom: 1px solid var(--rule-soft); }
  .thumb { width: 100%; aspect-ratio: 16 / 10; object-fit: cover; background: var(--paper-sunken); border: 1px solid var(--rule-soft); display: block; }
  .thumb.placeholder { display: grid; place-items: center; color: var(--ink-faint); font-weight: 800; font-size: 28px; letter-spacing: .04em; }
  .item h2 { font-size: var(--text-2xl); font-weight: 800; }
  .item h2 a { text-decoration: none; }
  .item h2 a:hover { color: var(--accent); }
  .meta { color: var(--ink-muted); font-size: var(--text-sm); font-weight: 600; margin: var(--space-1) 0 var(--space-2); }
  .tagline { font-size: var(--text-md); line-height: 1.5; color: var(--ink-muted); max-width: 62ch; margin: 0 0 var(--space-3); }

  .media-player { margin-top: 14px; width: 100%; max-width: 100%; min-width: 0; }
  .media-player .shk { width: 100%; max-width: 100%; min-width: 0; box-sizing: border-box; }
  .media-player .shk-player, .media-player .shk-body { max-width: 100%; min-width: 0; }
  .media-player .shk-text { min-width: 0; }
  .media-player .shk-controls { max-width: 100%; }
  .item, .item > *, .player-panel { min-width: 0; max-width: 100%; }
  /* A library row already carries the cover, source and title, so the compact
     variant drops the player's copies of them and keeps only the transport.
     Shikwasa fixes .shk-player's height and centres .shk-controls with an auto
     margin, both of which have to be released for the strip to collapse. */
  .media-player.compact .shk-cover,
  .media-player.compact .shk-text { display: none; }
  .media-player.compact .shk { border: 0; background: transparent; }
  .media-player.compact .shk-player { height: auto; padding: 12px 0 0; background: transparent; box-shadow: none; }
  .media-player.compact .shk-body { height: auto; }
  .media-player.compact .shk-main { max-width: none; padding: 0; align-items: center; }
  .media-player.compact .shk-controls { margin: 0; width: auto; }
  .media-player.compact .shk-display { right: 0; }
  .item-controls { display: flex; align-items: center; gap: var(--space-4); min-width: 0; margin-top: var(--space-3); }
  .item-controls .actions { flex: 0 0 auto; margin-top: 0; }
  .item-controls .media-player { flex: 1 1 auto; min-width: 0; margin-top: 0; }
  /* Shikwasa writes the accent to an inline --color-primary, so the override
     has to win on specificity for the dark-scheme accent to apply. */
  .media-player .shk {
    --color-primary: var(--accent) !important;
    --background-body: var(--paper-raised);
    --color-title: var(--ink);
    --color-artist: var(--ink-muted);
    --color-text: var(--ink);
    --color-time: var(--ink-muted);
    --color-button: var(--ink);
    --color-bar-loaded: var(--rule-soft);
    --shadow-body: none;
    border: 1px solid var(--rule-soft);
  }

  .actions { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; margin-top: var(--space-3); }
  .readlink, .button { display: inline-block; background: var(--ink); color: var(--paper); text-decoration: none; padding: 8px 14px; font: inherit; font-size: var(--text-sm); font-weight: 700; border: 1px solid var(--ink); cursor: pointer; transition: background .12s ease, color .12s ease, border-color .12s ease; }
  .readlink:hover, .button:hover:not(:disabled) { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
  .secondary { background: transparent; color: var(--ink); border-color: var(--rule-soft); }
  .secondary:hover { background: var(--ink); border-color: var(--ink); color: var(--paper); }
  .danger-form { display: inline-block; margin: 0; }
  .danger-button { background: transparent; color: var(--danger); border-color: var(--danger); }
  .danger-button:hover:not(:disabled) { background: var(--danger); border-color: var(--danger); color: var(--on-danger); }
  .button:disabled { background: transparent; color: var(--ink-faint); border-color: var(--rule-soft); cursor: default; }
  .badge { display: inline-block; padding: 8px 14px; border: 1px dashed var(--rule-soft); color: var(--ink-muted); font-size: var(--text-sm); font-weight: 700; }

  .toolbar { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); flex-wrap: wrap; margin: var(--space-4) auto 0; }
  .search, .select, .textarea { padding: 9px 11px; border: 1px solid var(--rule-soft); background: var(--paper-raised); color: var(--ink); font: inherit; font-size: var(--text-sm); }
  .search:hover, .select:hover, .textarea:hover { border-color: var(--rule); }
  .search { min-width: min(100%, 320px); }
  .select { min-width: 190px; font-weight: 600; }
  .toggle { display: flex; align-items: center; gap: var(--space-1); font-size: var(--text-sm); font-weight: 600; }
  .pager { display: flex; align-items: center; justify-content: center; gap: var(--space-2); margin: var(--space-4) 0 var(--space-6); font-size: var(--text-sm); color: var(--ink-muted); }

  .url-queue { display: grid; grid-template-columns: 1fr auto; gap: var(--space-2); margin: var(--space-4) auto 0; padding-bottom: var(--space-3); }
  .url-queue .search { width: 100%; min-width: 0; }
  .text-queue { display: grid; grid-template-columns: minmax(180px, 280px) 1fr auto; align-items: start; gap: var(--space-2); margin: 0 auto; padding-bottom: var(--space-4); border-bottom: 1px solid var(--rule-soft); }
  .text-queue .search { width: 100%; min-width: 0; }
  .textarea { min-height: 150px; resize: vertical; }
  .status { grid-column: 1 / -1; min-height: 18px; color: var(--ink-muted); font-size: var(--text-sm); font-weight: 600; }
  .status.error { color: var(--danger); }
  .queue-summary { color: var(--ink-muted); font-size: var(--text-sm); font-weight: 600; }
  .queue-list { display: grid; gap: 0; margin: var(--space-4) auto var(--space-5); border-top: 2px solid var(--rule); }
  .queue-row { display: grid; grid-template-columns: 1fr auto; gap: var(--space-3); padding: var(--space-3) 0; border-bottom: 1px solid var(--rule-soft); align-items: center; }
  .queue-row h2 { font-size: var(--text-xl); font-weight: 700; }
  .queue-row .meta { margin: var(--space-1) 0 0; }
  .queue-row .tagline { margin: var(--space-1) 0 0; font-size: var(--text-sm); }
  .queue-row .actions { justify-content: flex-end; margin-top: 0; min-width: 190px; }

  .article-shell { width: min(1040px, calc(100% - 32px)); max-width: 100%; margin: 0 auto; padding-bottom: var(--space-6); }
  .article-hero { padding: var(--space-6) 0 var(--space-4); text-align: center; }
  .article-hero h1 { margin: 0 auto; max-width: 18ch; }
  .article-hero .deck { margin-left: auto; margin-right: auto; }
  .article-meta { display: flex; justify-content: space-between; gap: var(--space-3); padding: var(--space-2) 0; color: var(--ink-muted); font-size: var(--text-sm); font-weight: 600; }
  .article-meta:first-of-type { border-top: 1px solid var(--rule); padding-top: var(--space-3); }
  .article-meta:last-of-type { border-bottom: 1px solid var(--rule-soft); padding-bottom: var(--space-3); margin-bottom: var(--space-4); }
  .hero-image { width: 100%; max-height: 480px; object-fit: cover; border: 1px solid var(--rule-soft); display: block; }
  .player-panel { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; background: var(--paper); padding: var(--space-3) 0; border-bottom: 1px solid var(--rule-soft); margin-top: var(--space-4); }
  .player-panel .media-player { margin-top: 0; flex: 1 1 100%; }

  .body { max-width: 68ch; margin: var(--space-5) auto 0; font-family: var(--serif); }
  .body p, .body blockquote, .body li { font-size: var(--text-lg); line-height: 1.65; margin: 0 0 var(--space-4); }
  .body h2 { font-family: var(--sans); font-size: var(--text-2xl); margin: var(--space-6) 0 var(--space-3); font-weight: 800; }
  .body blockquote { border-left: 3px solid var(--accent); padding-left: var(--space-3); margin-left: 0; color: var(--ink-muted); font-style: italic; }
  .body ul { margin: 0 0 var(--space-4); padding-left: var(--space-4); }
  .word.current { background: var(--accent); color: var(--on-accent); }

  .empty { padding: var(--space-5) 0; color: var(--ink-muted); font-size: var(--text-lg); }
  .admin-grid { display: grid; gap: 0; margin: var(--space-4) auto var(--space-6); border-top: 2px solid var(--rule); }
  .admin-row { display: grid; grid-template-columns: 190px 1fr; gap: var(--space-3); padding: var(--space-3) 0; border-bottom: 1px solid var(--rule-soft); align-items: center; }
  .admin-label { font-size: var(--text-sm); font-weight: 700; text-transform: uppercase; letter-spacing: .08em; color: var(--ink-muted); }
  .admin-value { font-weight: 600; }

  @media (max-width: 760px) {
    .topbar-inner { gap: var(--space-3); }
    .item { grid-template-columns: 1fr; }
    .item-controls { display: block; }
    .item-controls .media-player { margin-top: var(--space-2); }
    .toolbar { align-items: stretch; }
    .select, .search { width: 100%; }
    .url-queue, .text-queue { grid-template-columns: 1fr; }
    .queue-row { grid-template-columns: 1fr; }
    .queue-row .actions { justify-content: flex-start; min-width: 0; }
    .article-meta, .admin-row { display: block; }
    .article-meta div + div { margin-top: var(--space-1); }
    .admin-row { grid-template-columns: 1fr; }
  }
  @media (prefers-reduced-motion: reduce) {
    * { transition: none !important; }
  }
`;

export function renderReaderHtml(user?: ApplicationUser, identitySettingsUrl?: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Pirate Radio</title>
  ${renderMediaPlayerAssets()}
  <style>${sharedCss}</style>
</head>
<body>
  ${renderChrome("library", user, identitySettingsUrl)}
  <section class="toolbar wrap" aria-label="Library controls">
    <select id="source-filter" class="select" aria-label="Filter by source">
      <option value="">All sources</option>
    </select>
    <select id="sort-order" class="select" aria-label="Sort library">
      <option value="generated-desc">Newest conversion</option>
      <option value="published-desc">Article date</option>
      <option value="title-asc">Title</option>
    </select>
  </section>
  <main id="library" class="library wrap">Loading...</main>
  <script>
    const root = document.getElementById("library");
    const sourceFilter = document.getElementById("source-filter");
    const sortOrder = document.getElementById("sort-order");
    let libraryItems = [];
    let libraryPlayers = [];

    function text(value) {
      return value == null ? "" : String(value);
    }

    ${renderMediaPlayerClient(user?.id)}
    function timestamp(value) {
      const parsed = Date.parse(value || "");
      return Number.isFinite(parsed) ? parsed : 0;
    }

    function sourceName(item) {
      return text(item.sourceName || "Unknown Source");
    }

    function sourceInitials(item) {
      const words = sourceName(item).split(/\\s+/).filter(Boolean);
      const initials = words.length > 1 ? words[0][0] + words[1][0] : sourceName(item).slice(0, 2);
      return initials.toUpperCase();
    }

    function populateSourceFilter(items) {
      const selected = sourceFilter.value;
      const sources = Array.from(new Set(items.map(sourceName))).sort((left, right) => left.localeCompare(right));
      sourceFilter.textContent = "";
      const all = document.createElement("option");
      all.value = "";
      all.textContent = "All sources";
      sourceFilter.append(all);
      for (const source of sources) {
        const option = document.createElement("option");
        option.value = source;
        option.textContent = source;
        sourceFilter.append(option);
      }
      sourceFilter.value = sources.includes(selected) ? selected : "";
    }

    function filterLibraryItems(items) {
      const selectedSource = sourceFilter.value;
      return selectedSource ? items.filter((item) => sourceName(item) === selectedSource) : items;
    }

    function sortLibraryItems(items) {
      const sorted = [...items];
      if (sortOrder.value === "published-desc") {
        sorted.sort((left, right) => timestamp(right.publishedAt) - timestamp(left.publishedAt));
      } else if (sortOrder.value === "title-asc") {
        sorted.sort((left, right) => text(left.title).localeCompare(text(right.title)));
      } else {
        sorted.sort((left, right) => timestamp(right.generatedAt) - timestamp(left.generatedAt));
      }
      return sorted;
    }

    function destroyLibraryPlayers() {
      for (const mounted of libraryPlayers) {
        mounted.destroy();
      }
      libraryPlayers = [];
    }

    function renderLibrary() {
      destroyLibraryPlayers();
      root.textContent = "";
      const visibleItems = sortLibraryItems(filterLibraryItems(libraryItems));
      if (visibleItems.length === 0) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = libraryItems.length === 0 ? "No audio yet." : "No audio for this source yet.";
        root.append(empty);
        return;
      }
      for (const item of visibleItems) {
        renderLibraryItem(item);
      }
    }

    function renderLibraryItem(item) {
      const section = document.createElement("section");
      section.className = "item";

      let image;
      if (item.imageUrl) {
        image = document.createElement("img");
        image.className = "thumb";
        image.src = item.imageUrl;
        image.alt = "";
        image.loading = "lazy";
      } else {
        image = document.createElement("div");
        image.className = "thumb placeholder";
        image.textContent = sourceInitials(item);
      }

      const content = document.createElement("div");
      const heading = document.createElement("h2");
      const headingLink = document.createElement("a");
      headingLink.href = "/article/" + encodeURIComponent(item.slug);
      headingLink.textContent = item.title;
      heading.append(headingLink);
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = [sourceName(item), item.author ? "By " + item.author : "", item.publishedAt, item.wordCount ? item.wordCount + " words" : ""].filter(Boolean).join(" - ");
      const tagline = document.createElement("p");
      tagline.className = "tagline";
      tagline.textContent = text(item.tagline);
      const actions = document.createElement("div");
      actions.className = "actions";
      const readLink = document.createElement("a");
      readLink.className = "readlink";
      readLink.href = "/article/" + encodeURIComponent(item.slug);
      readLink.textContent = "Read";
      const downloadLink = document.createElement("a");
      downloadLink.className = "readlink secondary";
      downloadLink.href = item.audioUrl;
      downloadLink.download = item.slug + ".mp3";
      downloadLink.textContent = "Download MP3";
      const playerHost = document.createElement("div");
      playerHost.className = "media-player compact";
      libraryPlayers.push(mountMediaPlayer(playerHost, mediaPlayerTrack(item)));
      const controls = document.createElement("div");
      controls.className = "item-controls";
      actions.append(readLink, downloadLink);
      controls.append(actions, playerHost);
      content.append(heading, meta);
      if (item.tagline) content.append(tagline);
      content.append(controls);
      section.append(image, content);
      root.append(section);
    }

    async function loadLibrary() {
      const response = await fetch("/library.json", { cache: "no-store" });
      if (!response.ok) throw new Error("Could not load library");
      const manifest = await response.json();
      libraryItems = Array.isArray(manifest.items) ? manifest.items : [];
      populateSourceFilter(libraryItems);
      renderLibrary();
    }

    sourceFilter.addEventListener("change", renderLibrary);
    sortOrder.addEventListener("change", renderLibrary);
    loadLibrary().catch((error) => {
      root.textContent = error.message;
    });
  </script>
</body>
</html>`;
}

export function renderBacklogHtml(user?: ApplicationUser, identitySettingsUrl?: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Queue - Pirate Radio</title>
  <style>${sharedCss}</style>
</head>
<body>
  ${renderChrome("backlog", user, identitySettingsUrl)}
  <section class="hero wrap">
    <div class="kicker">Audio queue</div>
    <h1>Queue</h1>
    <p class="deck">Recent monitored articles, pasted URLs, and custom text that can be queued for audio generation.</p>
  </section>
  <form id="url-queue" class="url-queue wrap">
    <input id="article-url" class="search" type="url" placeholder="Paste an article URL (Pirate Wires, Substack, or X)." aria-label="Paste article URL">
    <button id="queue-url" class="button" type="submit">Convert URL</button>
    <div id="url-status" class="status" role="status"></div>
  </form>
  <form id="text-queue" class="text-queue wrap">
    <input id="custom-title" class="search" type="text" maxlength="160" placeholder="Custom text title" aria-label="Custom text title">
    <textarea id="custom-text" class="textarea" maxlength="60000" placeholder="Paste text to convert" aria-label="Paste text to convert"></textarea>
    <button id="queue-text" class="button" type="submit">Convert Text</button>
    <div id="text-status" class="status" role="status"></div>
  </form>
  <section class="toolbar wrap">
    <input id="search" class="search" type="search" placeholder="Search title, author, source, or description" aria-label="Search queue">
    <label class="toggle"><input id="show-all" type="checkbox"> All recent</label>
    <div id="summary" class="queue-summary"></div>
  </section>
  <main id="queue" class="queue-list wrap">Loading...</main>
  <nav class="pager wrap" aria-label="Queue pages">
    <button id="prev" class="button" type="button">Previous</button>
    <span id="page"></span>
    <button id="next" class="button" type="button">Next</button>
  </nav>
  <section class="hero wrap">
    <div class="kicker">Recent activity</div>
    <h2>Submissions</h2>
  </section>
  <main id="submissions" class="queue-list wrap">Loading...</main>
  <script>
    const pageSize = 10;
    const root = document.getElementById("queue");
    const search = document.getElementById("search");
    const showAll = document.getElementById("show-all");
    const summary = document.getElementById("summary");
    const prev = document.getElementById("prev");
    const next = document.getElementById("next");
    const pageLabel = document.getElementById("page");
    const urlForm = document.getElementById("url-queue");
    const articleUrl = document.getElementById("article-url");
    const queueUrlButton = document.getElementById("queue-url");
    const urlStatus = document.getElementById("url-status");
    const textForm = document.getElementById("text-queue");
    const customTitle = document.getElementById("custom-title");
    const customText = document.getElementById("custom-text");
    const queueTextButton = document.getElementById("queue-text");
    const textStatus = document.getElementById("text-status");
    const submissionsRoot = document.getElementById("submissions");
    let items = [];
    let pageIndex = 0;
    let pollTimer;

    function normalize(value) {
      return String(value || "").toLowerCase();
    }

    function filteredItems() {
      const query = normalize(search.value);
      return items
        .filter((item) => showAll.checked || !item.converted)
        .filter((item) => !query || [item.title, item.author, item.sourceName, item.description].some((value) => normalize(value).includes(query)));
    }

    function render() {
      const visible = filteredItems();
      const totalPages = Math.max(1, Math.ceil(visible.length / pageSize));
      pageIndex = Math.min(pageIndex, totalPages - 1);
      const pageItems = visible.slice(pageIndex * pageSize, pageIndex * pageSize + pageSize);
      root.textContent = "";
      summary.textContent = visible.length + " article" + (visible.length === 1 ? "" : "s");
      pageLabel.textContent = "Page " + (pageIndex + 1) + " of " + totalPages;
      prev.disabled = pageIndex === 0;
      next.disabled = pageIndex >= totalPages - 1;
      if (pageItems.length === 0) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = showAll.checked ? "No recent articles found." : "No unconverted recent articles.";
        root.append(empty);
        return;
      }
      for (const item of pageItems) {
        const section = document.createElement("section");
        section.className = "queue-row";
        const content = document.createElement("div");
        const heading = document.createElement("h2");
        heading.textContent = item.title;
        const meta = document.createElement("div");
        meta.className = "meta";
        meta.textContent = [item.sourceName, item.publishedAt, item.author].filter(Boolean).join(" - ");
        const description = document.createElement("p");
        description.className = "tagline";
        description.textContent = item.description || "";
        const actions = document.createElement("div");
        actions.className = "actions";
        const source = document.createElement("a");
        source.className = "readlink secondary";
        source.href = item.url;
        source.textContent = "Source";
        if (item.converted) {
          const badge = document.createElement("span");
          badge.className = "badge";
          badge.textContent = "Converted";
          actions.append(badge);
        } else {
          const button = document.createElement("button");
          button.className = "button";
          button.type = "button";
          button.textContent = item.processing ? "Processing" : "Convert";
          button.disabled = item.processing;
          button.addEventListener("click", () => convertItem(item.slug, button));
          actions.append(button);
        }
        actions.append(source);
        content.append(heading, meta);
        if (item.description) content.append(description);
        section.append(content, actions);
        root.append(section);
      }
    }

    async function loadBacklog() {
      const response = await fetch("/queue.json", { cache: "no-store" });
      if (!response.ok) throw new Error("Could not load queue");
      const payload = await response.json();
      items = Array.isArray(payload.items) ? payload.items : [];
      render();
      schedulePolling();
    }

    async function loadSubmissions() {
      const response = await fetch("/submissions.json", { cache: "no-store" });
      if (!response.ok) throw new Error("Could not load submissions");
      const payload = await response.json();
      submissionsRoot.textContent = "";
      for (const item of (Array.isArray(payload.items) ? payload.items : [])) {
        const row = document.createElement("section");
        row.className = "queue-row";
        const label = document.createElement("div");
        const heading = document.createElement("h2");
        heading.textContent = item.title || item.slug || item.sourceUrl || "Submission";
        const meta = document.createElement("div");
        meta.className = "meta";
        meta.textContent = [item.type, item.status, item.submittedByUsername ? "by " + item.submittedByUsername : "Added automatically", item.createdAt].join(" - ");
        label.append(heading, meta);
        row.append(label);
        submissionsRoot.append(row);
      }
      if (!submissionsRoot.children.length) submissionsRoot.textContent = "No submissions yet.";
    }

    async function convertItem(slug, button) {
      button.disabled = true;
      button.textContent = "Processing";
      const response = await fetch("/queue/convert/" + encodeURIComponent(slug), { method: "POST" });
      if (!response.ok) {
        button.disabled = false;
        button.textContent = "Convert";
        throw new Error("Could not queue article");
      }
      const item = items.find((candidate) => candidate.slug === slug);
      if (item) item.processing = true;
      render();
      schedulePolling();
    }

    async function queueUrl(event) {
      event.preventDefault();
      urlStatus.className = "status";
      urlStatus.textContent = "";
      queueUrlButton.disabled = true;
      queueUrlButton.textContent = "Queueing";
      try {
        const response = await fetch("/queue/convert-url", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: articleUrl.value }),
        });
        const payload = await response.json();
        if (!response.ok || !payload.ok) {
          throw new Error(payload.error || "Could not queue URL.");
        }
        if (payload.status === "converted") {
          urlStatus.textContent = "Already converted. Check the main reader.";
        } else if (payload.status === "processing") {
          urlStatus.textContent = "Already processing. You will get a notification when it is ready.";
        } else {
          urlStatus.textContent = "Queued. You will get a notification when audio is ready.";
        }
        articleUrl.value = "";
      } catch (error) {
        urlStatus.className = "status error";
        urlStatus.textContent = error.message;
      } finally {
        queueUrlButton.disabled = false;
        queueUrlButton.textContent = "Convert URL";
      }
    }

    async function queueText(event) {
      event.preventDefault();
      textStatus.className = "status";
      textStatus.textContent = "";
      queueTextButton.disabled = true;
      queueTextButton.textContent = "Queueing";
      try {
        const response = await fetch("/queue/convert-text", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: customTitle.value, text: customText.value }),
        });
        const payload = await response.json();
        if (!response.ok || !payload.ok) {
          throw new Error(payload.error || "Could not queue custom text.");
        }
        textStatus.textContent = "Queued. You will get a notification when audio is ready.";
        customTitle.value = "";
        customText.value = "";
      } catch (error) {
        textStatus.className = "status error";
        textStatus.textContent = error.message;
      } finally {
        queueTextButton.disabled = false;
        queueTextButton.textContent = "Convert Text";
      }
    }

    function schedulePolling() {
      clearInterval(pollTimer);
      if (items.some((item) => item.processing)) {
        pollTimer = setInterval(loadBacklog, 10000);
      }
    }

    search.addEventListener("input", () => { pageIndex = 0; render(); });
    showAll.addEventListener("change", () => { pageIndex = 0; render(); });
    prev.addEventListener("click", () => { pageIndex -= 1; render(); });
    next.addEventListener("click", () => { pageIndex += 1; render(); });
    urlForm.addEventListener("submit", queueUrl);
    textForm.addEventListener("submit", queueText);
    loadBacklog().catch((error) => {
      root.textContent = error.message;
    });
    loadSubmissions().catch((error) => { submissionsRoot.textContent = error.message; });
  </script>
</body>
</html>`;
}

export function renderArticleHtml(
  story: Story,
  item: LibraryItem,
  identity: { user?: ApplicationUser; isAdmin?: boolean; completedUsers?: ApplicationUser[]; submittedBy?: ApplicationUser; identitySettingsUrl?: string } = {},
): string {
  const blocks = story.contentBlocks?.length
    ? story.contentBlocks
    : story.text.split(/\n{2,}/).filter(Boolean).map((text) => ({ type: "paragraph", text }) as StoryContentBlock);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(story.title)} - Pirate Radio</title>
  ${renderMediaPlayerAssets()}
  <style>${sharedCss}</style>
</head>
<body>
  ${renderChrome("library", identity.user, identity.identitySettingsUrl)}
  <article class="article-shell">
    <header class="article-hero">
      <div class="kicker">${escapeHtml(item.sourceName ?? "Pirate Radio")}</div>
      <h1>${escapeHtml(story.title)}</h1>
      ${story.tagline ? `<p class="deck">${escapeHtml(story.tagline)}</p>` : ""}
    </header>
    <div class="article-meta">
      <div>${escapeHtml([item.author ? `By ${item.author}` : "", item.publishedAt || "Generated article"].filter(Boolean).join(" - "))}</div>
      <div>${item.wordCount} words</div>
    </div>
    <div class="article-meta">
      <div>${identity.submittedBy ? `Submitted by ${escapeHtml(identity.submittedBy.username)}` : "Added automatically"}</div>
      <div>${identity.completedUsers?.length ? `Finished by ${identity.completedUsers.map((candidate) => escapeHtml(candidate.username)).join(", ")}` : "No finishes yet"}</div>
    </div>
    ${story.heroImageUrl || item.imageUrl ? `<img class="hero-image" src="${escapeAttribute(story.heroImageUrl ?? item.imageUrl ?? "")}" alt="">` : ""}
    <section class="player-panel">
      <a class="readlink" href="/">Library</a>
      <a class="readlink secondary" href="${escapeAttribute(item.audioUrl)}" download="${escapeAttribute(item.slug)}.mp3">Download MP3</a>
      ${identity.isAdmin ? `<form class="danger-form" method="post" action="${escapeAttribute(`/admin/articles/${encodeURIComponent(item.slug)}/delete`)}" onsubmit="return window.confirm('Delete this article? A recoverable archive will be kept.');"><button class="button danger-button" type="submit">Delete article</button></form>` : ""}
      <div id="article-player" class="media-player"></div>
    </section>
    <section class="body" id="story-body">
      ${blocks.map(renderBlock).join("\n")}
    </section>
  </article>
  <script>
    ${renderMediaPlayerClient(identity.user?.id)}
    const { audio } = mountMediaPlayer(
      document.getElementById("article-player"),
      ${serializeMediaPlayerTrackForScript(mediaPlayerTrack(item))},
    );
    ${item.hasAlignment && item.alignmentUrl ? renderAlignmentScript(item.alignmentUrl) : ""}
  </script>
</body>
</html>`;
}

export function renderAdminHtml(user?: ApplicationUser, identitySettingsUrl?: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Admin - Pirate Radio</title>
  <style>${sharedCss}</style>
</head>
<body>
  ${renderChrome("admin", user, identitySettingsUrl)}
  <section class="hero wrap">
    <div class="kicker">Service status</div>
    <h1>Admin</h1>
    <p class="deck">Basic runtime checks for the private Pirate Radio service.</p>
  </section>
  <main class="admin-grid wrap">
    <section class="admin-row">
      <div class="admin-label">Health</div>
      <div id="health" class="admin-value">Checking...</div>
    </section>
    <section class="admin-row">
      <div class="admin-label">Library</div>
      <div><a class="readlink secondary" href="/library.json">Open JSON</a></div>
    </section>
    <section class="admin-row">
      <div class="admin-label">Queue</div>
      <div><a class="readlink secondary" href="/queue.json">Open JSON</a></div>
    </section>
  </main>
  <script>
    const health = document.getElementById("health");
    fetch("/health", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("Health check failed")))
      .then((payload) => { health.textContent = payload.ok ? "OK" : "Unexpected response"; })
      .catch((error) => { health.textContent = error.message; });
  </script>
</body>
</html>`;
}

type ActivePage = "library" | "backlog" | "admin";

function renderChrome(activePage: ActivePage, user?: ApplicationUser, identitySettingsUrl?: string): string {
  const brandClass = activePage === "library" ? "brandlink active" : "brandlink";
  const items = [
    { page: "backlog", href: "/queue", label: "Queue" },
    ...(!user || user.groups.includes("pirate-radio-admins") ? [{ page: "admin" as const, href: "/admin", label: "Admin" }] : []),
  ] as const;
  const account = user ? `<details class="account-menu" id="account-menu">
    <summary aria-label="Account menu for ${escapeAttribute(user.username)}"><span class="account-avatar" aria-hidden="true">${escapeHtml(user.username.slice(0, 1).toUpperCase())}</span><span>${escapeHtml(user.username)}</span><span class="account-chevron" aria-hidden="true"></span></summary>
    <div class="account-popover" role="menu">
      ${identitySettingsUrl ? `<a class="account-action" role="menuitem" href="${escapeAttribute(identitySettingsUrl)}">Edit profile</a>` : ""}
      <form class="account-logout" method="post" action="/auth/logout"><button class="account-action" role="menuitem" type="submit">Log out</button></form>
    </div>
  </details>` : `<span class="chrome-note">AI-generated audio</span>`;
  const accountScript = user ? `<script>
    const accountMenu = document.getElementById("account-menu");
    document.addEventListener("click", (event) => {
      if (accountMenu.open && !accountMenu.contains(event.target)) accountMenu.open = false;
    });
  </script>` : "";
  return `<header class="masthead">
    <div class="masthead-inner wrap"><a class="${brandClass}" href="/" aria-label="Pirate Radio home"><span class="mark">PR</span><span class="wordmark">Pirate Radio</span></a>${account}</div>
  </header>
  <nav class="topbar" aria-label="Primary">
    <div class="topbar-inner wrap">${items
      .map(
        (item) =>
          item.page === activePage
            ? `<a class="navlink active" href="${item.href}" aria-current="page">${item.label}</a>`
            : `<a class="navlink" href="${item.href}">${item.label}</a>`,
      )
      .join("")}</div>
  </nav>${accountScript}`;
}

function renderBlock(block: StoryContentBlock): string {
  if (block.type === "heading") {
    return `<h2>${escapeHtml(block.text)}</h2>`;
  }
  if (block.type === "quote") {
    return `<blockquote>${renderWords(block.text)}</blockquote>`;
  }
  if (block.type === "list") {
    return `<ul><li>${renderWords(block.text)}</li></ul>`;
  }
  return `<p>${renderWords(block.text)}</p>`;
}

function renderWords(text: string): string {
  return text
    .split(/(\s+)/)
    .map((part) => {
      if (/^\s+$/.test(part)) {
        return part;
      }
      return `<span class="word" data-word-index="">${escapeHtml(part)}</span>`;
    })
    .join("");
}

function renderAlignmentScript(alignmentUrl: string): string {
  return `
    let alignmentWords = [];
    fetch(${JSON.stringify(alignmentUrl)}, { cache: "no-store" })
      .then((response) => response.ok ? response.json() : undefined)
      .then((alignment) => {
        alignmentWords = Array.isArray(alignment?.words) ? alignment.words : [];
        const spans = Array.from(document.querySelectorAll(".word"));
        spans.forEach((span, index) => span.dataset.wordIndex = String(index));
      })
      .catch(() => {});
    audio.addEventListener("timeupdate", () => {
      if (!alignmentWords.length) return;
      const active = alignmentWords.findIndex((word) => audio.currentTime >= word.start && audio.currentTime <= word.end);
      document.querySelector(".word.current")?.classList.remove("current");
      if (active >= 0) {
        document.querySelector('[data-word-index="' + active + '"]')?.classList.add("current");
      }
    });`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

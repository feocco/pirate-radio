import type { LibraryItem } from "./library.js";
import type { ApplicationUser } from "./identity.js";
import {
  mediaPlayerTrack,
  renderMediaPlayerAssets,
  renderMediaPlayerClient,
  serializeMediaPlayerTrackForScript,
} from "./mediaPlayer.js";
import type { Story, StoryContentBlock } from "./types.js";

const sharedCss = `
  :root {
    color-scheme: light;
    --ink: #050505;
    --paper: #e5e5e5;
    --muted: #555;
    --line: #111;
    --accent: #58ad5c;
    font-family: Arial, Helvetica, sans-serif;
  }
  * { box-sizing: border-box; }
  body { margin: 0; color: var(--ink); background: var(--paper); line-height: 1.35; }
  a { color: inherit; }
  .brandbar { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 18px 28px; background: var(--accent); border-bottom: 1px solid var(--line); font-weight: 900; }
  .brandlink { display: flex; align-items: center; gap: 16px; font-size: 24px; text-decoration: none; }
  .mark { font-size: 42px; letter-spacing: -2px; line-height: .8; }
  .account-menu { position: relative; }
  .account-menu summary { display: flex; align-items: center; gap: 9px; list-style: none; padding: 6px 10px 6px 7px; border: 1px solid rgba(0, 0, 0, .5); border-radius: 999px; background: rgba(255, 255, 255, .28); cursor: pointer; font-weight: 900; }
  .account-menu summary::-webkit-details-marker { display: none; }
  .account-menu summary:hover, .account-menu summary:focus-visible { background: rgba(255, 255, 255, .48); outline: none; }
  .account-avatar { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 50%; background: #000; color: #fff; font-size: 14px; }
  .account-chevron { width: 8px; height: 8px; margin: -4px 2px 0 3px; border-right: 2px solid currentColor; border-bottom: 2px solid currentColor; transform: rotate(45deg); transition: transform .15s ease; }
  .account-menu[open] .account-chevron { margin-top: 4px; transform: rotate(225deg); }
  .account-popover { position: absolute; z-index: 10; top: calc(100% + 8px); right: 0; min-width: 190px; padding: 6px; border: 1px solid var(--line); background: #fff; box-shadow: 4px 4px 0 rgba(0, 0, 0, .24); }
  .account-action { display: block; width: 100%; padding: 10px 12px; border: 0; background: transparent; color: var(--ink); text-align: left; text-decoration: none; font: inherit; font-weight: 900; cursor: pointer; }
  .account-action:hover, .account-action:focus-visible { background: #e6e6e6; outline: none; }
  .account-logout { margin: 0; }
  .topbar { display: flex; border-bottom: 1px solid var(--line); background: #000; color: #fff; }
  .navlink { display: block; min-width: 180px; padding: 12px 18px; border-right: 1px solid #666; font-weight: 900; text-decoration: none; }
  .navlink.active { color: var(--accent); }
  .wrap { width: min(1180px, calc(100% - 32px)); max-width: 100%; margin: 0 auto; }
  .hero { padding: 54px 0 30px; border-bottom: 1px solid #999; }
  .kicker { font-weight: 900; text-transform: uppercase; font-size: 13px; letter-spacing: .08em; color: var(--muted); margin-bottom: 10px; }
  h1, h2, h3 { margin: 0; letter-spacing: 0; line-height: .95; }
  h1 { font-size: clamp(44px, 8vw, 92px); font-weight: 950; max-width: 980px; }
  .deck { max-width: 820px; margin-top: 18px; font-size: clamp(20px, 3vw, 30px); color: #222; }
  .library { display: grid; gap: 0; margin: 28px auto 60px; border-top: 2px solid var(--line); }
  .item { display: grid; grid-template-columns: minmax(220px, 36%) 1fr; gap: 22px; padding: 22px 0; border-bottom: 2px solid var(--line); }
  .thumb { width: 100%; aspect-ratio: 16 / 10; object-fit: cover; background: #c9c9c9; border: 1px solid var(--line); display: block; }
  .thumb.placeholder { display: grid; place-items: center; font-weight: 900; font-size: 40px; }
  .item h2 { font-size: clamp(31px, 4.8vw, 58px); font-weight: 950; }
  .meta { color: var(--muted); font-size: 14px; font-weight: 700; margin: 8px 0 12px; }
  .tagline { font-size: 18px; max-width: 820px; margin: 0 0 16px; }
  .media-player { margin-top: 14px; width: 100%; max-width: 100%; min-width: 0; }
  .media-player .shk { width: 100%; max-width: 100%; min-width: 0; box-sizing: border-box; }
  .media-player .shk-player, .media-player .shk-body { max-width: 100%; min-width: 0; }
  .media-player .shk-text { min-width: 0; }
  .media-player .shk-controls { max-width: 100%; }
  .item, .item > *, .player-panel { min-width: 0; max-width: 100%; }
  .actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 14px; }
  .readlink, .button { display: inline-block; background: #000; color: #fff; text-decoration: none; padding: 9px 13px; font-weight: 900; border: 1px solid #000; font: inherit; cursor: pointer; }
  .danger-form { display: inline-block; margin: 0; }
  .danger-button { background: #9d1111; border-color: #9d1111; }
  .button:disabled, .badge { background: transparent; color: var(--ink); cursor: default; }
  .badge { display: inline-block; padding: 9px 13px; border: 1px solid var(--line); font-weight: 900; }
  .toolbar { display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; margin: 24px auto 0; }
  .search { min-width: min(100%, 320px); padding: 11px 12px; border: 2px solid var(--line); background: #fff; font: inherit; font-weight: 700; }
  .select { min-width: 190px; padding: 11px 12px; border: 2px solid var(--line); background: #fff; font: inherit; font-weight: 900; }
  .toggle { display: flex; align-items: center; gap: 8px; font-weight: 900; }
  .pager { display: flex; align-items: center; justify-content: center; gap: 12px; margin: 22px 0 64px; }
  .url-queue { display: grid; grid-template-columns: 1fr auto; gap: 10px; margin: 24px auto 0; padding-bottom: 20px; border-bottom: 2px solid var(--line); }
  .url-queue .search { width: 100%; min-width: 0; }
  .text-queue { display: grid; grid-template-columns: minmax(180px, 280px) 1fr auto; gap: 10px; margin: 14px auto 0; padding-bottom: 20px; border-bottom: 2px solid var(--line); }
  .text-queue .search { width: 100%; min-width: 0; }
  .textarea { min-height: 180px; resize: vertical; padding: 11px 12px; border: 2px solid var(--line); background: #fff; font: inherit; font-weight: 700; }
  .status { grid-column: 1 / -1; min-height: 20px; color: var(--muted); font-weight: 900; }
  .status.error { color: #9d1111; }
  .queue-summary { color: var(--muted); font-weight: 900; }
  .queue-list { display: grid; gap: 0; margin: 22px auto 42px; border-top: 2px solid var(--line); }
  .queue-row { display: grid; grid-template-columns: 1fr auto; gap: 18px; padding: 15px 0; border-bottom: 1px solid #777; align-items: center; }
  .queue-row h2 { font-size: clamp(22px, 3vw, 34px); font-weight: 950; line-height: 1.02; }
  .queue-row .meta { margin: 5px 0 0; }
  .queue-row .tagline { margin: 7px 0 0; font-size: 16px; max-width: 860px; color: #222; }
  .queue-row .actions { justify-content: flex-end; margin-top: 0; min-width: 190px; }
  .article-shell { width: min(1040px, calc(100% - 32px)); max-width: 100%; margin: 0 auto; padding-bottom: 70px; }
  .article-hero { padding: 62px 0 26px; text-align: center; }
  .article-hero h1 { margin: 0 auto; }
  .article-hero .deck { margin-left: auto; margin-right: auto; }
  .article-meta { display: flex; justify-content: space-between; gap: 16px; padding: 20px 0; border-top: 1px solid #777; font-weight: 900; }
  .hero-image { width: 100%; max-height: 680px; object-fit: cover; border: 1px solid var(--line); display: block; }
  .player-panel { position: sticky; top: 0; z-index: 2; background: var(--paper); padding: 14px 0; border-bottom: 2px solid var(--line); }
  .body { max-width: 900px; margin: 42px auto 0; font-family: Georgia, "Times New Roman", serif; }
  .body p, .body blockquote, .body li { font-size: clamp(22px, 3vw, 36px); line-height: 1.33; margin: 0 0 30px; }
  .body h2 { font-family: Arial, Helvetica, sans-serif; font-size: clamp(40px, 6vw, 74px); margin: 58px 0 24px; font-weight: 950; }
  .body blockquote { border-left: 8px solid var(--accent); padding-left: 18px; }
  .body ul { margin: 0 0 30px; padding-left: 34px; }
  .word.current { background: var(--accent); box-shadow: 0 0 0 2px var(--accent); }
  .empty { padding: 40px 0; font-size: 22px; font-weight: 800; }
  .admin-grid { display: grid; gap: 14px; margin: 28px auto 60px; border-top: 2px solid var(--line); }
  .admin-row { display: grid; grid-template-columns: 190px 1fr; gap: 18px; padding: 18px 0; border-bottom: 1px solid #777; align-items: center; }
  .admin-label { font-weight: 950; }
  .admin-value { font-weight: 800; color: #222; }
  @media (max-width: 760px) {
    .topbar { display: grid; grid-template-columns: 1fr 1fr; }
    .navlink { min-width: 0; border-right: 0; }
    .navlink + .navlink { border-left: 1px solid #666; }
    .brandbar { padding: 14px 16px; }
    .item { grid-template-columns: 1fr; }
    .toolbar { align-items: stretch; }
    .select { width: 100%; }
    .url-queue, .text-queue { grid-template-columns: 1fr; }
    .queue-row { grid-template-columns: 1fr; }
    .queue-row .actions { justify-content: flex-start; min-width: 0; }
    .article-meta, .admin-row { display: block; }
    .article-meta div + div { margin-top: 8px; }
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
        image.textContent = "PW";
      }

      const content = document.createElement("div");
      const heading = document.createElement("h2");
      heading.textContent = item.title;
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
      downloadLink.className = "readlink";
      downloadLink.href = item.audioUrl;
      downloadLink.download = item.slug + ".mp3";
      downloadLink.textContent = "Download MP3";
      const playerHost = document.createElement("div");
      playerHost.className = "media-player";
      libraryPlayers.push(mountMediaPlayer(playerHost, mediaPlayerTrack(item)));
      actions.append(readLink, downloadLink);
      content.append(heading, meta);
      if (item.tagline) content.append(tagline);
      content.append(actions, playerHost);
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
    <input id="article-url" class="search" type="url" placeholder="Paste an article URL (Pirate Wires, Substack, X, or WSJ)." aria-label="Paste article URL">
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
        source.className = "readlink";
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
      <a class="readlink" href="${escapeAttribute(item.audioUrl)}" download="${escapeAttribute(item.slug)}.mp3">Download MP3</a>
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
      <div><a class="readlink" href="/library.json">Open JSON</a></div>
    </section>
    <section class="admin-row">
      <div class="admin-label">Queue</div>
      <div><a class="readlink" href="/queue.json">Open JSON</a></div>
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
  </details>` : "AI-generated audio";
  const accountScript = user ? `<script>
    const accountMenu = document.getElementById("account-menu");
    document.addEventListener("click", (event) => {
      if (accountMenu.open && !accountMenu.contains(event.target)) accountMenu.open = false;
    });
  </script>` : "";
  return `<div class="brandbar"><a class="${brandClass}" href="/" aria-label="Pirate Radio home"><span class="mark">PR</span><span>Pirate Radio</span></a>${account}</div>
  <nav class="topbar" aria-label="Primary">${items
    .map(
      (item) =>
        `<a class="navlink ${item.page === activePage ? "active" : ""}" href="${item.href}">${item.label}</a>`,
    )
    .join("")}</nav>${accountScript}`;
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

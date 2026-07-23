const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
  tg.setHeaderColor("#0a0a12");
  tg.setBackgroundColor("#0a0a12");
}

const initData = tg?.initData || "";

/* ============================================================
   Views + navigation (Home / Search / Genres / Requests / Profile
   are the 5 primary tabs shown in the bottom nav; the rest are
   secondary screens reached via the back arrow or the sidebar)
   ============================================================ */

const views = {
  home: document.getElementById("view-home"),
  search: document.getElementById("view-search"),
  genres: document.getElementById("view-genres"),
  genreDetail: document.getElementById("view-genre-detail"),
  requests: document.getElementById("view-requests"),
  profile: document.getElementById("view-profile"),
  topRequested: document.getElementById("view-top-requested"),
  settings: document.getElementById("view-settings"),
  about: document.getElementById("view-about"),
};

const BOTTOM_NAV_TABS = ["home", "search", "genres", "requests", "profile"];
const bottomNav = document.getElementById("bottom-nav");

function goTo(viewKey) {
  Object.values(views).forEach(v => v.classList.remove("view--active"));
  views[viewKey].classList.add("view--active");
  window.scrollTo(0, 0);
  closeSidebar();

  if (BOTTOM_NAV_TABS.includes(viewKey)) {
    bottomNav.classList.add("bottom-nav--visible");
    document.querySelectorAll(".bottom-nav-btn").forEach(b => {
      b.classList.toggle("bottom-nav-btn--active", b.dataset.tab === viewKey);
    });
  } else {
    bottomNav.classList.remove("bottom-nav--visible");
  }

  if (viewKey === "search") initSearchView();
  if (viewKey === "genres") loadGenreList();
  if (viewKey === "requests") loadMyRequests();
  if (viewKey === "topRequested") loadTopRequested();
}

// Shared entry point for bottom-nav taps, sidebar links, and back buttons —
// handles the couple of targets that need special-casing before navigating.
function requestGoTo(tab) {
  if (tab === "available") {
    goTo("home");
    setHomeTab("available");
    return;
  }
  if (tab === "profile" && !session) {
    showInfoPopup("Not signed in", "Open this from inside your Telegram bot to view your profile.", "warning");
    return;
  }
  goTo(tab);
}

document.querySelectorAll(".bottom-nav-btn").forEach(btn => {
  btn.addEventListener("click", () => requestGoTo(btn.dataset.tab));
});

document.querySelectorAll("[data-nav]").forEach(el => {
  el.addEventListener("click", () => requestGoTo(el.dataset.nav));
});

document.querySelectorAll("[data-back]").forEach(btn => {
  btn.addEventListener("click", () => requestGoTo(btn.dataset.backTo || "home"));
});

/* ---------- sidebar drawer ---------- */
const sidebarOverlay = document.getElementById("sidebar-overlay");

function openSidebar() { sidebarOverlay.classList.add("sidebar-overlay--open"); }
function closeSidebar() { sidebarOverlay.classList.remove("sidebar-overlay--open"); }

document.getElementById("btn-menu").addEventListener("click", openSidebar);
document.getElementById("sidebar-close").addEventListener("click", closeSidebar);
sidebarOverlay.addEventListener("click", closeSidebar);

/* ---------- home search bar -> dedicated Search tab ---------- */
document.getElementById("search-input").addEventListener("focus", (e) => {
  e.target.blur();
  requestGoTo("search");
});
document.getElementById("btn-topbar-search").addEventListener("click", () => requestGoTo("search"));

async function api(path, body = {}) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ initData, ...body }),
  });
  return res.json();
}

async function fetchJson(url) {
  try {
    const res = await fetch(url);
    return await res.json();
  } catch {
    return { ok: false };
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

let session = null;

function getStartParam() {
  // The startapp value this webapp itself was launched with, e.g. "anime_269"
  // from https://t.me/<bot>/anidex?startapp=anime_269 — empty string if none.
  return tg?.initDataUnsafe?.start_param || "";
}

function buildJoinDeepLink(botUsername) {
  const startParam = getStartParam();
  const payload = startParam ? `fsub_${startParam}` : "fsub";
  return `https://t.me/${botUsername}?start=${payload}`;
}

async function boot() {
  const dot = document.getElementById("status-dot");
  const notice = document.getElementById("global-notice");

  if (!initData) {
    dot.classList.add("offline");
    return true; // no Telegram session at all — can't check fsub, let browsing through as before
  }

  const data = await api("/api/auth");
  if (!data.ok) {
    dot.classList.add("offline");
    notice.textContent = "Could not verify your Telegram session. Try reopening the app.";
    return true; // fail open on a verification/network error, don't block over a hiccup
  }

  session = data;
  fillProfile(data);

  if (data.fsub_required) {
    showFsubGate(data.bot_username);
    return false;
  }

  hideFsubGate();
  return true;
}

function showFsubGate(botUsername) {
  const joinBtn = document.getElementById("fsub-gate-join");

  if (botUsername) {
    const joinUrl = buildJoinDeepLink(botUsername);
    joinBtn.href = joinUrl;
    joinBtn.onclick = (e) => {
      if (tg?.openTelegramLink) {
        e.preventDefault();
        tg.openTelegramLink(joinUrl);
      }
    };
  } else {
    joinBtn.removeAttribute("href");
    joinBtn.onclick = (e) => e.preventDefault();
  }

  document.getElementById("fsub-gate").style.display = "flex";
  document.getElementById("app").style.display = "none";
  bottomNav.style.display = "none";
}

function hideFsubGate() {
  document.getElementById("fsub-gate").style.display = "none";
  document.getElementById("app").style.display = "";
  bottomNav.style.display = "";
}

document.getElementById("fsub-gate-reload").addEventListener("click", async () => {
  const btn = document.getElementById("fsub-gate-reload");
  const original = btn.textContent;
  btn.textContent = "Checking...";
  btn.disabled = true;

  const passed = await boot();
  if (passed) {
    loadTrending();
    loadTopAiring();
    loadPopular(true);
  } else {
    btn.textContent = original;
    btn.disabled = false;
  }
});

function fillProfile(data) {
  const u = data.user;
  const fullName = [u.first_name, u.last_name].filter(Boolean).join(" ") || "—";
  const handle = u.username ? "@" + u.username : "no username";

  document.getElementById("profile-name").textContent = fullName;
  document.getElementById("profile-handle").textContent = handle;
  document.getElementById("profile-photo").src = u.photo_url || "";
  document.getElementById("profile-id").textContent = u.id;
  document.getElementById("profile-registered").textContent = data.registered ? "yes" : "no";
  document.getElementById("profile-role").textContent = data.is_admin ? "admin" : "member";
  document.getElementById("profile-banned").textContent = data.is_banned ? "banned" : "active";

  document.getElementById("sidebar-name").textContent = fullName;
  document.getElementById("sidebar-handle").textContent = handle;
  document.getElementById("sidebar-avatar").src = u.photo_url || "";

  const botLink = document.getElementById("settings-open-bot");
  if (data.bot_username) {
    botLink.href = `https://t.me/${data.bot_username}`;
    botLink.onclick = (e) => {
      if (tg?.openTelegramLink) {
        e.preventDefault();
        tg.openTelegramLink(botLink.href);
      }
    };
  }
}

/* ============================================================
   Toast notifications (used for anime state messages, replacing
   the old blocking modal popup)
   ============================================================ */

const toastContainer = document.getElementById("toast-container");
const TOAST_ICONS = { success: "✅", error: "❌", warning: "⚠️", info: "ℹ️" };

function showInfoPopup(title, text, type = "info") {
  const el = document.createElement("div");
  el.className = `toast toast--${type}`;
  el.innerHTML = `
    <div class="toast-icon">${TOAST_ICONS[type] || TOAST_ICONS.info}</div>
    <div class="toast-body">
      <div class="toast-title">${escapeHtml(title)}</div>
      <div class="toast-text">${escapeHtml(text)}</div>
    </div>
    <button class="toast-close">&#10005;</button>
  `;
  toastContainer.appendChild(el);

  const remove = () => {
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 200);
  };
  el.querySelector(".toast-close").addEventListener("click", remove);
  setTimeout(remove, 4500);
}

/* ============================================================
   Anime Station — trending, popular grid, search, details modal
   ============================================================ */

const animeCache = new Map();

function titleOf(media) {
  return media.title.english || media.title.romaji || media.title.native || "Untitled";
}

function stripHtml(str) {
  return (str || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function cacheMedia(list) {
  list.forEach(m => animeCache.set(m.id, m));
}

function animeCardHtml(media, trending) {
  const cover = media.coverImage?.large || "";
  const title = titleOf(media);
  const score = media.averageScore
    ? `<span class="anime-card-score">${(media.averageScore / 10).toFixed(1)}</span>`
    : "";
  return `
    <div class="anime-card ${trending ? "anime-card--trending" : ""}" data-anime-id="${media.id}">
      <img src="${cover}" alt="" loading="lazy" />
      <div class="anime-card-gradient"></div>
      ${score}
      <div class="anime-card-title">${escapeHtml(title)}</div>
    </div>
  `;
}

async function loadTrending() {
  const row = document.getElementById("trending-row");
  const data = await fetchJson("/api/anime/trending");
  if (!data.ok || !data.media || !data.media.length) {
    row.innerHTML = `<p class="notice notice--error">Couldn't load trending anime.</p>`;
    return;
  }
  cacheMedia(data.media);
  row.innerHTML = data.media.map((m, i) => {
    const html = animeCardHtml(m, true);
    if (i < 3) return html.replace('<div class="anime-card-gradient"></div>', '<div class="anime-card-gradient"></div><span class="anime-card-badge">HOT</span>');
    return html;
  }).join("");
}

async function loadTopAiring() {
  const row = document.getElementById("top-airing-row");
  const data = await fetchJson("/api/anime/top-airing");
  if (!data.ok || !data.media || !data.media.length) {
    row.innerHTML = `<p class="notice notice--error">Couldn't load top airing anime.</p>`;
    return;
  }
  cacheMedia(data.media);
  row.innerHTML = data.media.map(m => animeCardHtml(m, true)).join("");
}

let popularPage = 1;

async function loadPopular(reset) {
  const grid = document.getElementById("popular-grid");
  const loadMoreBtn = document.getElementById("btn-load-more");

  if (reset) {
    popularPage = 1;
    grid.innerHTML = `<div class="skel skel--grid-card"></div><div class="skel skel--grid-card"></div><div class="skel skel--grid-card"></div><div class="skel skel--grid-card"></div>`;
  }
  loadMoreBtn.disabled = true;
  loadMoreBtn.textContent = "Loading…";

  const data = await fetchJson(`/api/anime/popular?page=${popularPage}`);
  if (!data.ok || !data.media) {
    if (reset) grid.innerHTML = `<p class="notice notice--error">Couldn't load anime.</p>`;
    loadMoreBtn.style.display = "none";
    return;
  }
  cacheMedia(data.media);
  const html = data.media.map(m => animeCardHtml(m, false)).join("");
  if (reset) grid.innerHTML = html; else grid.insertAdjacentHTML("beforeend", html);

  const hasNext = Boolean(data.pageInfo && data.pageInfo.hasNextPage);
  loadMoreBtn.style.display = hasNext ? "block" : "none";
  loadMoreBtn.disabled = false;
  loadMoreBtn.textContent = "Load more";
  popularPage += 1;
}

document.getElementById("btn-load-more").addEventListener("click", () => loadPopular(false));

/* ---------- Home: All / Available segmented control ---------- */
let currentHomeTab = "all";
const homeSegBtns = document.querySelectorAll("#home-segmented .segmented-btn");
const availableSection = document.getElementById("available-section");
const browseSections = document.getElementById("browse-sections");

function showHomeTab() {
  if (currentHomeTab === "available") {
    browseSections.style.display = "none";
    availableSection.style.display = "block";
    loadAvailable();
  } else {
    availableSection.style.display = "none";
    browseSections.style.display = "block";
  }
}

function setHomeTab(tab) {
  currentHomeTab = tab;
  homeSegBtns.forEach(b => b.classList.toggle("segmented-btn--active", b.dataset.homeTab === tab));
  showHomeTab();
}

homeSegBtns.forEach(btn => btn.addEventListener("click", () => setHomeTab(btn.dataset.homeTab)));

async function loadAvailable() {
  const grid = document.getElementById("available-grid");
  const indexBar = document.getElementById("az-index-bar");
  grid.innerHTML = `<div class="anime-grid"><div class="skel skel--grid-card"></div><div class="skel skel--grid-card"></div><div class="skel skel--grid-card"></div></div>`;
  indexBar.innerHTML = "";

  const data = await fetchJson("/api/anime/available");
  if (!data.ok) {
    grid.innerHTML = `<p class="notice notice--error">Couldn't load available anime.</p>`;
    return;
  }
  if (!data.media.length) {
    grid.innerHTML = `<p class="notice">No anime available yet.</p>`;
    return;
  }
  cacheMedia(data.media);
  renderAvailableGrouped(data.media, grid, indexBar);
}

// A-Z index — "Available Anime" grouped by first letter of the title,
// with a jump bar (like a contacts list) at the top. Anything not
// starting with A-Z (numbers, symbols, non-Latin titles) falls into "#".
const AZ_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ#".split("");

function azLetterOf(media) {
  const first = titleOf(media).trim().charAt(0).toUpperCase();
  return /[A-Z]/.test(first) ? first : "#";
}

function azSectionId(letter) {
  return "az-sec-" + (letter === "#" ? "hash" : letter);
}

function availableCardHtml(media) {
  const cover = media.coverImage?.large || "";
  const title = titleOf(media);
  const score = media.averageScore
    ? `<span class="anime-card-score">${(media.averageScore / 10).toFixed(1)}</span>`
    : "";
  const deleteBtn = (session && session.is_admin)
    ? `<button class="anime-card-delete" data-delete-id="${media.id}" title="Remove from available">🗑</button>`
    : "";
  return `
    <div class="anime-card" data-anime-id="${media.id}">
      <img src="${cover}" alt="" loading="lazy" />
      <div class="anime-card-gradient"></div>
      ${score}
      ${deleteBtn}
      <div class="anime-card-title">${escapeHtml(title)}</div>
    </div>
  `;
}

function renderAvailableGrouped(mediaList, grid, indexBar) {
  const groups = {};
  mediaList.forEach(m => {
    const letter = azLetterOf(m);
    (groups[letter] = groups[letter] || []).push(m);
  });
  Object.values(groups).forEach(list => list.sort((a, b) => titleOf(a).localeCompare(titleOf(b))));

  indexBar.innerHTML = AZ_LETTERS.map(letter => {
    const has = Boolean(groups[letter] && groups[letter].length);
    return `<button class="az-chip${has ? "" : " az-chip--empty"}" data-letter="${letter}" ${has ? "" : "disabled"}>${letter}</button>`;
  }).join("");

  grid.innerHTML = AZ_LETTERS
    .filter(letter => groups[letter] && groups[letter].length)
    .map(letter => `
      <div class="az-section" id="${azSectionId(letter)}">
        <div class="az-section-header">${letter}</div>
        <div class="anime-grid">${groups[letter].map(m => availableCardHtml(m)).join("")}</div>
      </div>
    `).join("");
}

// --- Top Requested (ranked by votes, opened via the sidebar) ---
const STATUS_LABELS = {
  pending: "⏳ Pending",
  accepted: "🟢 Coming Soon",
  declined: "⚪ Not Available",
};

function topRequestedRowHtml(media, rank) {
  const cover = media.coverImage?.large || "";
  const title = titleOf(media);
  const statusLabel = STATUS_LABELS[media.request_status] || "";
  const statusClass = media.request_status || "pending";
  const rankClass = rank <= 3 ? ` top-req-row--top${rank}` : "";
  const deleteBtn = (session && session.is_admin)
    ? `<button class="anime-card-delete top-req-delete" data-delete-id="${media.id}" title="Remove this request">🗑</button>`
    : "";
  return `
    <div class="top-req-row${rankClass}" data-anime-id="${media.id}">
      <div class="top-req-rank">${rank}</div>
      <img class="top-req-cover" src="${cover}" alt="" loading="lazy" />
      <div class="top-req-info">
        <div class="top-req-title">${escapeHtml(title)}</div>
        <span class="top-req-status top-req-status--${statusClass}">${statusLabel}</span>
      </div>
      <div class="top-req-votes">🗳️ ${media.votes}</div>
      ${deleteBtn}
    </div>
  `;
}

async function loadTopRequested() {
  const list = document.getElementById("top-requested-list");
  list.innerHTML = `<div class="skel skel--row"></div><div class="skel skel--row"></div><div class="skel skel--row"></div>`;

  const data = await fetchJson("/api/anime/top-requested");
  if (!data.ok) {
    list.innerHTML = `<p class="notice notice--error">Couldn't load top requested anime.</p>`;
    return;
  }
  if (!data.media.length) {
    list.innerHTML = `<p class="notice">No requests yet — be the first to request one!</p>`;
    return;
  }
  cacheMedia(data.media);
  list.innerHTML = data.media.map((m, i) => topRequestedRowHtml(m, i + 1)).join("");
}

/* ============================================================
   My Requests (a single user's own submitted requests + status)
   ============================================================ */

function myRequestRowHtml(media) {
  const cover = media.coverImage?.large || "";
  const title = titleOf(media);
  let statusClass = media.request_status || "pending";
  let statusLabel = STATUS_LABELS[statusClass] || STATUS_LABELS.pending;
  if (media.has_link) {
    statusClass = "live";
    statusLabel = "🟣 Available Now";
  }
  return `
    <div class="top-req-row" data-anime-id="${media.id}">
      <img class="top-req-cover" src="${cover}" alt="" loading="lazy" />
      <div class="top-req-info">
        <div class="top-req-title">${escapeHtml(title)}</div>
        <span class="top-req-status top-req-status--${statusClass}">${statusLabel}</span>
      </div>
    </div>
  `;
}

async function loadMyRequests() {
  const list = document.getElementById("my-requests-list");
  if (!initData) {
    list.innerHTML = `<p class="notice">Open this from inside the Telegram bot to see your requests.</p>`;
    return;
  }
  list.innerHTML = `<div class="skel skel--row"></div><div class="skel skel--row"></div>`;

  const data = await api("/api/anime/my-requests");
  if (!data.ok) {
    list.innerHTML = `<p class="notice notice--error">Couldn't load your requests.</p>`;
    return;
  }
  if (!data.media.length) {
    list.innerHTML = `<p class="notice">You haven't requested any anime yet.</p>`;
    return;
  }
  cacheMedia(data.media);
  list.innerHTML = data.media.map(m => myRequestRowHtml(m)).join("");
}

/* ============================================================
   Genres tab: chip grid -> filtered anime grid
   ============================================================ */

const GENRE_ICONS = {
  "action": "⚔️", "adventure": "🧭", "comedy": "😂", "drama": "🎭",
  "fantasy": "🪄", "horror": "💀", "isekai": "🌀", "romance": "💗",
  "sci-fi": "🛸", "slice-of-life": "🍜", "sports": "🏅", "thriller": "⚡",
};

let genreListLoaded = false;

async function loadGenreList() {
  if (genreListLoaded) return;
  const grid = document.getElementById("genre-grid");
  grid.innerHTML = Array(9).fill('<div class="skel" style="aspect-ratio:1/0.85;"></div>').join("");

  const data = await fetchJson("/api/anime/genre-list");
  if (!data.ok || !data.genres.length) {
    grid.innerHTML = `<p class="notice notice--error">Couldn't load genres.</p>`;
    return;
  }
  genreListLoaded = true;
  grid.innerHTML = data.genres.map(g => `
    <button class="genre-chip" data-genre-slug="${g.slug}" data-genre-label="${escapeHtml(g.label)}">
      <span class="genre-chip-icon">${GENRE_ICONS[g.slug] || "🎬"}</span>
      <span class="genre-chip-label">${escapeHtml(g.label)}</span>
    </button>
  `).join("");
}

let currentGenreSlug = null;
let genrePage = 1;

async function openGenreDetail(slug, label) {
  currentGenreSlug = slug;
  document.getElementById("genre-detail-title").textContent = label;
  goTo("genreDetail");
  await loadGenreDetail(true);
}

async function loadGenreDetail(reset) {
  const grid = document.getElementById("genre-detail-grid");
  const loadMoreBtn = document.getElementById("btn-genre-load-more");

  if (reset) {
    genrePage = 1;
    grid.innerHTML = `<div class="skel skel--grid-card"></div><div class="skel skel--grid-card"></div><div class="skel skel--grid-card"></div><div class="skel skel--grid-card"></div>`;
  }
  loadMoreBtn.disabled = true;
  loadMoreBtn.textContent = "Loading…";

  const data = await fetchJson(`/api/anime/genre/${currentGenreSlug}?page=${genrePage}`);
  if (!data.ok || !data.media) {
    if (reset) grid.innerHTML = `<p class="notice notice--error">Couldn't load anime.</p>`;
    loadMoreBtn.style.display = "none";
    return;
  }
  cacheMedia(data.media);
  const html = data.media.map(m => animeCardHtml(m, false)).join("");
  if (reset) grid.innerHTML = html; else grid.insertAdjacentHTML("beforeend", html);

  const hasNext = Boolean(data.pageInfo && data.pageInfo.hasNextPage);
  loadMoreBtn.style.display = hasNext ? "block" : "none";
  loadMoreBtn.disabled = false;
  loadMoreBtn.textContent = "Load more";
  genrePage += 1;
}

document.getElementById("btn-genre-load-more").addEventListener("click", () => loadGenreDetail(false));

/* ============================================================
   Search (dedicated screen): recent + popular suggestions,
   format pills, list-style results
   ============================================================ */

const searchInput2 = document.getElementById("search-input-2");
const searchSuggestions = document.getElementById("search-suggestions");
const searchActive = document.getElementById("search-active");
const recentHead = document.getElementById("recent-searches-head");
const recentChipsWrap = document.getElementById("recent-searches-chips");
const popularListWrap = document.getElementById("popular-searches-list");
const searchResultList = document.getElementById("search-result-list");

const POPULAR_SEARCHES = ["Oshi no Ko", "Tokyo Revengers", "Chainsaw Man", "My Hero Academia", "Jujutsu Kaisen", "One Piece"];
const RECENT_SEARCHES_KEY = "as_recent_searches";
let currentSearchFormat = "";
let searchViewDebounce = null;
let searchViewInited = false;

function getRecentSearches() {
  try { return JSON.parse(localStorage.getItem(RECENT_SEARCHES_KEY) || "[]"); } catch { return []; }
}
function saveRecentSearch(q) {
  if (!q) return;
  let list = getRecentSearches().filter(x => x.toLowerCase() !== q.toLowerCase());
  list.unshift(q);
  localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(list.slice(0, 8)));
}
function renderRecentChips() {
  const list = getRecentSearches();
  recentHead.style.display = list.length ? "flex" : "none";
  recentChipsWrap.innerHTML = list.map(q => `
    <span class="chip" data-recent="${escapeHtml(q)}">${escapeHtml(q)}<button class="chip-remove" data-remove-recent="${escapeHtml(q)}">&#10005;</button></span>
  `).join("");
}
function renderPopularSearches() {
  popularListWrap.innerHTML = POPULAR_SEARCHES.map(q => `
    <button class="suggestion-row" data-suggest="${escapeHtml(q)}"><span>${escapeHtml(q)}</span><span class="suggestion-arrow">&#8599;</span></button>
  `).join("");
}

function initSearchView() {
  if (!searchViewInited) {
    renderPopularSearches();
    searchViewInited = true;
  }
  renderRecentChips();
  if (!searchInput2.value.trim()) {
    searchSuggestions.style.display = "block";
    searchActive.style.display = "none";
  }
  setTimeout(() => searchInput2.focus(), 60);
}

searchInput2.addEventListener("input", () => {
  clearTimeout(searchViewDebounce);
  const q = searchInput2.value.trim();
  if (!q) {
    searchSuggestions.style.display = "block";
    searchActive.style.display = "none";
    return;
  }
  searchViewDebounce = setTimeout(() => runSearchView(q), 300);
});

function searchResultRowHtml(media) {
  const cover = media.coverImage?.large || "";
  const title = titleOf(media);
  const type = media.format ? media.format.replace(/_/g, " ") : "";
  const year = media.seasonYear || "";
  const score = media.averageScore ? (media.averageScore / 10).toFixed(1) : null;
  return `
    <div class="search-result-row" data-anime-id="${media.id}">
      <img class="search-result-cover" src="${cover}" alt="" loading="lazy" />
      <div class="search-result-info">
        <div class="search-result-title">${escapeHtml(title)}</div>
        <div class="search-result-meta">${escapeHtml([type, year].filter(Boolean).join(" · "))}</div>
      </div>
      ${score ? `<span class="search-result-score">★ ${score}</span>` : ""}
    </div>
  `;
}

async function runSearchView(q) {
  searchSuggestions.style.display = "none";
  searchActive.style.display = "block";
  searchResultList.innerHTML = `<div class="skel skel--row"></div><div class="skel skel--row"></div><div class="skel skel--row"></div>`;

  const params = new URLSearchParams({ q });
  if (currentSearchFormat) params.set("format", currentSearchFormat);

  const data = await fetchJson(`/api/anime/search?${params.toString()}`);
  if (!data.ok) {
    searchResultList.innerHTML = `<p class="notice notice--error">Search failed.</p>`;
    return;
  }
  if (!data.media.length) {
    searchResultList.innerHTML = `<p class="notice">No results for "${escapeHtml(q)}".</p>`;
    return;
  }
  cacheMedia(data.media);
  searchResultList.innerHTML = data.media.map(m => searchResultRowHtml(m)).join("");
  saveRecentSearch(q);
  renderRecentChips();
}

document.querySelectorAll("#search-format-pills .pill").forEach(pill => {
  pill.addEventListener("click", () => {
    document.querySelectorAll("#search-format-pills .pill").forEach(p => p.classList.remove("pill--active"));
    pill.classList.add("pill--active");
    currentSearchFormat = pill.dataset.format;
    const q = searchInput2.value.trim();
    if (q) runSearchView(q);
  });
});

document.getElementById("btn-clear-recent").addEventListener("click", () => {
  localStorage.removeItem(RECENT_SEARCHES_KEY);
  renderRecentChips();
});

// Search-view-only interactions (recent chips, remove-chip, suggestion rows)
document.addEventListener("click", (e) => {
  const removeBtn = e.target.closest("[data-remove-recent]");
  if (removeBtn) {
    e.stopPropagation();
    const q = removeBtn.dataset.removeRecent;
    localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(getRecentSearches().filter(x => x !== q)));
    renderRecentChips();
    return;
  }

  const chip = e.target.closest("[data-recent]");
  if (chip) {
    searchInput2.value = chip.dataset.recent;
    runSearchView(chip.dataset.recent);
    return;
  }

  const suggestion = e.target.closest("[data-suggest]");
  if (suggestion) {
    searchInput2.value = suggestion.dataset.suggest;
    runSearchView(suggestion.dataset.suggest);
    return;
  }

  const genreChip = e.target.closest("[data-genre-slug]");
  if (genreChip) {
    openGenreDetail(genreChip.dataset.genreSlug, genreChip.dataset.genreLabel);
  }
});

/* ---------- card click -> details modal (also handles A-Z chips and the admin delete button) ---------- */
document.addEventListener("click", (e) => {
  const deleteBtn = e.target.closest(".anime-card-delete");
  if (deleteBtn) {
    const id = parseInt(deleteBtn.dataset.deleteId, 10);
    openDeleteConfirm(id);
    return;
  }

  const chip = e.target.closest(".az-chip");
  if (chip) {
    if (chip.disabled) return;
    document.getElementById(azSectionId(chip.dataset.letter))?.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }

  const card = e.target.closest("[data-anime-id]");
  if (!card) return;
  const id = parseInt(card.dataset.animeId, 10);
  openAnimeModal(id);
});

const animeModalOverlay = document.getElementById("anime-modal-overlay");
const animeModalClose = document.getElementById("anime-modal-close");
const animeModalCover = document.getElementById("anime-modal-cover");
const animeModalTitle = document.getElementById("anime-modal-title");
const animeModalMeta = document.getElementById("anime-modal-meta");
const animeModalGenres = document.getElementById("anime-modal-genres");
const animeModalDesc = document.getElementById("anime-modal-desc");
const animeActionBtn = document.getElementById("anime-action-btn");
const animeVoteBtn = document.getElementById("anime-vote-btn");
const animeSetChannelBtn = document.getElementById("anime-set-channel-btn");
const setChannelModal = document.getElementById("set-channel-modal-overlay");
const setChannelInput = document.getElementById("set-channel-input");
const setChannelError = document.getElementById("set-channel-error");
const setChannelCancel = document.getElementById("set-channel-cancel");
const setChannelConfirm = document.getElementById("set-channel-confirm");

let currentAnimeId = null;
let currentChannelId = null;
let currentCustomLink = null;
let statusPollTimer = null;

function metaPillsHtml(media) {
  const pills = [];
  if (media.format) pills.push(`<span class="meta-pill">${escapeHtml(media.format.replace(/_/g, " "))}</span>`);
  if (media.seasonYear) pills.push(`<span class="meta-pill">${media.seasonYear}</span>`);
  if (media.duration) pills.push(`<span class="meta-pill">${media.duration}m</span>`);
  if (media.averageScore) pills.push(`<span class="meta-pill meta-pill--score">★ ${(media.averageScore / 10).toFixed(1)}</span>`);
  return pills.join("");
}

async function openAnimeModal(id) {
  const media = animeCache.get(id);
  if (!media) return;

  currentAnimeId = id;
  animeModalCover.src = media.coverImage?.large || "";
  animeModalTitle.textContent = titleOf(media);
  animeModalMeta.innerHTML = metaPillsHtml(media);
  animeModalGenres.innerHTML = (media.genres || []).map(g => `<span class="genre-pill">${escapeHtml(g)}</span>`).join("");
  animeModalDesc.textContent = stripHtml(media.description) || "No synopsis available.";

  animeSetChannelBtn.style.display = (session && session.is_admin) ? "block" : "none";

  animeModalOverlay.style.display = "flex";
  await refreshActionButton();

  clearInterval(statusPollTimer);
  statusPollTimer = setInterval(refreshActionButton, 8000);
}

function closeAnimeModal() {
  animeModalOverlay.style.display = "none";
  clearInterval(statusPollTimer);
  currentAnimeId = null;
}

animeModalClose.addEventListener("click", closeAnimeModal);
animeModalOverlay.addEventListener("click", (e) => { if (e.target === animeModalOverlay) closeAnimeModal(); });

async function refreshActionButton() {
  if (!currentAnimeId) return;
  const data = await fetchJson(`/api/anime/status/${currentAnimeId}`);
  currentChannelId = data.ok ? data.channel_id : null;
  currentCustomLink = data.ok ? data.custom_link : null;
  const status = data.ok ? data.status : "none";
  setActionButtonState(status, currentChannelId || currentCustomLink);
  await refreshVoteButton(status, Boolean(currentChannelId || currentCustomLink));
}

animeSetChannelBtn.addEventListener("click", () => {
  setChannelInput.value = currentCustomLink || currentChannelId || "";
  setChannelError.textContent = "";
  setChannelModal.style.display = "flex";
  setTimeout(() => setChannelInput.focus(), 50);
});

setChannelCancel.addEventListener("click", () => { setChannelModal.style.display = "none"; });
setChannelModal.addEventListener("click", (e) => { if (e.target === setChannelModal) setChannelModal.style.display = "none"; });

setChannelConfirm.addEventListener("click", async () => {
  const value = setChannelInput.value.trim();
  if (!value) {
    setChannelError.textContent = "Enter a channel ID or @username.";
    return;
  }

  setChannelConfirm.disabled = true;
  setChannelConfirm.textContent = "Saving…";
  setChannelError.textContent = "";

  const media = animeCache.get(currentAnimeId);
  const res = await api("/api/anime/set-channel", { anilist_id: currentAnimeId, value, title: titleOf(media) });

  setChannelConfirm.disabled = false;
  setChannelConfirm.textContent = "Save";

  if (!res.ok) {
    const messages = {
      not_found: "Couldn't resolve that — try the numeric channel ID instead.",
      not_a_channel: "That's not a channel.",
      lookup_failed: "Lookup failed. Try again.",
      empty_value: "Enter a channel ID or @username.",
    };
    setChannelError.textContent = messages[res.error] || "Could not save. Try again.";
    return;
  }

  setChannelModal.style.display = "none";
  await refreshActionButton();
});

/* ============================================================
   Admin: remove an anime from Available
   ============================================================ */

const deleteConfirmOverlay = document.getElementById("delete-confirm-modal-overlay");
const deleteConfirmText = document.getElementById("delete-confirm-text");
const deleteConfirmError = document.getElementById("delete-confirm-error");
const deleteConfirmCancel = document.getElementById("delete-confirm-cancel");
const deleteConfirmSubmit = document.getElementById("delete-confirm-submit");
let deleteTargetId = null;

function openDeleteConfirm(id) {
  const media = animeCache.get(id);
  deleteTargetId = id;
  deleteConfirmText.textContent =
    `Remove "${media ? titleOf(media) : "this anime"}"? ` +
    `This erases its request/channel record entirely — it can be requested again later.`;
  deleteConfirmError.textContent = "";
  deleteConfirmOverlay.style.display = "flex";
}

deleteConfirmCancel.addEventListener("click", () => { deleteConfirmOverlay.style.display = "none"; });
deleteConfirmOverlay.addEventListener("click", (e) => { if (e.target === deleteConfirmOverlay) deleteConfirmOverlay.style.display = "none"; });

deleteConfirmSubmit.addEventListener("click", async () => {
  if (deleteTargetId == null) return;

  deleteConfirmSubmit.disabled = true;
  deleteConfirmSubmit.textContent = "Removing…";

  const res = await api("/api/anime/remove-available", { anilist_id: deleteTargetId });

  deleteConfirmSubmit.disabled = false;
  deleteConfirmSubmit.textContent = "Remove";

  if (!res.ok) {
    deleteConfirmError.textContent = "Couldn't remove it. Try again.";
    return;
  }

  deleteConfirmOverlay.style.display = "none";
  deleteTargetId = null;
  loadAvailable();
  loadTopRequested();
  if (currentAnimeId != null) refreshActionButton();
});

function setActionButtonState(status, channelId) {
  animeActionBtn.className = "anime-action-btn";
  animeActionBtn.disabled = false;

  if (channelId) {
    animeActionBtn.textContent = "▶ Join";
    animeActionBtn.dataset.state = "join";
  } else if (status === "pending") {
    animeActionBtn.textContent = "Pending";
    animeActionBtn.classList.add("state-pending");
    animeActionBtn.disabled = true;
    animeActionBtn.dataset.state = "pending";
  } else if (status === "accepted") {
    animeActionBtn.textContent = "Coming Soon…";
    animeActionBtn.classList.add("state-accepted");
    animeActionBtn.dataset.state = "accepted";
  } else if (status === "declined") {
    animeActionBtn.textContent = "Not Available";
    animeActionBtn.classList.add("state-declined");
    animeActionBtn.dataset.state = "declined";
  } else {
    animeActionBtn.textContent = "Request Anime";
    animeActionBtn.dataset.state = "request";
  }
}

/* ============================================================
   Vote for a pending / accepted / declined request
   ============================================================ */

const VOTABLE_STATUSES = ["pending", "accepted", "declined"];

function setVoteButtonState(votes, voted) {
  animeVoteBtn.classList.toggle("voted", voted);
  animeVoteBtn.textContent = voted
    ? `✅ Voted for this request (${votes}) — tap to remove`
    : `🗳️ Vote for this request (${votes})`;
}

async function refreshVoteButton(status, hasLink) {
  if (hasLink || !VOTABLE_STATUSES.includes(status)) {
    animeVoteBtn.style.display = "none";
    return;
  }
  const data = await api(`/api/anime/votes/${currentAnimeId}`);
  if (!data.ok) {
    animeVoteBtn.style.display = "none";
    return;
  }
  setVoteButtonState(data.votes, data.voted);
  animeVoteBtn.style.display = "block";
}

animeVoteBtn.addEventListener("click", async () => {
  if (!initData) return showInfoPopup("Sign in required", "Open this from inside the Telegram bot to vote.", "warning");

  animeVoteBtn.disabled = true;
  const res = await api("/api/anime/vote", { anilist_id: currentAnimeId });
  animeVoteBtn.disabled = false;

  if (res.ok) {
    setVoteButtonState(res.votes, res.voted);
  } else {
    showInfoPopup("Couldn't vote", "Something went wrong — try again in a moment.", "error");
  }
});

animeActionBtn.addEventListener("click", async () => {
  const state = animeActionBtn.dataset.state;

  if (state === "request") {
    if (!initData) return showInfoPopup("Sign in required", "Open this from inside the Telegram bot to request anime.", "warning");
    animeActionBtn.disabled = true;
    animeActionBtn.textContent = "Requesting…";
    const media = animeCache.get(currentAnimeId);
    const res = await api("/api/anime/request", { anilist_id: currentAnimeId, title: titleOf(media) });
    if (res.ok) {
      setActionButtonState(res.status || "pending", null);
      showInfoPopup("Request sent successfully!", "We will notify you soon.", "success");
    } else if (res.error === "daily_limit_reached") {
      animeActionBtn.disabled = false;
      animeActionBtn.textContent = "Request Anime";
      showInfoPopup("Daily limit reached", `You can request up to ${res.limit || 4} anime per day. Try again tomorrow!`, "warning");
    } else {
      animeActionBtn.disabled = false;
      animeActionBtn.textContent = "Request Anime";
      showInfoPopup("Couldn't send request", "Something went wrong — try again in a moment.", "error");
    }
  } else if (state === "accepted") {
    showInfoPopup("Good news!", "This anime is coming soon. For updates, join @weebs_talk_station.", "warning");
  } else if (state === "declined") {
    showInfoPopup("Not available", "This anime isn't available right now. Thank you for understanding.", "error");
  } else if (state === "join") {
    if (!initData) return showInfoPopup("Sign in required", "Open this from inside the Telegram bot to join.", "warning");
    animeActionBtn.disabled = true;
    const prevText = animeActionBtn.textContent;
    animeActionBtn.textContent = "Generating link…";
    const res = await api("/api/anime/join", { anilist_id: currentAnimeId });
    animeActionBtn.disabled = false;
    animeActionBtn.textContent = prevText;
    if (res.ok) {
      if (tg && tg.openLink) tg.openLink(res.invite_link); else window.open(res.invite_link, "_blank");
    } else {
      showInfoPopup("Couldn't generate link", "Try again in a moment.", "error");
    }
  }
});

(async function initApp() {
  const passed = await boot();
  if (passed) {
    loadTrending();
    loadTopAiring();
    loadPopular(true);
  }
})();

// Launched via a group-search deep link (t.me/bot/shortname?startapp=anime_<id>)?
(async function openFromStartParam() {
  const startParam = tg?.initDataUnsafe?.start_param || "";
  if (!startParam.startsWith("anime_")) return;

  const id = parseInt(startParam.replace("anime_", ""), 10);
  if (!id) return;

  const data = await fetchJson(`/api/anime/single/${id}`);
  if (!data.ok) return;

  cacheMedia([data.media]);
  openAnimeModal(id);
})();

/* ============================================================
   Report an issue
   ============================================================ */

const reportBtn = document.getElementById("report-btn");
const reportModal = document.getElementById("report-modal-overlay");
const reportOptions = document.querySelectorAll(".report-option");
const reportMessageInput = document.getElementById("report-message-input");
const reportCharCount = document.getElementById("report-char-count");
const reportError = document.getElementById("report-error");
const reportCloseX = document.getElementById("report-close-x");
const reportSubmit = document.getElementById("report-submit");
let selectedReportReason = null;

reportBtn.addEventListener("click", () => {
  selectedReportReason = null;
  reportOptions.forEach(o => o.classList.remove("selected"));
  reportMessageInput.value = "";
  reportCharCount.textContent = "0";
  reportError.textContent = "";
  reportModal.style.display = "flex";
});

reportOptions.forEach(opt => {
  opt.addEventListener("click", () => {
    reportOptions.forEach(o => o.classList.remove("selected"));
    opt.classList.add("selected");
    selectedReportReason = opt.dataset.reason;
    reportError.textContent = "";
  });
});

reportMessageInput.addEventListener("input", () => {
  reportCharCount.textContent = reportMessageInput.value.length;
});

reportCloseX.addEventListener("click", () => { reportModal.style.display = "none"; });
reportModal.addEventListener("click", (e) => { if (e.target === reportModal) reportModal.style.display = "none"; });

reportSubmit.addEventListener("click", async () => {
  if (!selectedReportReason) {
    reportError.textContent = "Pick a reason first.";
    return;
  }
  if (!initData) {
    reportError.textContent = "Open this from inside the Telegram bot to report.";
    return;
  }

  reportSubmit.disabled = true;
  reportSubmit.textContent = "Sending…";

  const media = animeCache.get(currentAnimeId);
  const res = await api("/api/anime/report", {
    anilist_id: currentAnimeId,
    title: titleOf(media),
    reason: selectedReportReason,
    message: reportMessageInput.value.trim().slice(0, 50),
  });

  reportSubmit.disabled = false;
  reportSubmit.textContent = "Submit Report";

  if (!res.ok) {
    reportError.textContent = "Couldn't send report. Try again.";
    return;
  }

  reportModal.style.display = "none";
  showInfoPopup("Reported", "Thanks — the admins have been notified.", "success");
});

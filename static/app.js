const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
  tg.setHeaderColor("#0b0d0f");
  tg.setBackgroundColor("#0b0d0f");
}

const initData = tg?.initData || "";

const views = {
  home: document.getElementById("view-home"),
  profile: document.getElementById("view-profile"),
  topRequested: document.getElementById("view-top-requested"),
};

function showView(name) {
  Object.values(views).forEach(v => v.classList.remove("view--active"));
  views[name].classList.add("view--active");
}

document.querySelectorAll("[data-back]").forEach(btn => {
  btn.addEventListener("click", () => showView("home"));
});

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
}

function hideFsubGate() {
  document.getElementById("fsub-gate").style.display = "none";
  document.getElementById("app").style.display = "";
}

document.getElementById("fsub-gate-reload").addEventListener("click", async () => {
  const btn = document.getElementById("fsub-gate-reload");
  const original = btn.textContent;
  btn.textContent = "Checking...";
  btn.disabled = true;

  const passed = await boot();
  if (passed) {
    loadTrending();
    loadPopular(true);
  } else {
    btn.textContent = original;
    btn.disabled = false;
  }
});

function fillProfile(data) {
  const u = data.user;
  document.getElementById("profile-name").textContent =
    [u.first_name, u.last_name].filter(Boolean).join(" ") || "—";
  document.getElementById("profile-handle").textContent = u.username ? "@" + u.username : "no username";
  document.getElementById("profile-photo").src = u.photo_url || "";
  document.getElementById("profile-id").textContent = u.id;
  document.getElementById("profile-registered").textContent = data.registered ? "yes" : "no";
  document.getElementById("profile-role").textContent = data.is_admin ? "admin" : "member";
  document.getElementById("profile-banned").textContent = data.is_banned ? "banned" : "active";
}

document.getElementById("btn-profile").addEventListener("click", () => {
  if (!session) return showInfoPopup("Not signed in", "Open this from inside your Telegram bot to view your profile.");
  showView("profile");
});

document.getElementById("btn-top-requested").addEventListener("click", () => {
  showView("topRequested");
  loadTopRequested();
});

/* ============================================================
   Info popup (used by anime state messages)
   ============================================================ */

const infoPopupOverlay = document.getElementById("info-popup-overlay");
const infoPopupTitle = document.getElementById("info-popup-title");
const infoPopupText = document.getElementById("info-popup-text");
const infoPopupClose = document.getElementById("info-popup-close");

function showInfoPopup(title, text) {
  infoPopupTitle.textContent = title;
  infoPopupText.textContent = text;
  infoPopupOverlay.style.display = "flex";
}
infoPopupClose.addEventListener("click", () => { infoPopupOverlay.style.display = "none"; });
infoPopupOverlay.addEventListener("click", (e) => { if (e.target === infoPopupOverlay) infoPopupOverlay.style.display = "none"; });

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

// --- Bottom nav: All / Available ---
let currentBottomTab = "all";
const bottomNavBtns = document.querySelectorAll(".bottom-nav-btn");
const availableSection = document.getElementById("available-section");

function showBottomTab() {
  searchResults.style.display = "none";
  if (currentBottomTab === "available") {
    browseSections.style.display = "none";
    availableSection.style.display = "block";
    loadAvailable();
  } else {
    availableSection.style.display = "none";
    browseSections.style.display = "block";
  }
}

bottomNavBtns.forEach(btn => {
  btn.addEventListener("click", () => {
    bottomNavBtns.forEach(b => b.classList.remove("bottom-nav-btn--active"));
    btn.classList.add("bottom-nav-btn--active");
    currentBottomTab = btn.dataset.bottomTab;
    searchInput.value = "";
    showBottomTab();
  });
});

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

// --- Top Requested (ranked by votes, opened via the trophy button) ---
const STATUS_LABELS = {
  pending: "⏳ Pending",
  accepted: "🟢 Coming Soon",
  declined: "⚪ Not Available",
};

function topRequestedRowHtml(media, rank) {
  const cover = media.coverImage?.large || "";
  const title = titleOf(media);
  const statusLabel = STATUS_LABELS[media.request_status] || "";
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
        <div class="top-req-status">${statusLabel}</div>
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

// --- Search ---
let searchDebounce = null;
const searchInput = document.getElementById("search-input");
const searchResults = document.getElementById("search-results");
const browseSections = document.getElementById("browse-sections");

searchInput.addEventListener("input", () => {
  clearTimeout(searchDebounce);
  const q = searchInput.value.trim();
  if (!q) {
    showBottomTab();
    return;
  }
  searchDebounce = setTimeout(() => runSearch(q), 300);
});

async function runSearch(q) {
  browseSections.style.display = "none";
  availableSection.style.display = "none";
  searchResults.style.display = "grid";
  searchResults.innerHTML = `<div class="skel skel--grid-card"></div><div class="skel skel--grid-card"></div><div class="skel skel--grid-card"></div>`;

  const data = await fetchJson(`/api/anime/search?q=${encodeURIComponent(q)}`);
  if (!data.ok) {
    searchResults.innerHTML = `<p class="notice notice--error">Search failed.</p>`;
    return;
  }
  if (!data.media.length) {
    searchResults.innerHTML = `<p class="notice">No results for "${escapeHtml(q)}".</p>`;
    return;
  }
  cacheMedia(data.media);
  searchResults.innerHTML = data.media.map(m => animeCardHtml(m, false)).join("");
}

// --- Card click -> details modal (also handles A-Z chips and the admin delete button) ---
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

async function openAnimeModal(id) {
  const media = animeCache.get(id);
  if (!media) return;

  currentAnimeId = id;
  animeModalCover.src = media.coverImage?.large || "";
  animeModalTitle.textContent = titleOf(media);
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
  if (!initData) return showInfoPopup("Sign in required", "Open this from inside the Telegram bot to vote.");

  animeVoteBtn.disabled = true;
  const res = await api("/api/anime/vote", { anilist_id: currentAnimeId });
  animeVoteBtn.disabled = false;

  if (res.ok) {
    setVoteButtonState(res.votes, res.voted);
  } else {
    showInfoPopup("Couldn't vote", "Something went wrong — try again in a moment.");
  }
});

animeActionBtn.addEventListener("click", async () => {
  const state = animeActionBtn.dataset.state;

  if (state === "request") {
    if (!initData) return showInfoPopup("Sign in required", "Open this from inside the Telegram bot to request anime.");
    animeActionBtn.disabled = true;
    animeActionBtn.textContent = "Requesting…";
    const media = animeCache.get(currentAnimeId);
    const res = await api("/api/anime/request", { anilist_id: currentAnimeId, title: titleOf(media) });
    if (res.ok) {
      setActionButtonState(res.status || "pending", null);
    } else if (res.error === "daily_limit_reached") {
      animeActionBtn.disabled = false;
      animeActionBtn.textContent = "Request Anime";
      showInfoPopup("Daily limit reached", `You can request up to ${res.limit || 4} anime per day. Try again tomorrow!`);
    } else {
      animeActionBtn.disabled = false;
      animeActionBtn.textContent = "Request Anime";
      showInfoPopup("Couldn't send request", "Something went wrong — try again in a moment.");
    }
  } else if (state === "accepted") {
    showInfoPopup("Accepted", "Your request has already been accepted by the admins.\n\nFor updates, join @weebs_talk_station.");
  } else if (state === "declined") {
    showInfoPopup("Not available", "This anime isn't available right now. The admins may decide to add it later.");
  } else if (state === "join") {
    if (!initData) return showInfoPopup("Sign in required", "Open this from inside the Telegram bot to join.");
    animeActionBtn.disabled = true;
    const prevText = animeActionBtn.textContent;
    animeActionBtn.textContent = "Generating link…";
    const res = await api("/api/anime/join", { anilist_id: currentAnimeId });
    animeActionBtn.disabled = false;
    animeActionBtn.textContent = prevText;
    if (res.ok) {
      if (tg && tg.openLink) tg.openLink(res.invite_link); else window.open(res.invite_link, "_blank");
    } else {
      showInfoPopup("Couldn't generate link", "Try again in a moment.");
    }
  }
});

(async function initApp() {
  const passed = await boot();
  if (passed) {
    loadTrending();
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
const reportError = document.getElementById("report-error");
const reportCancel = document.getElementById("report-cancel");
const reportSubmit = document.getElementById("report-submit");
let selectedReportReason = null;

reportBtn.addEventListener("click", () => {
  selectedReportReason = null;
  reportOptions.forEach(o => o.classList.remove("selected"));
  reportMessageInput.value = "";
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

reportCancel.addEventListener("click", () => { reportModal.style.display = "none"; });
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
  reportSubmit.textContent = "Submit";

  if (!res.ok) {
    reportError.textContent = "Couldn't send report. Try again.";
    return;
  }

  reportModal.style.display = "none";
  showInfoPopup("Reported", "Thanks — the admins have been notified.");
});

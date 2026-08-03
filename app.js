"use strict";

// --- Config -----------------------------------------------------------

// Deploy worker/worker.js with `wrangler deploy`, then replace the URL below
// with the one it prints. Localhost is auto-detected for local dev against
// `wrangler dev` (see README).
const WORKER_BASE_URL =
  location.hostname === "localhost" || location.hostname === "127.0.0.1"
    ? "http://localhost:8787"
    : "https://watchlist-matcher-proxy.crdotx.workers.dev";

const MIN_USERNAMES = 2;
const MAX_PAGES = 60; // safety cap (~1680 films/user)
const PAGE_DELAY_MS_RANGE = [150, 250]; // politeness delay between paginated requests
const FILM_DETAILS_CONCURRENCY = 5;
const CARD_STAGGER_MS = 15;
const CARD_STAGGER_MAX_MS = 300;
const STATUS_FADE_MS = 300;

// --- Errors -------------------------------------------------------------

class UserNotFoundError extends Error {
  constructor(username) {
    super(`@${username} — not found (private watchlist or typo?)`);
    this.username = username;
  }
}

class FetchError extends Error {
  constructor(username, status, detail) {
    super(
      status
        ? `@${username} — request failed (HTTP ${status})`
        : `@${username} — network error${detail ? ": " + detail : ""}`
    );
    this.username = username;
    this.status = status;
  }
}

// --- Small helpers --------------------------------------------------------

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay([min, max]) {
  return delay(min + Math.random() * (max - min));
}

// --- Parsing (all via DOMParser, never regex-on-raw-HTML) -----------------

function parseFilmEl(el) {
  const slug = el.getAttribute("data-item-slug");
  if (!slug) return null;
  const link = el.getAttribute("data-item-link");
  const fullName =
    el.getAttribute("data-item-full-display-name") ||
    el.getAttribute("data-item-name") ||
    "";
  const match = fullName.match(/^(.*)\s\((\d{4})\)\s*$/);
  return {
    slug,
    title: match ? match[1] : fullName,
    year: match ? match[2] : null,
    link,
  };
}

function hasNextPage(doc) {
  return !!doc.querySelector(".pagination a.next");
}

// --- Fetching ---------------------------------------------------------

async function fetchWatchlistForUser(username, onProgress) {
  const films = [];
  const seenSlugs = new Set();
  let truncated = false;
  let avatarUrl = null;
  const encodedUsername = encodeURIComponent(username);

  for (let page = 1; page <= MAX_PAGES; page++) {
    const path =
      page === 1
        ? `/${encodedUsername}/watchlist/`
        : `/${encodedUsername}/watchlist/page/${page}/`;

    let res;
    try {
      res = await fetch(WORKER_BASE_URL + path);
    } catch (err) {
      throw new FetchError(username, null, err.message);
    }

    if (res.status === 404) {
      if (page === 1) throw new UserNotFoundError(username);
      break; // shouldn't normally happen mid-pagination
    }
    if (!res.ok) throw new FetchError(username, res.status);

    const doc = new DOMParser().parseFromString(await res.text(), "text/html");
    doc.querySelectorAll("li.griditem [data-item-slug]").forEach((el) => {
      const film = parseFilmEl(el);
      if (film && !seenSlugs.has(film.slug)) {
        seenSlugs.add(film.slug);
        films.push(film);
      }
    });

    if (page === 1) {
      avatarUrl = doc.querySelector(".profile-mini-person .avatar img")?.getAttribute("src") || null;
    }

    onProgress?.(`@${username}: page ${page} (${films.length} found so far)`);

    if (!hasNextPage(doc)) break;
    if (page === MAX_PAGES) {
      truncated = true;
      onProgress?.(`@${username}: stopped after ${MAX_PAGES} pages — results may be incomplete`);
      break;
    }
    await randomDelay(PAGE_DELAY_MS_RANGE);
  }

  return { username, films, truncated, avatarUrl };
}

async function fetchAllWatchlists(usernames, onProgress) {
  const settled = await Promise.allSettled(
    usernames.map((username) => fetchWatchlistForUser(username, onProgress))
  );

  const ok = [];
  const errors = [];
  settled.forEach((result, i) => {
    if (result.status === "fulfilled") {
      ok.push(result.value);
    } else {
      errors.push({ username: usernames[i], error: result.reason });
    }
  });
  return { ok, errors };
}

// --- Aggregation & ranking -----------------------------------------------

function buildMatchMap(okResults) {
  const map = new Map(); // slug -> {slug, title, year, link, count, matchedUsernames}
  for (const { username, films } of okResults) {
    for (const film of films) {
      let entry = map.get(film.slug);
      if (!entry) {
        entry = { ...film, count: 0, matchedUsernames: [] };
        map.set(film.slug, entry);
      }
      entry.count++;
      entry.matchedUsernames.push(username);
    }
  }
  return map;
}

function filterAndRank(map) {
  return [...map.values()]
    .filter((film) => film.count >= 2)
    .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title));
}

// --- Film details: poster + runtime (bounded to the ranked/filtered set only) -

// Letterboxd film pages embed a schema.org JSON-LD block wrapped in a CDATA-style
// comment (not valid on its own — the comment markers must be stripped first).
function parseFilmJsonLd(doc) {
  const script = doc.querySelector('script[type="application/ld+json"]');
  if (!script) return null;
  try {
    const cleaned = script.textContent
      .replace("/* <![CDATA[ */", "")
      .replace("/* ]]> */", "")
      .trim();
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

// Runtimes are ISO 8601 durations, e.g. "PT1H22M".
function parseRuntimeMinutes(isoDuration) {
  if (!isoDuration) return null;
  const match = isoDuration.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!match) return null;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  const total = hours * 60 + minutes + Math.round(seconds / 60);
  return total > 0 ? total : null;
}

function extractFilmDetails(doc) {
  const posterUrl = doc.querySelector('meta[property="og:image"]')?.getAttribute("content") || null;
  const runtimeMinutes = parseRuntimeMinutes(parseFilmJsonLd(doc)?.duration);
  return { posterUrl, runtimeMinutes };
}

async function fetchFilmDetailsWithConcurrency(films, concurrency, onProgress) {
  let nextIndex = 0;
  let completed = 0;

  async function worker() {
    while (nextIndex < films.length) {
      const film = films[nextIndex++];
      try {
        const res = await fetch(`${WORKER_BASE_URL}/film/${encodeURIComponent(film.slug)}/`);
        if (!res.ok) throw new Error("bad status");
        const doc = new DOMParser().parseFromString(await res.text(), "text/html");
        const { posterUrl, runtimeMinutes } = extractFilmDetails(doc);
        film.posterUrl = posterUrl;
        film.runtimeMinutes = runtimeMinutes;
      } catch {
        film.posterUrl = null;
        film.runtimeMinutes = null;
      }
      completed++;
      onProgress?.(completed, films.length);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, films.length) }, worker);
  await Promise.all(workers);
}

function formatRuntime(minutes) {
  if (!minutes) return null;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours === 0) return `${mins} min`;
  if (mins === 0) return `${hours}h`;
  return `${hours}h ${mins}m`;
}

// --- Rendering --------------------------------------------------------

function makeAvatarFallback(username) {
  const div = document.createElement("div");
  div.className = "film-avatar-fallback";
  div.textContent = username.charAt(0).toUpperCase();
  return div;
}

function renderAvatar(username, avatarUrl) {
  const link = document.createElement("a");
  link.className = "film-avatar-link";
  link.href = `https://letterboxd.com/${encodeURIComponent(username)}/`;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.title = `@${username}`;

  if (avatarUrl) {
    const img = document.createElement("img");
    img.className = "film-avatar";
    img.src = avatarUrl;
    img.alt = `@${username}`;
    img.loading = "lazy";
    img.addEventListener("error", () => img.replaceWith(makeAvatarFallback(username)), { once: true });
    link.appendChild(img);
  } else {
    link.appendChild(makeAvatarFallback(username));
  }

  return link;
}

function renderAvatarStack(usernames, userAvatars) {
  const container = document.createElement("div");
  container.className = "film-avatars";
  for (const username of usernames) {
    container.appendChild(renderAvatar(username, userAvatars.get(username)));
  }
  return container;
}

function renderFilmCard(film, userAvatars) {
  const card = document.createElement("div");
  card.className = "film-card";

  const posterWrap = document.createElement("div");
  posterWrap.className = "film-poster-wrap";

  const yearSuffix = film.year ? ` (${film.year})` : "";

  if (film.posterUrl) {
    const img = document.createElement("img");
    img.src = film.posterUrl;
    img.loading = "lazy";
    img.alt = `${film.title}${yearSuffix} poster`;
    posterWrap.appendChild(img);
  } else {
    const fallback = document.createElement("div");
    fallback.className = "film-poster-fallback";
    fallback.textContent = `${film.title}${yearSuffix}`;
    posterWrap.appendChild(fallback);
  }

  const badge = document.createElement("span");
  badge.className = "film-count-badge";
  badge.textContent = String(film.count);
  posterWrap.appendChild(badge);
  card.appendChild(posterWrap);

  const titleEl = document.createElement("div");
  titleEl.className = "film-title";
  const titleLink = document.createElement("a");
  titleLink.href = film.link ? `https://letterboxd.com${film.link}` : "#";
  titleLink.target = "_blank";
  titleLink.rel = "noopener noreferrer";
  titleLink.textContent = film.title;
  titleEl.appendChild(titleLink);
  card.appendChild(titleEl);

  const metaParts = [];
  if (film.year) metaParts.push(film.year);
  const runtimeText = formatRuntime(film.runtimeMinutes);
  if (runtimeText) metaParts.push(runtimeText);
  if (metaParts.length > 0) {
    const metaEl = document.createElement("div");
    metaEl.className = "film-meta";
    metaEl.textContent = metaParts.join(" · ");
    card.appendChild(metaEl);
  }

  card.appendChild(renderAvatarStack(film.matchedUsernames, userAvatars));

  return card;
}

function renderResultsGrid(ranked, totalOk, userAvatars) {
  const container = document.getElementById("results");
  container.innerHTML = "";

  if (ranked.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No movies are shared by more than one of these watchlists.";
    container.appendChild(empty);
    return;
  }

  const tiers = new Map(); // count -> films[]
  for (const film of ranked) {
    if (!tiers.has(film.count)) tiers.set(film.count, []);
    tiers.get(film.count).push(film);
  }

  const counts = [...tiers.keys()].sort((a, b) => b - a);
  let cardIndex = 0;
  for (const count of counts) {
    const section = document.createElement("section");
    section.className = "result-tier";

    const heading = document.createElement("h2");
    heading.textContent =
      count === totalOk ? `In all ${totalOk} watchlists` : `In ${count} of ${totalOk} watchlists`;
    section.appendChild(heading);

    const grid = document.createElement("div");
    grid.className = "film-grid";
    for (const film of sortByRuntime(tiers.get(count))) {
      const card = renderFilmCard(film, userAvatars);
      card.style.animationDelay = `${Math.min(cardIndex * CARD_STAGGER_MS, CARD_STAGGER_MAX_MS)}ms`;
      cardIndex++;
      grid.appendChild(card);
    }
    section.appendChild(grid);

    container.appendChild(section);
  }
}

// Shortest to longest; unknown runtimes (fetch failed) sort last.
function sortByRuntime(films) {
  return films.slice().sort((a, b) => {
    if (a.runtimeMinutes == null && b.runtimeMinutes == null) return a.title.localeCompare(b.title);
    if (a.runtimeMinutes == null) return 1;
    if (b.runtimeMinutes == null) return -1;
    return a.runtimeMinutes - b.runtimeMinutes || a.title.localeCompare(b.title);
  });
}

function renderErrorSummary(errors) {
  const container = document.getElementById("errors");
  container.innerHTML = "";

  if (errors.length === 0) {
    container.hidden = true;
    return;
  }
  container.hidden = false;

  const heading = document.createElement("h3");
  heading.textContent =
    errors.length === 1 ? "1 account couldn't be loaded" : `${errors.length} accounts couldn't be loaded`;
  container.appendChild(heading);

  const list = document.createElement("ul");
  for (const { username, error } of errors) {
    const li = document.createElement("li");
    li.textContent = error?.message || `@${username}: unknown error`;
    list.appendChild(li);
  }
  container.appendChild(list);
}

let statusHideTimeout = null;

function showStatus(message) {
  const statusEl = document.getElementById("status");
  const statusTextEl = document.getElementById("status-text");

  if (statusHideTimeout) {
    clearTimeout(statusHideTimeout);
    statusHideTimeout = null;
  }

  if (!message) {
    statusEl.classList.add("status-fade-out");
    statusHideTimeout = setTimeout(() => {
      statusEl.hidden = true;
      statusEl.classList.remove("status-fade-out");
      statusTextEl.textContent = "";
      statusHideTimeout = null;
    }, STATUS_FADE_MS);
    return;
  }

  statusEl.hidden = false;
  statusEl.classList.remove("status-fade-out");
  statusTextEl.textContent = message;
}

// --- Username form UI ---------------------------------------------------

const usernameRowsEl = document.getElementById("username-rows");
const addRowBtn = document.getElementById("add-row-btn");
const submitBtn = document.getElementById("submit-btn");
const form = document.getElementById("matcher-form");

function createUsernameRow() {
  const row = document.createElement("div");
  row.className = "username-row";

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "letterboxd username";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.addEventListener("input", updateSubmitState);

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "remove-row-btn";
  removeBtn.textContent = "×";
  removeBtn.setAttribute("aria-label", "Remove this account");
  removeBtn.addEventListener("click", () => {
    row.remove();
    updateRemoveButtonsState();
    updateSubmitState();
  });

  row.appendChild(input);
  row.appendChild(removeBtn);
  return row;
}

function updateRemoveButtonsState() {
  const rows = [...usernameRowsEl.querySelectorAll(".username-row")];
  rows.forEach((row) => {
    row.querySelector(".remove-row-btn").disabled = rows.length <= MIN_USERNAMES;
  });
}

function getEnteredUsernames() {
  const inputs = [...usernameRowsEl.querySelectorAll("input[type=text]")];
  const raw = inputs.map((input) => input.value.trim()).filter(Boolean);

  const seen = new Set();
  const usernames = [];
  let hadDuplicates = false;
  for (const name of raw) {
    const key = name.toLowerCase();
    if (seen.has(key)) {
      hadDuplicates = true;
      continue;
    }
    seen.add(key);
    usernames.push(name);
  }
  return { usernames, hadDuplicates };
}

function updateSubmitState() {
  submitBtn.disabled = getEnteredUsernames().usernames.length < MIN_USERNAMES;
}

function setFormDisabled(disabled) {
  addRowBtn.disabled = disabled;
  usernameRowsEl.querySelectorAll("input, button").forEach((el) => {
    el.disabled = disabled;
  });
  if (!disabled) updateRemoveButtonsState();
  updateSubmitState();
  if (disabled) submitBtn.disabled = true;
}

addRowBtn.addEventListener("click", () => {
  usernameRowsEl.appendChild(createUsernameRow());
  updateRemoveButtonsState();
  updateSubmitState();
});

for (let i = 0; i < MIN_USERNAMES; i++) {
  usernameRowsEl.appendChild(createUsernameRow());
}
updateRemoveButtonsState();

// --- Submit orchestration -----------------------------------------------

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const { usernames, hadDuplicates } = getEnteredUsernames();
  if (usernames.length < MIN_USERNAMES) return;

  setFormDisabled(true);
  document.getElementById("results").innerHTML = "";
  renderErrorSummary([]);
  showStatus(hadDuplicates ? "Duplicate usernames were removed. Fetching watchlists…" : "Fetching watchlists…");

  try {
    const { ok, errors } = await fetchAllWatchlists(usernames, showStatus);

    if (ok.length < MIN_USERNAMES) {
      showStatus(null);
      renderErrorSummary(
        errors.length ? errors : usernames.map((username) => ({ username, error: new Error("Could not be fetched.") }))
      );
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = "Not enough watchlists could be loaded to compare.";
      document.getElementById("results").appendChild(empty);
      return;
    }

    const userAvatars = new Map(ok.map((r) => [r.username, r.avatarUrl]));
    const map = buildMatchMap(ok);
    const ranked = filterAndRank(map);

    if (ranked.length > 0) {
      showStatus(`Fetching film details (0/${ranked.length})…`);
      await fetchFilmDetailsWithConcurrency(ranked, FILM_DETAILS_CONCURRENCY, (done, total) =>
        showStatus(`Fetching film details (${done}/${total})…`)
      );
    }

    showStatus(null);
    renderResultsGrid(ranked, ok.length, userAvatars);
    renderErrorSummary(errors);
  } catch (err) {
    showStatus(null);
    renderErrorSummary([{ username: "", error: err }]);
  } finally {
    setFormDisabled(false);
  }
});

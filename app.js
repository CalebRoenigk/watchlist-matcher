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
const CHIP_FADE_MS = 180;
const CHIP_SLIDE_MS = 200;

// Input-screen -> results-screen transition (GSAP; durations in seconds to
// match GSAP's own convention). Each numbered comment below is one entry in
// the timeline, matching the spec: element, duration, ease, start position.
const HERO_SLIDE_DURATION = 0.7; // 1. #hero-group, cubic-bezier(.5,0,.5,1), @0s
const HERO_SLIDE_EASE = "heroEase"; // CustomEase for cubic-bezier(.5,0,.5,1) — see registration below
const BAR_FADE_DURATION = 0.45; // 2. #username-bar-row fade out, simple ease, @0s
const CHIPS_AND_STARTOVER_RISE_START = 0.2; // 3. #chips-and-startover y-move, simple ease, @200ms
const CHIPS_AND_STARTOVER_RISE_DURATION = 0.35;
const CHIPS_CENTER_DURATION = 0.5; // 4. #username-chips x-center + scale, simple ease, @0s
const CHIPS_SCALE_UP = 1.3;
const START_OVER_FADE_START = 0.5; // 5. #start-over-btn fade in, @500ms
const START_OVER_FADE_DURATION = 0.25;

// Results-screen -> input-screen reverse transition (Start Over). Reuses
// HERO_SLIDE_DURATION/HERO_SLIDE_EASE for #hero-group's own return (same
// 700ms/heroEase in both directions).
const RESULTS_FADE_OUT_DURATION = 0.4; // movie content fades out first, @0s
const BAR_FADE_IN_START = 0.25; // 2. #username-bar-row fade in, @250ms
const BAR_FADE_IN_DURATION = 0.45;
const CHIPS_AND_STARTOVER_RETURN_DURATION = 0.35; // 3. move back down, @0s
const CHIPS_SCALE_RETURN_DURATION = 0.35; // 4. scale back to 1, @0s
const CHIPS_UNCENTER_DURATION = 0.5; // 5. return to left-aligned x, @0s
const START_OVER_FADE_OUT_DURATION = 0.25; // 6. #start-over-btn fade out, @0s
const CHIPS_FADE_OUT_DURATION = 0.3; // 7. #username-chips fade out, @0s

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

function renderFilmCard(film, userAvatars, totalOk) {
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
  badge.className = "film-count-badge" + (film.count === totalOk ? " -all" : "");
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

// Shortest to longest; unknown runtimes (fetch failed) sort last.
function compareByRuntime(a, b) {
  if (a.runtimeMinutes == null && b.runtimeMinutes == null) return a.title.localeCompare(b.title);
  if (a.runtimeMinutes == null) return 1;
  if (b.runtimeMinutes == null) return -1;
  return a.runtimeMinutes - b.runtimeMinutes || a.title.localeCompare(b.title);
}

const NO_MATCHES_MESSAGES = [
  { heading: "Hmmm... thats odd.", subtitle: "Looks like these accounts don’t share any movies on their watchlists!" },
  { heading: "Welp this is awkward.", subtitle: "Looks like these accounts don’t share any movies on their watchlists!" },
  { heading: "Uh oh.", subtitle: "Looks like these accounts don’t share any movies on their watchlists!" },
  { heading: "Nothing to see here.", subtitle: "Looks like these accounts don’t share any movies on their watchlists!" },
];

// All matched films in a single grid: highest share-count first, then
// shortest-to-longest runtime within the same count.
function renderResultsGrid(ranked, totalOk, userAvatars) {
  const container = document.getElementById("results");
  container.innerHTML = "";

  if (ranked.length === 0) {
    const { heading, subtitle } = NO_MATCHES_MESSAGES[Math.floor(Math.random() * NO_MATCHES_MESSAGES.length)];
    const wrap = document.createElement("div");
    wrap.className = "no-matches";
    const headingEl = document.createElement("p");
    headingEl.className = "no-matches-heading";
    headingEl.textContent = heading;
    const subtitleEl = document.createElement("p");
    subtitleEl.className = "no-matches-subtitle";
    subtitleEl.textContent = subtitle;
    wrap.append(headingEl, subtitleEl);
    container.appendChild(wrap);
    return;
  }

  const sorted = ranked.slice().sort((a, b) => b.count - a.count || compareByRuntime(a, b));

  sorted.forEach((film, index) => {
    const card = renderFilmCard(film, userAvatars, totalOk);
    card.style.animationDelay = `${Math.min(index * CARD_STAGGER_MS, CARD_STAGGER_MAX_MS)}ms`;
    container.appendChild(card);
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
    statusEl.classList.remove("status-visible");
    statusHideTimeout = setTimeout(() => {
      statusEl.hidden = true;
      statusTextEl.textContent = "";
      statusHideTimeout = null;
    }, STATUS_FADE_MS);
    return;
  }

  statusTextEl.textContent = message;

  if (statusEl.hidden) {
    statusEl.hidden = false;
    // Force a reflow so the browser actually paints the opacity:0 starting
    // state before "status-visible" flips it to 1 — otherwise both style
    // changes land in the same frame and it just pops in with no fade.
    statusEl.offsetHeight;
  }
  statusEl.classList.add("status-visible");
}

// --- Screens ------------------------------------------------------------

gsap.registerPlugin(CustomEase);
// GSAP doesn't parse raw CSS cubic-bezier() strings on its own (confirmed —
// it silently falls back to a default ease instead of erroring); CustomEase
// is what actually understands them, via this SVG-path shorthand where the
// two "C" control points are exactly the bezier's (x1,y1) and (x2,y2).
CustomEase.create("heroEase", "M0,0 C0.5,0 0.5,1 1,1"); // cubic-bezier(.5,0,.5,1)

const mainEl = document.querySelector("main");
const heroGroup = document.getElementById("hero-group");
const resultsContent = document.getElementById("results-content");

let transitionTimeline = null;

// The header, input bar, chips, and Start Over button are one persistent
// group (#hero-group) that just switches between two visual modes — nothing
// here is a separate element getting swapped in for another. Toggling
// "results-mode"/"showing-results" instantly changes layout (chips-and-
// startover's alignment, main's justify-content); this measures each
// element's position before and after that instant change and hands GSAP
// the exact deltas to animate across, on the explicit timeline below.
function playTransitionToResults() {
  const barRow = document.getElementById("username-bar-row");
  const chipsAndStartover = document.getElementById("chips-and-startover");
  const startOverBtn = document.getElementById("start-over-btn");

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    heroGroup.classList.add("results-mode");
    mainEl.classList.add("showing-results");
    gsap.set(barRow, { opacity: 0 });
    gsap.set(startOverBtn, { opacity: 1 });
    resultsContent.hidden = false;
    return Promise.resolve();
  }

  // "Before" measurements — everything below is captured while still in
  // input-mode layout (bar visible, chips left-aligned, hero centered).
  const heroBefore = heroGroup.getBoundingClientRect();
  const chipsBefore = usernameChipsEl.getBoundingClientRect();
  const barRowBefore = barRow.getBoundingClientRect();
  const chipsAndStartoverBefore = chipsAndStartover.getBoundingClientRect();
  // Top-to-top distance, not just the bar's own height — that ignores the
  // margin gap between the bar and the chips-and-startover group below it,
  // which is why moving up by the bar's height alone landed short.
  const chipsAndStartoverRise = chipsAndStartoverBefore.top - barRowBefore.top;

  // Trigger the actual layout changes; the tweens below animate across them.
  heroGroup.classList.add("results-mode");
  mainEl.classList.add("showing-results");

  // "After" measurements, taken the instant the classes above land.
  const heroAfter = heroGroup.getBoundingClientRect();
  const chipsAfter = usernameChipsEl.getBoundingClientRect();

  const heroDy = heroBefore.top - heroAfter.top;
  const chipsDx = chipsBefore.left - chipsAfter.left;

  return new Promise((resolve) => {
    transitionTimeline = gsap.timeline({
      onComplete: () => {
        resultsContent.hidden = false;
        resolve();
      },
    });

    // 1. #hero-group transitions upwards.
    transitionTimeline.fromTo(
      heroGroup,
      { y: heroDy },
      { y: 0, duration: HERO_SLIDE_DURATION, ease: HERO_SLIDE_EASE },
      0
    );

    // 2. #username-bar-row fades out.
    transitionTimeline.to(barRow, { opacity: 0, duration: BAR_FADE_DURATION }, 0);

    // 3. #chips-and-startover moves up so its top lands on the bar's original top.
    transitionTimeline.fromTo(
      chipsAndStartover,
      { y: 0 },
      { y: -chipsAndStartoverRise, duration: CHIPS_AND_STARTOVER_RISE_DURATION },
      CHIPS_AND_STARTOVER_RISE_START
    );

    // 4. #username-chips centers itself on the x-axis and scales up, from its own center.
    transitionTimeline.fromTo(
      usernameChipsEl,
      { x: chipsDx, scale: 1 },
      { x: 0, scale: CHIPS_SCALE_UP, duration: CHIPS_CENTER_DURATION, transformOrigin: "50% 50%" },
      0
    );

    // 5. #start-over-btn fades in.
    transitionTimeline.to(
      startOverBtn,
      { opacity: 1, duration: START_OVER_FADE_DURATION },
      START_OVER_FADE_START
    );
  });
}

// Plays the reverse of playTransitionToResults(): the film grid/status area
// fades out first, then the header group animates back down to centered
// while the input bar fades back in and the chips/Start Over group returns
// to its left-aligned, unscaled, un-risen resting state.
function showInputScreen() {
  transitionTimeline?.kill();
  transitionTimeline = null;

  // enteredUsernames/chips aren't cleared until this transition finishes
  // (see the Start Over click handler), so without this the submit button
  // would still read as enabled — and clickable — for the whole ~700ms
  // reverse animation, racing with it if clicked. updateSubmitState() (via
  // the click handler, once this resolves) sets the real disabled state.
  submitBtn.disabled = true;

  const barRow = document.getElementById("username-bar-row");
  const chipsAndStartover = document.getElementById("chips-and-startover");
  const startOverBtn = document.getElementById("start-over-btn");

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    resultsContent.hidden = true;
    mainEl.classList.remove("showing-results");
    heroGroup.classList.remove("results-mode");
    gsap.killTweensOf([heroGroup, usernameChipsEl, chipsAndStartover, barRow, startOverBtn, resultsContent]);
    gsap.set([heroGroup, usernameChipsEl, chipsAndStartover, barRow, resultsContent], { clearProps: "all" });
    gsap.set(startOverBtn, { opacity: 0 });
    return Promise.resolve();
  }

  // Take the results area out of flow, frozen at its current visual spot, so
  // it can fade out without affecting #hero-group's re-centering below (that
  // needs to compute its centered position as if the results grid wasn't
  // contributing to main's layout at all).
  const resultsRect = resultsContent.getBoundingClientRect();
  const mainRect = mainEl.getBoundingClientRect();
  gsap.set(resultsContent, {
    position: "absolute",
    top: resultsRect.top - mainRect.top,
    left: resultsRect.left - mainRect.left,
    width: resultsRect.width,
    pointerEvents: "none",
  });

  // "Before" measurements (still in results-mode layout).
  const heroBefore = heroGroup.getBoundingClientRect();
  const chipsBefore = usernameChipsEl.getBoundingClientRect(); // reflects current centered position + scale(1.3)

  // Temporarily clear the chips' transform so the "after" measurement below
  // reflects their true natural (unscaled) left-aligned position, not a
  // scaled/offset rendering left over from the forward transition.
  gsap.set(usernameChipsEl, { clearProps: "transform" });

  // Trigger the actual layout changes; the tweens below animate across them.
  heroGroup.classList.remove("results-mode");
  mainEl.classList.remove("showing-results");

  // "After" measurements, taken the instant the classes above land.
  const heroAfter = heroGroup.getBoundingClientRect();
  const chipsAfter = usernameChipsEl.getBoundingClientRect();

  const heroDy = heroBefore.top - heroAfter.top;
  const chipsDx = chipsBefore.left - chipsAfter.left;

  return new Promise((resolve) => {
    transitionTimeline = gsap.timeline({
      onComplete: () => {
        resultsContent.hidden = true;
        gsap.set([heroGroup, usernameChipsEl, chipsAndStartover, barRow, resultsContent], { clearProps: "all" });
        gsap.set(startOverBtn, { opacity: 0 });
        resolve();
      },
    });

    // The movie content starts fading out first.
    transitionTimeline.to(resultsContent, { opacity: 0, duration: RESULTS_FADE_OUT_DURATION }, 0);

    // 1. #hero-group transitions back to its starting position.
    transitionTimeline.fromTo(
      heroGroup,
      { y: heroDy },
      { y: 0, duration: HERO_SLIDE_DURATION, ease: HERO_SLIDE_EASE },
      0
    );

    // 2. #username-bar-row fades in.
    transitionTimeline.to(barRow, { opacity: 1, duration: BAR_FADE_IN_DURATION }, BAR_FADE_IN_START);

    // 3. #chips-and-startover moves down to return to its starting position.
    transitionTimeline.to(chipsAndStartover, { y: 0, duration: CHIPS_AND_STARTOVER_RETURN_DURATION }, 0);

    // 4. #username-chips returns to its 1 scale.
    transitionTimeline.fromTo(
      usernameChipsEl,
      { scale: CHIPS_SCALE_UP },
      { scale: 1, duration: CHIPS_SCALE_RETURN_DURATION },
      0
    );

    // 5. #username-chips returns to its left-aligned position on the x-axis.
    transitionTimeline.fromTo(usernameChipsEl, { x: chipsDx }, { x: 0, duration: CHIPS_UNCENTER_DURATION }, 0);

    // 6. #start-over-btn fades out.
    transitionTimeline.to(startOverBtn, { opacity: 0, duration: START_OVER_FADE_OUT_DURATION }, 0);

    // 7. #username-chips fades out.
    transitionTimeline.fromTo(usernameChipsEl, { opacity: 1 }, { opacity: 0, duration: CHIPS_FADE_OUT_DURATION }, 0);
  });
}

// --- Username chip input --------------------------------------------------

const usernameInput = document.getElementById("username-input");
const usernameChipsEl = document.getElementById("username-chips");
const submitBtn = document.getElementById("submit-btn");
const form = document.getElementById("matcher-form");
const startOverBtn = document.getElementById("start-over-btn");

let enteredUsernames = [];

function hasUsername(name) {
  const key = name.toLowerCase();
  return enteredUsernames.some((u) => u.toLowerCase() === key);
}

// Appends just the one new chip (rather than re-rendering the whole list)
// so its CSS entrance animation plays once, without replaying on chips
// that already exist.
function addUsername(rawName) {
  const name = rawName.trim();
  if (!name || hasUsername(name)) return;
  enteredUsernames.push(name);
  usernameChipsEl.appendChild(createUsernameChip(name));
  updateSubmitState();
}

// Chips are always the same persistent set (input-editable and
// results-readonly are now just two visual modes of #hero-group, not
// separate elements) — the remove button is always present, and CSS just
// hides it once #hero-group is in results-mode.
function createUsernameChip(name) {
  const chip = document.createElement("span");
  chip.className = "username-chip chip-enter";

  const label = document.createElement("span");
  label.textContent = `@${name}`;
  chip.appendChild(label);

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "chip-remove";
  removeBtn.textContent = "×";
  removeBtn.setAttribute("aria-label", `Remove @${name}`);
  removeBtn.addEventListener("click", () => {
    enteredUsernames = enteredUsernames.filter((u) => u !== name);
    updateSubmitState();
    removeChipWithAnimation(chip, usernameChipsEl);
  });
  chip.appendChild(removeBtn);

  return chip;
}

// Fades the removed chip out in place first (its neighbors don't move yet —
// the space is still reserved), then removes it and animates the remaining
// chips sliding left/up to fill the gap (the FLIP technique: capture
// positions before the DOM change, apply them as an inverted transform right
// after, then transition that transform back to zero).
function removeChipWithAnimation(chip, container) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    chip.remove();
    return;
  }

  chip.classList.add("chip-removing");

  setTimeout(() => {
    const siblings = [...container.querySelectorAll(".username-chip")].filter((el) => el !== chip);
    const firstRects = new Map(siblings.map((el) => [el, el.getBoundingClientRect()]));

    chip.remove();

    for (const el of siblings) {
      const first = firstRects.get(el);
      const last = el.getBoundingClientRect();
      const dx = first.left - last.left;
      const dy = first.top - last.top;
      if (!dx && !dy) continue;

      // Web Animations API instead of a manual transition: it takes explicit
      // from/to keyframes directly, so there's no dependency on the browser
      // having painted an intermediate style before the "real" transition
      // starts (which plain CSS transitions need, and is easy to race).
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }], {
        duration: CHIP_SLIDE_MS,
        easing: "ease",
      });
    }
  }, CHIP_FADE_MS);
}

function updateSubmitState() {
  submitBtn.disabled = enteredUsernames.length < MIN_USERNAMES;
}

function commitPendingInput() {
  if (usernameInput.value.trim()) {
    addUsername(usernameInput.value);
    usernameInput.value = "";
  }
}

// A space commits the token before it into a chip (typing one name at a
// time); pasting several space-separated names at once works the same way,
// committing every complete token and leaving any trailing partial one (no
// following space yet) in the box for continued editing.
usernameInput.addEventListener("input", () => {
  const value = usernameInput.value;
  if (!/\s/.test(value)) return;
  const endsWithSpace = /\s$/.test(value);
  const tokens = value.split(/\s+/).filter(Boolean);
  const toCommit = endsWithSpace ? tokens : tokens.slice(0, -1);
  const remainder = endsWithSpace ? "" : tokens[tokens.length - 1] || "";
  toCommit.forEach(addUsername);
  usernameInput.value = remainder;
});

usernameInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    commitPendingInput();
  }
});

// --- Submit orchestration -----------------------------------------------

let currentRunId = 0;

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  commitPendingInput();
  if (enteredUsernames.length < MIN_USERNAMES) return;

  const usernames = enteredUsernames.slice();
  const runId = ++currentRunId;

  submitBtn.disabled = true; // guard against double-submit while the transition is still playing
  playTransitionToResults();
  document.getElementById("results").innerHTML = "";
  renderErrorSummary([]);
  showStatus("Fetching watchlists…");

  try {
    const { ok, errors } = await fetchAllWatchlists(usernames, (msg) => {
      if (runId === currentRunId) showStatus(msg);
    });
    if (runId !== currentRunId) return; // superseded by a new search or Start Over

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
      await fetchFilmDetailsWithConcurrency(ranked, FILM_DETAILS_CONCURRENCY, (done, total) => {
        if (runId === currentRunId) showStatus(`Fetching film details (${done}/${total})…`);
      });
      if (runId !== currentRunId) return;
    }

    showStatus(null);
    renderResultsGrid(ranked, ok.length, userAvatars);
    renderErrorSummary(errors);
  } catch (err) {
    if (runId !== currentRunId) return;
    showStatus(null);
    renderErrorSummary([{ username: "", error: err }]);
  }
});

startOverBtn.addEventListener("click", async () => {
  currentRunId++; // invalidate any in-flight fetch from the previous run

  renderErrorSummary([]);
  showStatus(null);

  // Play the reverse transition against the CURRENT chips first — clearing
  // them before this would leave the animation with an empty, collapsed
  // container to animate (and no visible "before" position to measure).
  await showInputScreen();

  enteredUsernames = [];
  usernameChipsEl.innerHTML = "";
  updateSubmitState();
  usernameInput.value = "";
  document.getElementById("results").innerHTML = "";
  usernameInput.focus();
});

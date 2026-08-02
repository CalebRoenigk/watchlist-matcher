# Letterboxd Watchlist Matcher

Enter a few Letterboxd usernames and see which movies show up on more than
one of their watchlists — ranked so movies shared by *everyone* you entered
come first, then movies shared by fewer, down to (but excluding) movies only
one account has.

Live example question this answers: "my friends and I all have Letterboxd —
what should we actually watch together?"

## How it works

Letterboxd has no public API, so this scrapes public watchlist pages
directly. It's two pieces:

```
Browser (static site: index.html / style.css / app.js)
   │  fetch(WORKER_URL + "/<user>/watchlist/page/N/")
   ▼
Cloudflare Worker (worker/worker.js) — dumb proxy
   │  fetches letterboxd.com server-side (no CORS restriction there),
   │  returns the response with CORS headers added
   ▼
letterboxd.com
```

- **The site is 100% static** (`index.html`, `style.css`, `app.js` — no
  build step, no framework) so it can be hosted on GitHub Pages for free.
- Browsers block cross-origin requests to `letterboxd.com` from a GitHub
  Pages page (it sends no CORS headers), so a tiny **Cloudflare Worker**
  fetches those pages on the site's behalf and adds CORS headers to the
  response. The Worker does no HTML parsing — it just proxies, and only for
  a small allowlist of Letterboxd URL shapes (so it can't be used as an open
  relay to other sites). All the actual parsing (pagination, matching
  movies across accounts, poster art) happens client-side in `app.js`.
- Poster art comes from each shared film's own Letterboxd page
  (`og:image` meta tag) — fetched only for the movies that actually end up
  in the results, not the full watchlists.

## Setup

### 1. Deploy the Worker

```bash
cd worker
npm install
npx wrangler login      # one-time, opens a browser to authorize a free Cloudflare account
npx wrangler deploy
```

This prints a URL like `https://watchlist-matcher-proxy.<your-subdomain>.workers.dev`.

### 2. Point the frontend at it

Open [app.js](app.js) and replace the placeholder at the top:

```js
const WORKER_BASE_URL =
  location.hostname === "localhost" || location.hostname === "127.0.0.1"
    ? "http://localhost:8787"
    : "https://REPLACE-WITH-YOUR-WORKER-SUBDOMAIN.workers.dev"; // <- edit this
```

### 3. Enable GitHub Pages

Push this repo to GitHub, then in **Settings → Pages**, set
**Deploy from branch** → `main` / `/ (root)`. Your site will be live at
`https://<you>.github.io/<repo>/`.

## Local development

```bash
# Terminal 1 — run the Worker locally
cd worker
npm install
npx wrangler dev

# Terminal 2 — serve the static site
npx serve .          # or: python3 -m http.server 8000
```

Open the site via `http://localhost:<port>` (not `file://`) —
`app.js` auto-detects `localhost` and points at `http://localhost:8787`
without needing any edits.

## Limitations

- Only works for **public** Letterboxd watchlists.
- Large watchlists take a while — pages are fetched one at a time per
  account with a short delay between requests, out of courtesy to
  Letterboxd. Accounts are fetched concurrently with each other.
- Watchlists beyond 60 pages (~1,680 films) are truncated, with a note
  shown in the status log.
- Not affiliated with Letterboxd. This is a small personal tool, not built
  for heavy or bulk use — please be considerate with how many accounts and
  how often you run it.

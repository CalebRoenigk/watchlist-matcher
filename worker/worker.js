// Minimal CORS-bypassing proxy for the Letterboxd Watchlist Matcher static site.
//
// The frontend (a static GitHub Pages site) cannot fetch letterboxd.com directly
// because letterboxd.com sends no Access-Control-Allow-Origin header. This Worker
// fetches on the frontend's behalf and adds CORS headers to the response.
//
// It deliberately does NOT parse HTML - it only proxies. Path shapes are restricted
// to a small allowlist so this can't be abused as an open relay to arbitrary sites.

const UPSTREAM_ORIGIN = "https://letterboxd.com";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36";

const ALLOWED_PATH_PATTERNS = [
  /^\/[\w.\-]{1,64}\/watchlist\/$/,
  /^\/[\w.\-]{1,64}\/watchlist\/page\/\d{1,4}\/$/,
  /^\/film\/[\w\-]{1,200}\/$/,
];

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
};

function isAllowedPath(pathname) {
  return ALLOWED_PATH_PATTERNS.some((pattern) => pattern.test(pathname));
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method !== "GET") {
      return new Response("Method not allowed", {
        status: 405,
        headers: CORS_HEADERS,
      });
    }

    const url = new URL(request.url);

    if (!isAllowedPath(url.pathname)) {
      return new Response("Not found", { status: 404, headers: CORS_HEADERS });
    }

    let upstreamResponse;
    try {
      upstreamResponse = await fetch(UPSTREAM_ORIGIN + url.pathname, {
        headers: { "User-Agent": USER_AGENT },
      });
    } catch (err) {
      return new Response("Upstream fetch failed: " + err.message, {
        status: 502,
        headers: CORS_HEADERS,
      });
    }

    const headers = new Headers(CORS_HEADERS);
    const contentType = upstreamResponse.headers.get("Content-Type");
    if (contentType) headers.set("Content-Type", contentType);

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      headers,
    });
  },
};

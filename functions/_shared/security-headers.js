// Security headers for every response Cloudflare Pages Functions generates.
// A static _headers file doesn't apply to Function-generated responses (only
// to static asset responses), so this is applied in code via
// functions/_middleware.js instead. See docs/cloudflare-dashboard-setup.md
// and README.md for background.
//
// The CSP below is duplicated in ../../_headers for static asset responses.
// There's no build step in this project to generate one from the other, so
// keep the two in sync by hand when either changes — see README.md's
// "Security headers" section.
//
// CSP notes:
// - script-src/style-src allow https://unpkg.com: Leaflet's JS/CSS are
//   loaded from there (index.html, sw.js APP_SHELL_URLS).
// - style-src needs 'unsafe-inline': Leaflet positions markers/panes via
//   inline `style` attributes at runtime (L.DomUtil.setPosition etc).
// - img-src allows https://*.tile.openstreetmap.org: the Leaflet base map
//   tile layer (app.js) uses https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png.
// - connect-src is 'self' only: after this stage the browser only calls
//   same-origin /api/geocode and /api/route, never Nominatim/OSRM directly.
// - worker-src 'self' covers the service worker script itself.
const CSP =
  "default-src 'self'; script-src 'self' https://unpkg.com; style-src 'self' https://unpkg.com 'unsafe-inline'; img-src 'self' data: https://*.tile.openstreetmap.org; connect-src 'self'; worker-src 'self'; manifest-src 'self'; base-uri 'none'; frame-ancestors 'none';";

export function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", CSP);
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

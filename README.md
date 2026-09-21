# Back to Lincolnshire

**The Yellow Belly Alarm**

A public, installable single-page web app that tells you how long it will
take to drive back across the Lincolnshire county border, with a deadline
countdown, alarm, and abuse protection for the free APIs it relies on.

("Yellow Belly" is the traditional nickname for a Lincolnshire native.)

## What it does

- Locates you (browser geolocation, or a typed address/place name) and
  checks whether you're already inside the Lincolnshire boundary.
- If you're outside, routes you to the nearest real road crossing into the
  county (A1, A52, A17, A16, A46, A57, A15, A6121, and the Humber Bridge
  approach) and shows the fastest option plus two alternatives.
- Lets you set a target arrival time (with an optional safety buffer) and
  shows a live countdown, turning amber near the deadline and red — with a
  notification and audible alarm — if you won't make it in time.
- Installs to a phone home screen as a PWA, works offline with a
  last-known-result view, and keeps the screen awake during an active
  countdown.

This repo is being built in stages (see `back-to-lincolnshire-brief.md` for
the full build brief); the app code lands in later commits.

See [`docs/architecture.md`](docs/architecture.md) for the non-obvious "why"
behind a few design decisions (the crossing-verification method, local sunset
calculation, duplicated CSP, and the rate limiter's fail-open behavior).

## Local development

This is a static site with no build step. Once the app code exists
(`index.html`, `app.js`, `styles.css`, `manifest.webmanifest`, `sw.js`),
serve the repo root with any static file server, e.g.:

```sh
npx serve .
# or
python3 -m http.server 8000
```

Then open the printed local URL in a browser. A service worker is involved,
so use `localhost` (not `file://`) and a hard refresh when testing changes.

## API dependencies and usage limits

- **[Nominatim](https://nominatim.org/release-docs/latest/api/Overview/)**
  (OpenStreetMap) — geocodes typed addresses/place names into coordinates.
  Free, but the [usage policy](https://operations.osmfoundation.org/policies/nominatim/)
  caps requests at **1 request/second**, requires a valid
  `User-Agent`/`Referer` identifying the app, and prohibits auto-complete-style
  bulk querying. This app debounces input and caches results client- and
  server-side to stay well within that limit. The browser no longer calls
  Nominatim directly — requests go through the same-origin `/api/geocode`
  Pages Function, which sets a proper `User-Agent` identifying the app plus a
  contact address (from the `NOMINATIM_CONTACT` environment variable — see
  `docs/cloudflare-dashboard-setup.md`). Before this stage, the browser
  identified itself via the automatically-sent `Referer` header only (an
  accepted alternative per Nominatim's policy, but weaker than a proper
  `User-Agent`); that interim approach is superseded now that requests are
  proxied.
- **[OSRM demo server](http://project-osrm.org/)** — computes driving routes
  and durations to candidate border crossings. The public demo server is for
  light, non-commercial use only and has no documented hard rate limit, but
  is throttled and can reject heavy traffic without notice. This app limits
  the number of candidate crossings routed per request and caches results.
  The browser no longer calls OSRM directly — requests go through the
  same-origin `/api/route` Pages Function.

Both are proxied through Cloudflare Pages Functions (`/api/geocode`,
`/api/route`) so the browser never calls them directly, and both are
rate-limited per-IP and cached in Cloudflare KV to protect the upstream free
services from abuse. Per-IP rate limiting is backed by a Durable Object
hosted in a separate Worker (`worker/rate-limiter/` — a second deployable
component of this repo, alongside the Pages project); see
`docs/cloudflare-dashboard-setup.md` for the manual dashboard steps needed to
wire all of this up (Durable Object binding, KV namespace, environment
variables, and outer-layer protections like WAF rate limiting rules and Bot
Fight Mode).

## Deployment

Deployed to [Cloudflare Pages](https://pages.cloudflare.com/) at
**backtolincolnshire.co.uk** (the apex is the canonical host; the site's
canonical link, `sitemap.xml` and `robots.txt` all use it), connected to this
GitHub repo for automatic deploys on every push to `main`.
`www.backtolincolnshire.co.uk` is meant to 301-redirect to the apex via a
Cloudflare redirect rule configured in the dashboard, not in this repo.

To connect it:

1. In the Cloudflare dashboard, go to **Workers & Pages → Create → Pages →
   Connect to Git**, and select this repository.
2. Framework preset: **None**. Build command: *(leave blank — no build
   step)*. Build output directory: `/` (repo root).
3. Add the custom domain `backtolincolnshire.co.uk` (the apex) under the
   project's **Custom domains** tab and follow the DNS instructions
   (Cloudflare manages DNS automatically if the domain is already on
   Cloudflare). Add `www.backtolincolnshire.co.uk` only for the redirect to
   the apex.
4. Every push to `main` triggers an automatic production deploy; other
   branches and PRs get preview deploys.
5. Set the required environment variables and bindings (Durable Object, KV
   namespace, `NOMINATIM_CONTACT`) in the Pages project's **Settings →
   Bindings**/**Environment variables** tabs, and deploy the separate
   `worker/rate-limiter/` Worker it depends on — see
   [`docs/cloudflare-dashboard-setup.md`](docs/cloudflare-dashboard-setup.md)
   for the full step-by-step.

## Security headers

The Content-Security-Policy and related security headers are defined in two
places, and there's no build step to generate one from the other:

- [`_headers`](_headers) — applies to static asset responses only (Cloudflare
  Pages reads this file directly).
- [`functions/_shared/security-headers.js`](functions/_shared/security-headers.js)
  — applies to responses generated by Pages Functions (everything under
  `/api/*`), since a static `_headers` file doesn't cover those.

When changing the CSP (e.g. adding a new external domain), update both files.

## License

MIT — see [LICENSE](LICENSE).

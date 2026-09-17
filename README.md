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
  server-side to stay well within that limit. Until the Stage 6 proxy exists,
  the browser identifies itself to Nominatim via the automatically-sent
  `Referer` header only (per Nominatim's policy, this is an accepted
  alternative to a custom `User-Agent`, which client-side JavaScript cannot
  set) — a dedicated contact address will be added as a proper `User-Agent`
  header in the Stage 6 Pages Function.
- **[OSRM demo server](http://project-osrm.org/)** — computes driving routes
  and durations to candidate border crossings. The public demo server is for
  light, non-commercial use only and has no documented hard rate limit, but
  is throttled and can reject heavy traffic without notice. This app limits
  the number of candidate crossings routed per request and caches results.

Both are proxied through a Cloudflare Pages Function (Stage 6) so the
browser never calls them directly, and both are rate-limited per-IP and
cached in Cloudflare KV to protect the upstream free services from abuse.

## Deployment

Deployed to [Cloudflare Pages](https://pages.cloudflare.com/) at
**www.backtolincolnshire.co.uk**, connected to this GitHub repo for
automatic deploys on every push to `main`.

To connect it:

1. In the Cloudflare dashboard, go to **Workers & Pages → Create → Pages →
   Connect to Git**, and select this repository.
2. Framework preset: **None**. Build command: *(leave blank — no build
   step)*. Build output directory: `/` (repo root).
3. Add the custom domain `www.backtolincolnshire.co.uk` under the project's
   **Custom domains** tab and follow the DNS instructions (Cloudflare
   manages DNS automatically if the domain is already on Cloudflare).
4. Every push to `main` triggers an automatic production deploy; other
   branches and PRs get preview deploys.
5. From Stage 6 onward, set any required environment variables/bindings
   (KV namespace for rate limiting and caching) in the Pages project's
   **Settings → Functions** tab.

## License

MIT — see [LICENSE](LICENSE).

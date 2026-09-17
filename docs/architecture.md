# Architecture notes

Things a future session would need to know and can't infer from reading the
code cold. See the README and `docs/cloudflare-dashboard-setup.md` for
everything else (deployment, environment variables, API usage limits).

## Why crossings use a settlement-reaching network test

`data/crossings.json` decides which road crossings count as genuinely leaving
Lincolnshire by requesting a real OSRM driving route from each crossing to a
nearby real settlement solidly inside the boundary, then checking the route
stays inside the boundary the whole way there (sampled along OSRM's actual
path, not a straight bearing). A crossing only qualifies if it reaches a
populated place within ~10km without leaving the boundary first.

An earlier approach checked OSM ref-tagging continuity instead (how far the
same road ref, e.g. "A52", continues before a gap). That answered the wrong
question: it measured tagging continuity, not geography, and its result
depended on incidental tagging gaps and which recursive branch a hop search
happened to prefer — the same geometry gave wildly different answers (11.1km
→ 1.6km → 22.2km) across passes. The network-based test is what "a sliver you
drive straight through" actually means, versus "reaches a real town, then
dips out of the boundary again further down the road" (which should count as
a real crossing). See commit `974f5e4` for the full before/after reasoning
and the specific crossings (A6121, A180) that motivated the change. This was
a one-off analysis, not a re-runnable script — the verified result is baked
directly into `data/crossings.json`; re-verifying a crossing means re-running
the same OSRM-based check by hand, not `npm run`-ing something.

## Why sunset is computed locally, not via an API

`deadline.js`'s `getSunsetUtc` is a sunset-only port of SunCalc's algorithm,
run entirely client-side, rather than a call to a sunset API — so the Sunset
deadline preset still works offline (the app's whole PWA/service-worker
premise), with no third-party dependency or rate limit on the hot path.
Verified against the US Naval Observatory's official sun data for Lincoln
across both solstices and both equinoxes (within 30s in every case) — see the
`getSunsetUtc` checks in `scripts/test-deadline-state.mjs`.

## Why CSP is duplicated across two files

`_headers` and `functions/_shared/security-headers.js` both define the same
Content-Security-Policy. `_headers` only applies to static asset responses
(Cloudflare Pages reads it directly); Pages Functions responses (`/api/*`)
aren't covered by it, so `security-headers.js` applies the same headers in
code instead. There's no build step in this project to generate one from the
other, so **when changing the CSP, update both files by hand.**

## The rate limiter fails open

`functions/_shared/rate-limit.js`'s `checkRateLimit` prefers Cloudflare's
native Rate Limiting binding (`env.RATE_LIMITER`), falls back to the
`RATE_LIMITER_DO` Durable Object binding, and — if **neither** binding is
configured — returns `true` (i.e. allows the request) rather than blocking
it. This is deliberate for local dev and preview deploys where the DO worker
isn't running, but it means a production deploy that skips the
`RATE_LIMITER_DO` binding setup (`docs/cloudflare-dashboard-setup.md` step 2)
silently runs with **no rate limiting at all**, not a broken one. Both
`/api/geocode` and `/api/route` depend on this; check that the binding is
actually configured before trusting production rate limits.

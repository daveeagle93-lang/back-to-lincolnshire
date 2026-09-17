# back-to-lincolnshire-rate-limiter

A standalone Cloudflare Worker hosting the `RateLimiterDO` Durable Object
class used by the main Pages project's `/api/geocode` and `/api/route`
Functions. Durable Objects can't be created and deployed from within a Pages
project, so this lives here as its own deployable.

Deploy it with `wrangler deploy` from this directory (`worker/rate-limiter/`)
*before* configuring the Pages project's Durable Object binding — see
`docs/cloudflare-dashboard-setup.md` in the repo root for the dashboard step
that binds this Worker's `RateLimiterDO` class to the Pages project.

# Cloudflare dashboard setup (Stage 6)

Manual, dashboard-only steps needed to make the `/api/geocode` and
`/api/route` proxy Functions work in production. These are one-off setup
steps, not part of the automatic Git-push deploy described in the README's
Deployment section — do them in order.

## 1. Deploy the rate-limiter Worker

The per-IP rate limiter's Durable Object can't be deployed from within the
Pages project (Cloudflare Pages doesn't support creating/deploying Durable
Objects directly — see `worker/rate-limiter/README.md`). Deploy it first, as
its own separate Worker:

```sh
cd worker/rate-limiter
wrangler deploy
```

This must happen before step 2, since step 2 binds to the class it deploys.

## 2. Bind the Durable Object to the Pages project

In the main Pages project's dashboard: **Settings → Bindings → Add →
Durable Object**.

- Variable name: `RATE_LIMITER_DO`
- Durable Object namespace: the `back-to-lincolnshire-rate-limiter` Worker's
  `RateLimiterDO` class (deployed in step 1).

## 3. Create and bind the KV cache namespace

Create a KV namespace (dashboard: **Workers & Pages → KV → Create namespace**,
or `wrangler kv namespace create RESPONSE_CACHE`), then bind it to the Pages
project: **Settings → Bindings → Add → KV namespace**, variable name
`RESPONSE_CACHE`.

## 4. Set the NOMINATIM_CONTACT environment variable

**Settings → Environment variables** → add `NOMINATIM_CONTACT`, set to a real
contact address or URL (e.g. a mailto: address or a page describing the app).

This is now the *server-side* identification sent in the `User-Agent` header
on every Nominatim request from `/api/geocode` — it supersedes the
Referer-only approach used before this stage (see README's "API dependencies
and usage limits" section). The code falls back to a placeholder string if
this variable is unset, but that fallback exists only so local
dev/preview deploys don't hard-fail — a real value must be set before
production traffic, per Nominatim's usage policy.

## 5. WAF Rate Limiting Rules (outer layer)

The per-IP limiting built into `/api/geocode` and `/api/route` (steps 1-2) is
an application-level layer. Cloudflare's dashboard-native **WAF → Rate
limiting rules** product is a separate, outer layer worth adding on top of
it, e.g. as protection against traffic patterns the application layer
doesn't see (before it even reaches a Function invocation).

Find it under **Security → WAF → Rate limiting rules** on the Pages project
(or zone, if applicable) in the dashboard. A reasonable starting point is a
rule matching path `/api/*`, but exact thresholds are a judgment call for the
site owner to tune post-launch based on real traffic.

## 6. Bot Fight Mode

Under **Security → Bots**, enable **Bot Fight Mode**. At a high level, this
challenges/blocks traffic Cloudflare identifies as automated (bots, scrapers)
before it reaches the app — another outer layer alongside step 5, independent
of this stage's own rate limiting.

## 7. Custom domain

Connecting the custom domain (the apex `backtolincolnshire.co.uk`, with www
301-redirected to it) is covered in the README's
[Deployment](../README.md#deployment) section — nothing specific to this
stage changes that process; it's referenced here only so this document's
step list is complete.

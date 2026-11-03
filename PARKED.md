# PARKED (2026-11-03)

Parked by owner decision until the blockers below clear. Source: `~/vaults/aerie-technology/05-Engineering/loops/back-to-lincolnshire.md` (audit 2026-11-01).

## What it is
"Yellow Belly Alarm": an installable PWA that routes you back to the nearest road crossing into Lincolnshire, with a deadline countdown/alarm.
Static site (vanilla JS, `sw.js`, vendored Leaflet), Cloudflare Pages Functions + KV, and a Durable Object rate limiter Worker in `worker/rate-limiter/`.

## Current state
- Shipped: brief Stages 0-6; README says live at backtolincolnshire.co.uk. HSTS set to `max-age=86400`. Monitoring: GH Actions `check-live.yml` plus a daily systemd user timer on tower-dev with ntfy alert. Last commit `3050a7b` (2026-09-22).
- Not done: HSTS raise to one year; monitoring hardening (no dead-man's switch on the timer, Node-20-targeted `@v4` actions); self-hosted/paid OSRM. Whether the ntfy alert reached a phone is unconfirmed.
- No TODO/FIXME markers. No unit-test files beyond the two gate scripts.

## Gate (run 2026-11-03)
| Command | Result |
|---|---|
| `node scripts/test-deadline-state.mjs` | PASS (all checks passed) |
| `node scripts/verify-boundaries.mjs` | PASS (exit 0) |
| `npm run check-live` | NOT RUN (hits production; no network allowed) |

## Blockers: David must do to unpark
- [ ] Approve raising HSTS to `31536000` on the live domain (hard to back out for browsers that cached it; back-out is `max-age=0`). Set 2026-09-21; judge whether it has been "stable for a few weeks"
- [ ] Confirm the ntfy alert actually reached your phone (notes say only the server accepted it)

## Open decisions
- Add `includeSubDomains`/`preload` later? Not planned in docs.
- Self-hosted OSRM (Hetzner box in the brief) or a paid routing provider? Only needed if traffic has grown (not verified).
- Cloudflare dashboard changes (WAF, redirects, bindings) are manual and outside the repo.

## First loopable stage once unblocked
Raise HSTS to one year. Done when `_headers` and `functions/_shared/security-headers.js` both carry `max-age=31536000` (no includeSubDomains/preload), `docs/architecture.md` is updated, and `npm run check-live` passes after deploy.
Then: monitoring hardening (heartbeat for the tower-dev timer, bump `checkout`/`setup-node` actions, assert favicon Content-Type in `check-live`).

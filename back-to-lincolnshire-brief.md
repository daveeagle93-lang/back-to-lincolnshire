# Back to Lincolnshire — Build Brief

A public, installable single-page web app (deployed to Cloudflare Pages) that tells a
user how long it will take to drive back across the Lincolnshire county border,
with a deadline alarm and abuse protection.

- **Product name:** Back to Lincolnshire
- **Tagline:** The Yellow Belly Alarm ("Yellow Belly" is the traditional nickname
  for a Lincolnshire native)
- **Domain:** backtolincolnshire.co.uk (canonical; www 301-redirects to it)
- **Repo:** GitHub, deployed via Cloudflare Pages Git integration

---

## Master prompt (paste into a fresh Claude Code session)

Build a public, installable single-page web app called "Back to Lincolnshire", with
the tagline "The Yellow Belly Alarm", deployed to Cloudflare Pages at
backtolincolnshire.co.uk. It tells a visitor how long it will take to drive back
across the Lincolnshire county border, lets them set an arrival deadline with a
countdown and alarm, installs to a phone home screen as a PWA, and is protected
against abuse of the free APIs it relies on. Build it in the stages below, committing
after each stage.

### Stage 0 — Repo setup
- Initialise a git repo with a sensible .gitignore (node_modules, .env, .wrangler,
  .DS_Store, dist).
- Add a README covering what the app does, local dev instructions, the API
  dependencies and their usage limits, and deployment steps.
- Add an MIT LICENSE file.
- Make an initial commit, then a clean, descriptive commit after each stage below.
- Create the GitHub repo and push, then document connecting it to Cloudflare Pages
  for automatic deploys on push to main.

### Stage 1 — Core routing
- Static site, no build step, Cloudflare Pages friendly. Keep the app in index.html
  with separate app.js, styles.css, manifest.webmanifest and sw.js files so the
  service worker and manifest can be cached properly.
- On load, offer a "Use my location" button (browser Geolocation API) plus a text
  input where the user can type an address or place name instead.
- Geocode typed addresses using the free Nominatim OpenStreetMap API.
- Store the Lincolnshire boundary as GeoJSON (fetch the administrative/ceremonial
  boundary polygon from a public source, or embed a simplified polygon).
- If the user is already inside the polygon, say "You're already in Lincolnshire."
- If outside, compute the fastest driving route back (see Stage 2) and display
  time and distance clearly.
- Clean, mobile-first UI with a small Leaflet map showing a marker and the route.

### Stage 2 — Real crossings & quickest route
- Define a hardcoded list of major road crossings into Lincolnshire, each with a
  name and coordinates. Include crossings on the A1, A52, A17, A16, A46, A57, A15
  and A6121, plus the Humber Bridge approach for the north.
- When the user is outside Lincolnshire, run OSRM routing to several of the nearest
  crossing points, not just one.
- Pick the crossing with the shortest driving time and display it, showing the
  crossing name, e.g. "Fastest route back: A52 near Grantham, about 22 minutes."
- List the next two fastest alternatives underneath.

### Stage 3 — Deadline alarm
- Add a time input for a target arrival time, defaulting to 3pm today.
- Compare projected arrival (now + fastest driving time) against the target.
- Show a live countdown to the deadline, updating every second.
- Recalculate the route every two minutes so the estimate stays current, re-fetching
  location each time.
- Comfortably early: green "You'll make it, with N minutes to spare."
- Within ten minutes of the deadline: amber warning.
- Projected arrival after target: red "You won't make it, leave now" alert, plus a
  browser notification and an audible alarm.
- Request notification permission up front.
- Include a configurable buffer so the effective deadline can be set a few minutes
  earlier than the target (e.g. treat 2:50 as the real cut-off).
- Persist the user's chosen deadline and buffer in localStorage so it survives a
  reload or app relaunch.

### Stage 4 — PWA & mobile
- Add a web app manifest (manifest.webmanifest) with name "Back to Lincolnshire",
  short_name "Back to Lincs", the tagline as the description, display "standalone",
  a portrait orientation lock, theme and background colours, and a start_url of "/".
- Generate and include icons at 192x192, 512x512 and a 512x512 maskable variant,
  plus an apple-touch-icon. Use a simple, bold mark that reads well small.
- Add a service worker (sw.js) that precaches the app shell (HTML, CSS, JS, icons,
  Leaflet assets, boundary GeoJSON) for offline launch. Use a network-first strategy
  for routing and geocoding requests with a cached fallback, and a cache-versioning
  scheme so updates roll out cleanly.
- Show an offline state that still renders the UI and last-known result, with a clear
  "you're offline, this estimate may be stale" banner.
- Add an "Add to Home Screen" prompt: capture the beforeinstallprompt event on
  Android/Chrome and show a custom install button; show iOS-specific instructions
  (Share, then Add to Home Screen) since Safari doesn't fire that event.
- Mobile-first layout: large tap targets, safe-area insets for notched devices, no
  horizontal scroll, readable type without zooming, and a viewport meta tag with
  viewport-fit=cover.
- Keep the screen awake during an active countdown using the Screen Wake Lock API
  where supported, with a graceful fallback.
- Verify it passes a Lighthouse PWA audit and is installable on both Android and iOS.

### Stage 5 — Public-ready
- Brief intro line explaining the tool, framed generically for any visitor
  (e.g. "Are you making it back to Lincolnshire in time?").
- Handle all failure cases gracefully: geolocation denied, geocoding no results,
  routing unavailable, offline. Friendly messages, never a blank screen or console error.
- Debounce address input and cache geocoding results to respect Nominatim's usage
  policy; set a proper user-agent/contact per their terms.
- Respect OSRM demo-server rate limits; add light throttling and a fallback message.
- Meta tags: title "Back to Lincolnshire", description, and Open Graph / Twitter card
  tags with "The Yellow Belly Alarm" as the tagline in the header and social preview.

### Stage 6 — Security & rate limiting
- Add a Cloudflare Pages Function that proxies all geocoding and routing requests,
  so the browser never calls Nominatim or OSRM directly.
- Enforce per-IP rate limiting in the Function using Cloudflare KV or a Durable
  Object (e.g. 30 requests/minute/IP), returning 429 when exceeded.
- Cache geocoding and routing responses in KV with a sensible TTL to cut upstream calls.
- Validate and sanitise all input: coordinates within valid ranges, address strings
  length-capped, reject malformed requests.
- Set the required Nominatim user-agent/contact server-side.
- Add security headers: Content-Security-Policy, X-Frame-Options, Referrer-Policy.
  Make sure the CSP allows the service worker and Leaflet's tile sources.
- Document enabling Cloudflare's built-in rate-limiting rules and bot-fight mode in
  the dashboard as the outer DDoS layer.

---

## Notes & caveats
- "Nearest point on the border" is not always a real road crossing, which is why
  Stage 2 routes to actual crossing points instead.
- Free Nominatim and OSRM demo servers are fine for light public traffic but ban
  heavy use. If it takes off, move routing to a paid provider or self-host OSRM
  (e.g. on the Hetzner box).
- iOS PWAs have limited background and notification support. The alarm fires reliably
  only while the app is open, so lean on the wake lock and an on-screen countdown
  rather than assuming a backgrounded notification will land.
- A service worker plus an app that must show live routing data is a caching trap:
  never let the SW serve a stale route as if it were fresh.

## Possible next steps
- Prompt for setting up the KV namespace and wiring environment variables.
- Prompt for self-hosting OSRM as the scaling step.

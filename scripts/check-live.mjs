#!/usr/bin/env node
// Smoke-checks a deployed copy of the site: www/http redirects, CSP identity across
// _headers / security-headers.js / live responses, the real 404 page, HEAD on
// /api/geocode and /api/route, and the favicon files. Needs network access. Zero
// dependencies (Node's global fetch).
//
// An OSRM outage seen through /api/route (our Function's 502 with X-Upstream-Status
// "unreachable" or a 5xx) is a WARN, not a FAIL: it isn't a fault in this site. Any other
// route failure still fails.
//
// Usage: node scripts/check-live.mjs [baseUrl]   (default https://backtolincolnshire.co.uk)
// Redirect checks only run when the base URL's host is the apex.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const APEX = "backtolincolnshire.co.uk";
const DEFAULT_BASE_URL = `https://${APEX}`;
const TIMEOUT_MS = 15000;
const MAX_HOPS = 6;

let failures = 0;
let warnings = 0;

function check(label, condition, details) {
  if (condition) {
    console.log(`PASS: ${label}`);
  } else {
    console.error(`FAIL: ${label}${details ? ` — ${details}` : ""}`);
    failures += 1;
  }
}

// Like check() for a failure that isn't this site's fault: reported, but the run still passes.
function warn(label, details) {
  console.error(`WARN: ${label}${details ? ` — ${details}` : ""}`);
  warnings += 1;
}

function errorMessage(err) {
  return err && err.message ? err.message : String(err);
}

// Follows redirects hop by hop without letting fetch do it, so each status and Location
// can be asserted. Returns { hops: [{ url, status, location }], error } where error is
// set on a fetch failure, a redirect loop (a URL seen twice) or too many hops.
async function followChain(startUrl) {
  const hops = [];
  const seen = new Set();
  let url = startUrl;
  while (true) {
    if (seen.has(url)) return { hops, error: `redirect loop at ${url}` };
    if (hops.length >= MAX_HOPS) return { hops, error: `more than ${MAX_HOPS} hops` };
    seen.add(url);
    let res;
    try {
      res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      return { hops, error: `fetch of ${url} failed: ${errorMessage(err)}` };
    }
    if (res.body) await res.body.cancel().catch(() => {});
    const location = res.headers.get("location");
    hops.push({ url, status: res.status, location });
    if (res.status < 300 || res.status >= 400 || !location) return { hops, error: null };
    url = new URL(location, url).href;
  }
}

function describeChain({ hops, error }) {
  const text = hops.map((h) => `${h.status} ${h.url}${h.location ? ` -> ${h.location}` : ""}`).join("; ");
  return error ? `${text || "(no hops)"}; ${error}` : text;
}

// Fetch wrapper: resolves to { res, body, error } and never throws.
async function get(url, method = "GET") {
  try {
    const res = await fetch(url, { method, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = await res.text();
    return { res, body, error: null };
  } catch (err) {
    return { res: null, body: "", error: `${method} ${url} failed: ${errorMessage(err)}` };
  }
}

function readCspFromFiles() {
  const repoFile = (rel) => fileURLToPath(new URL(`../${rel}`, import.meta.url));
  const headersFile = readFileSync(repoFile("_headers"), "utf8");
  const sharedFile = readFileSync(repoFile("functions/_shared/security-headers.js"), "utf8");
  const fromHeaders = headersFile.match(/^\s*Content-Security-Policy:\s*(.+?)\s*$/m);
  const fromShared = sharedFile.match(/const CSP\s*=\s*"([^"]*)"/);
  return { fromHeaders: fromHeaders && fromHeaders[1], fromShared: fromShared && fromShared[1] };
}

async function checkRedirects() {
  const path = "/some/path";

  // 1. https://www -> apex, path and query preserved.
  {
    const query = "?x=1&y=two%20words";
    const expected = `https://${APEX}${path}${query}`;
    const chain = await followChain(`https://www.${APEX}${path}${query}`);
    const first = chain.hops[0];
    check(
      "https://www redirects 301 to the apex, keeping path and query",
      !chain.error && first && first.status === 301 && first.location === expected,
      describeChain(chain)
    );
  }

  // 2. http://www -> apex (expected to take 2 hops via https://www), all hops 301.
  {
    const expected = `https://${APEX}${path}?x=1&y=2`;
    const chain = await followChain(`http://www.${APEX}${path}?x=1&y=2`);
    const redirects = chain.hops.filter((h) => h.status >= 300 && h.status < 400);
    const last = chain.hops[chain.hops.length - 1];
    check(
      "http://www reaches the apex over https via 301s only, no loop",
      !chain.error && redirects.length > 0 && redirects.every((h) => h.status === 301) && last.url === expected,
      describeChain(chain)
    );
  }

  // 3. http://apex -> https://apex.
  {
    const expected = `https://${APEX}${path}?x=1`;
    const chain = await followChain(`http://${APEX}${path}?x=1`);
    const first = chain.hops[0];
    check(
      "http://apex redirects 301 to https, keeping path and query",
      first && first.status === 301 && first.location === expected,
      describeChain(chain)
    );
  }

  // 4. Root URLs: www chain lands on the apex with 200; the apex itself doesn't redirect.
  {
    const chain = await followChain(`https://www.${APEX}/`);
    const last = chain.hops[chain.hops.length - 1];
    check(
      "https://www/ ends at https://apex/ with 200",
      !chain.error && last.url === `https://${APEX}/` && last.status === 200,
      describeChain(chain)
    );
    const direct = await followChain(`https://${APEX}/`);
    check(
      "https://apex/ returns 200 with no redirects",
      !direct.error && direct.hops.length === 1 && direct.hops[0].status === 200,
      describeChain(direct)
    );
  }
}

async function checkCsp(base) {
  let csp;
  try {
    const { fromHeaders, fromShared } = readCspFromFiles();
    check("CSP found in _headers", Boolean(fromHeaders));
    check("CSP found in functions/_shared/security-headers.js", Boolean(fromShared));
    check(
      "CSP is identical in _headers and security-headers.js",
      Boolean(fromHeaders) && fromHeaders === fromShared,
      `_headers: ${fromHeaders}; security-headers.js: ${fromShared}`
    );
    csp = fromHeaders || fromShared;
  } catch (err) {
    check("read CSP from repo files", false, errorMessage(err));
    return;
  }
  if (!csp) return;

  check("CSP does not mention unpkg.com", !csp.includes("unpkg.com"), csp);

  const page = await get(`${base}/`);
  const pageCsp = page.res && page.res.headers.get("content-security-policy");
  check("live static page CSP matches the repo", pageCsp === csp, page.error || `got: ${pageCsp}`);

  const api = await get(`${base}/api/geocode`);
  const apiCsp = api.res && api.res.headers.get("content-security-policy");
  check(
    "live /api/geocode (no q) CSP matches the repo",
    apiCsp === csp,
    api.error || `status ${api.res.status}, got: ${apiCsp}`
  );
}

async function check404(base) {
  const suffix = Math.random().toString(36).slice(2, 10);
  const { res, body, error } = await get(`${base}/no-such-page-${suffix}`);
  check(
    "unknown path returns a real 404 with the friendly page",
    Boolean(res) && res.status === 404 && body.includes("wandered off the map"),
    error || `status ${res.status}, body ${body.length} bytes`
  );
}

async function checkFavicons(base) {
  for (const file of ["favicon.ico", "favicon.svg"]) {
    const { res, error } = await get(`${base}/${file}`);
    check(`GET /${file} returns 200`, Boolean(res) && res.status === 200, error || `status ${res.status}`);
  }
}

async function checkHead(base) {
  const url = `${base}/api/geocode?q=Lincoln`;

  const getResult = await get(url);
  let parsed = null;
  try {
    parsed = JSON.parse(getResult.body);
  } catch {
    // leave parsed null; reported below
  }
  check(
    "GET /api/geocode?q=Lincoln returns 200 and a JSON array",
    Boolean(getResult.res) && getResult.res.status === 200 && Array.isArray(parsed),
    getResult.error || `status ${getResult.res.status}, body starts: ${getResult.body.slice(0, 80)}`
  );

  const head = await get(url, "HEAD");
  check(
    "HEAD /api/geocode?q=Lincoln returns 200 with an empty body",
    Boolean(head.res) && head.res.status === 200 && head.body === "",
    head.error || `status ${head.res.status}, body ${head.body.length} bytes`
  );
  const contentType = head.res && head.res.headers.get("content-type");
  check(
    "HEAD /api/geocode content-type is application/json",
    Boolean(contentType) && contentType.startsWith("application/json"),
    head.error || `got: ${contentType}`
  );
  const robots = head.res && head.res.headers.get("x-robots-tag");
  check(
    "HEAD /api/geocode has X-Robots-Tag noindex",
    Boolean(robots) && robots.includes("noindex"),
    head.error || `got: ${robots}`
  );
}

// OSRM is "down" when functions/api/route.js answers 502 and its X-Upstream-Status header is
// "unreachable" (fetch threw) or a 5xx number (OSRM's own status). A 4xx number means OSRM
// rejected our request, and a 502 without the header didn't come from that code path; neither
// counts as down. Returns the header value, or null if OSRM isn't down.
function osrmDownStatus(res) {
  if (!res || res.status !== 502) return null;
  const upstream = res.headers.get("x-upstream-status");
  return /^(unreachable|5\d\d)$/.test(upstream ?? "") ? upstream : null;
}

// For failure details: shows why a 502 was or wasn't treated as OSRM being down.
function describeUpstream(res) {
  return `X-Upstream-Status: ${res.headers.get("x-upstream-status") ?? "none"}`;
}

async function checkRoute(base) {
  const url = `${base}/api/route?from=-1.1581,52.9548&to=-0.5406,53.2307`; // Nottingham -> Lincoln

  const getResult = await get(url);
  let parsed = null;
  try {
    parsed = JSON.parse(getResult.body);
  } catch {
    // leave parsed null; reported below
  }
  const getDown = osrmDownStatus(getResult.res);
  const getLabel = "GET /api/route (Nottingham -> Lincoln) returns 200 and an OSRM route";
  const getDetails =
    getResult.error ||
    `status ${getResult.res.status}, ${describeUpstream(getResult.res)}, body starts: ${getResult.body.slice(0, 80)}`;
  if (getDown) {
    warn(
      `GET /api/route (Nottingham -> Lincoln): OSRM down (X-Upstream-Status: ${getDown}), our Function answered 502`,
      getDetails
    );
  } else {
    check(
      getLabel,
      Boolean(getResult.res) &&
        getResult.res.status === 200 &&
        Boolean(parsed) &&
        parsed.code === "Ok" &&
        Array.isArray(parsed.routes) &&
        parsed.routes.length > 0 &&
        typeof parsed.routes[0].duration === "number",
      getDetails
    );
  }

  // HEAD mirrors GET's status and headers, so it is judged the same way on its own response.
  const head = await get(url, "HEAD");
  const headLabel = "HEAD /api/route (Nottingham -> Lincoln) returns 200 with an empty body";
  const headDetails =
    head.error || `status ${head.res.status}, ${describeUpstream(head.res)}, body ${head.body.length} bytes`;
  const headDown = osrmDownStatus(head.res);
  if (headDown && head.body === "") {
    warn(
      `HEAD /api/route (Nottingham -> Lincoln): OSRM down (X-Upstream-Status: ${headDown}), our Function answered 502`,
      headDetails
    );
  } else {
    check(headLabel, Boolean(head.res) && head.res.status === 200 && head.body === "", headDetails);
  }
  const contentType = head.res && head.res.headers.get("content-type");
  check(
    "HEAD /api/route content-type is application/json",
    Boolean(contentType) && contentType.startsWith("application/json"),
    head.error || `got: ${contentType}`
  );
  const robots = head.res && head.res.headers.get("x-robots-tag");
  check(
    "HEAD /api/route has X-Robots-Tag noindex",
    Boolean(robots) && robots.includes("noindex"),
    head.error || `got: ${robots}`
  );

  // No from/to: fails validation before any upstream call, so HEAD should mirror GET's 400.
  const bareGet = await get(`${base}/api/route`);
  const bareHead = await get(`${base}/api/route`, "HEAD");
  check(
    "HEAD /api/route (no from/to) returns the same status as GET, with an empty body",
    Boolean(bareGet.res) && Boolean(bareHead.res) && bareHead.res.status === bareGet.res.status && bareHead.body === "",
    bareGet.error ||
      bareHead.error ||
      `GET ${bareGet.res.status}, HEAD ${bareHead.res.status}, HEAD body ${bareHead.body.length} bytes`
  );
}

async function main() {
  const base = (process.argv[2] || DEFAULT_BASE_URL).replace(/\/+$/, "");
  let hostname;
  try {
    hostname = new URL(base).hostname;
  } catch {
    console.error(`Invalid base URL: ${base}`);
    process.exit(2);
  }
  console.log(`Checking ${base}`);

  if (hostname === APEX) {
    await checkRedirects();
  } else {
    console.log(`SKIP: redirect checks only apply to ${APEX}`);
  }
  await checkCsp(base);
  await check404(base);
  await checkFavicons(base);
  await checkHead(base);
  await checkRoute(base);

  if (failures === 0) {
    console.log(warnings === 0 ? "\nAll checks passed." : `\nAll checks passed, with ${warnings} warning(s).`);
  } else {
    console.log(`\n${failures} check(s) failed${warnings > 0 ? `, ${warnings} warning(s)` : ""}.`);
  }
  process.exit(failures === 0 ? 0 : 1);
}

main();

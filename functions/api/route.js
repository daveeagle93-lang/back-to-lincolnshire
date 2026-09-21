import { checkRateLimit } from "../_shared/rate-limit.js";
import { getCached, setCached } from "../_shared/cache.js";

const ROUTE_CACHE_TTL_SECONDS = 300; // 5 minutes

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Parses "lon,lat" into [lon, lat], validating both are finite numbers within
// valid coordinate ranges. Returns null if invalid.
function parseCoordPair(value) {
  if (!value) return null;
  const parts = value.split(",");
  if (parts.length !== 2) return null;
  const lon = Number(parts[0]);
  const lat = Number(parts[1]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) return null;
  return [lon, lat];
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const from = parseCoordPair(url.searchParams.get("from"));
  const to = parseCoordPair(url.searchParams.get("to"));
  if (!from || !to) {
    return jsonError("Missing or invalid 'from'/'to' coordinates", 400);
  }

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";

  const allowed = await checkRateLimit(env, ip);
  if (!allowed) {
    return new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
      status: 429,
      headers: { "Content-Type": "application/json", "Retry-After": "60" },
    });
  }

  const [fromLon, fromLat] = from;
  const [toLon, toLat] = to;
  const cacheKey = `route:${fromLon.toFixed(4)},${fromLat.toFixed(4)}:${toLon.toFixed(4)},${toLat.toFixed(4)}`;

  const cached = await getCached(env, cacheKey);
  if (cached) {
    return new Response(JSON.stringify(cached.data), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "X-Cached-At": cached.cachedAt,
      },
    });
  }

  const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${fromLon},${fromLat};${toLon},${toLat}?overview=full&geometries=geojson`;

  let response;
  try {
    // OSRM's public demo server 403s any request with no User-Agent header at
    // all (confirmed directly against it) — Cloudflare's fetch() doesn't send
    // a default one the way curl does, so this must be set explicitly.
    response = await fetch(osrmUrl, { headers: { "User-Agent": "BackToLincolnshire/1.0" } });
  } catch (err) {
    console.error("OSRM fetch threw", err.message);
    return jsonError("Routing is temporarily unavailable", 502);
  }

  if (!response.ok) {
    console.error("OSRM returned non-OK status", response.status, await response.text());
    return jsonError("Routing is temporarily unavailable", 502);
  }

  const data = await response.json();
  await setCached(env, cacheKey, { data, cachedAt: new Date().toISOString() }, ROUTE_CACHE_TTL_SECONDS);

  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// Pages Functions route HEAD separately from GET; without this, HEAD falls through
// to the static handler and 404s, so HEAD-based uptime monitors see the endpoint as
// down. Same status and headers as GET, no body.
export async function onRequestHead(context) {
  const response = await onRequestGet(context);
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

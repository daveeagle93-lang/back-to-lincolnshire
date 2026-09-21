import { checkRateLimit } from "../_shared/rate-limit.js";
import { getCached, setCached } from "../_shared/cache.js";

const GEOCODE_CACHE_TTL_SECONDS = 3600; // 1 hour — a fixed address's coordinates don't change

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const q = url.searchParams.get("q");

  if (!q || !q.trim() || q.trim().length > 200) {
    return jsonError("Missing or invalid 'q' parameter", 400);
  }
  const query = q.trim();

  // CF-Connecting-IP is always set by Cloudflare in production; it can be
  // absent in local dev, where we fall back to a shared bucket rather than
  // crashing the function.
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";

  const allowed = await checkRateLimit(env, ip);
  if (!allowed) {
    return new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
      status: 429,
      headers: { "Content-Type": "application/json", "Retry-After": "60" },
    });
  }

  const cacheKey = `geocode:${query.toLowerCase()}`;
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

  const nominatimUrl = `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(
    query
  )}&limit=1&countrycodes=gb`;

  let response;
  try {
    response = await fetch(nominatimUrl, {
      headers: {
        "User-Agent": `BackToLincolnshire/1.0 (${env.NOMINATIM_CONTACT || "no contact configured"})`,
      },
    });
  } catch (err) {
    return jsonError("Geocoding is temporarily unavailable", 502);
  }

  if (!response.ok) {
    return jsonError("Geocoding is temporarily unavailable", 502);
  }

  const data = await response.json();
  await setCached(env, cacheKey, { data, cachedAt: new Date().toISOString() }, GEOCODE_CACHE_TTL_SECONDS);

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

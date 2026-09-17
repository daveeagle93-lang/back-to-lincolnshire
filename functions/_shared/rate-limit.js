// Per-IP rate limiting for the /api/* Functions. Prefers Cloudflare's native
// Rate Limiting binding (env.RATE_LIMITER) if it's ever available on Pages;
// otherwise falls back to the standalone RateLimiterDO Worker bound as
// env.RATE_LIMITER_DO (see worker/rate-limiter/ and
// docs/cloudflare-dashboard-setup.md).
export async function checkRateLimit(env, ip) {
  if (env.RATE_LIMITER && typeof env.RATE_LIMITER.limit === "function") {
    const { success } = await env.RATE_LIMITER.limit({ key: ip });
    return success;
  }
  if (env.RATE_LIMITER_DO) {
    const id = env.RATE_LIMITER_DO.idFromName(ip);
    const stub = env.RATE_LIMITER_DO.get(id);
    const response = await stub.fetch("https://do/check");
    const { allowed } = await response.json();
    return allowed;
  }
  // Neither binding configured (e.g. local dev without the DO worker running) —
  // fail open rather than breaking the app entirely; this is a development-time
  // gap, not a production posture, and must be called out as such in the docs.
  return true;
}

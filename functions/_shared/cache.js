// Server-side response cache backed by the RESPONSE_CACHE KV binding.
export async function getCached(env, key) {
  const raw = await env.RESPONSE_CACHE.get(key);
  if (!raw) return null;
  return JSON.parse(raw);
}

export async function setCached(env, key, value, ttlSeconds) {
  await env.RESPONSE_CACHE.put(key, JSON.stringify(value), { expirationTtl: ttlSeconds });
}

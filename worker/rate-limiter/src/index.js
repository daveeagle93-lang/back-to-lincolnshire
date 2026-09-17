// Fixed-window per-key rate limiter, hosted as a Durable Object. See
// worker/rate-limiter/README.md for why this lives in its own Worker rather
// than inside the Pages project.

const WINDOW_MS = 60000; // 60s
const LIMIT = 30; // requests per window, per DO instance (i.e. per key/IP)

export class RateLimiterDO {
  constructor(state, env) {
    this.state = state;
  }

  async fetch(request) {
    const now = Date.now();
    let counter = await this.state.storage.get("counter");
    if (!counter) {
      counter = { count: 0, windowStart: now };
    }

    let allowed;
    if (now - counter.windowStart >= WINDOW_MS) {
      counter = { count: 1, windowStart: now };
      allowed = true;
    } else if (counter.count < LIMIT) {
      counter.count += 1;
      allowed = true;
    } else {
      allowed = false;
    }

    await this.state.storage.put("counter", counter);

    return new Response(
      JSON.stringify({ allowed, remaining: Math.max(0, LIMIT - counter.count) }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }
}

// The DO-hosting Worker needs some top-level export to be deployable. It's
// never actually invoked directly in this design — the Pages Functions call
// the RateLimiterDO class's fetch() via the binding's stub.
export default {
  async fetch() {
    return new Response("Not found", { status: 404 });
  },
};

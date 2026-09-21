import { withSecurityHeaders } from "./_shared/security-headers.js";

export async function onRequest(context) {
  const response = withSecurityHeaders(await context.next());
  // This root middleware isn't limited to API routes, so scope noindex to /api/ —
  // setting it on every response would deindex the whole site.
  if (new URL(context.request.url).pathname.startsWith("/api/")) {
    response.headers.set("X-Robots-Tag", "noindex");
  }
  return response;
}

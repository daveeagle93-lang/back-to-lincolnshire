import { withSecurityHeaders } from "./_shared/security-headers.js";

export async function onRequest(context) {
  const response = await context.next();
  return withSecurityHeaders(response);
}

import type { Context } from "hono";
import type { App, User } from "./env";

// These paths also appear in scripts/cloudflare-pro.py. Pro's edge rules cannot
// validate our opaque credentials, so the Worker chooses the allowance only
// after authenticate() has checked the session/key/token against D1.
export async function requestRateLimit(
  c: Context<App>,
  user: User | null,
): Promise<Response | undefined> {
  const path = c.req.path;
  const api = path === "/api" || path.startsWith("/api/");
  const sensitive =
    path.startsWith("/accounts/") ||
    ["/upload/", "/o/token/", "/o/revoke_token/"].includes(path) ||
    ((path.startsWith("/items/") || path.startsWith("/api/v1/items/")) &&
      ["/releases/", "/screenshots/", "/download/"].some((suffix) =>
        path.endsWith(suffix),
      ));
  if (!api && !sensitive) return;
  // Cloudflare supplies this header; never use client-controlled forwarded-IP
  // headers or credential strings as keys. Allowances remain shared per IP.
  const key = c.req.header("CF-Connecting-IP") || "local";
  const limiters: RateLimit[] = [];
  if (sensitive)
    limiters.push(
      user ? c.env.SENSITIVE_AUTH_RATE_LIMIT : c.env.SENSITIVE_ANON_RATE_LIMIT,
    );
  if (api)
    limiters.push(user ? c.env.API_AUTH_RATE_LIMIT : c.env.API_ANON_RATE_LIMIT);
  for (const limiter of limiters) {
    if (!(await limiter.limit({ key })).success)
      return Response.json(
        { error: "rate_limited", retry_after: 60 },
        {
          status: 429,
          headers: {
            "Retry-After": "60",
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
          },
        },
      );
  }
  return undefined;
}

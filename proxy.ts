import { NextResponse, type NextRequest } from "next/server";
import { consumeApiRateLimit } from "./lib/api-rate-limit";
import { requestIpFromHeaders } from "./lib/request-context";
import { contentSecurityPolicy, newCspNonce } from "./lib/csp";

const PROTECTED_PREFIXES = [
  "/change-password",
  "/dashboard",
  "/jobs",
  "/documents",
  "/inbox",
  "/applications",
  "/agents",
  "/assistant",
  "/analytics",
  "/settings",
  "/profile",
  "/admin",
];

/**
 * Cheap pre-flight gate. It only checks that a session cookie exists so
 * unauthenticated requests get a real 307 before the loading boundary streams.
 * Full session validation still happens in the layouts and every server action.
 */
const API_LIMIT = 180;
const API_WINDOW_MS = 60_000;
const API_BODY_LIMIT = 1_000_000;
const API_AUDIO_BODY_LIMIT = 9_000_000;

function apiRateLimited(request: NextRequest): { limited: boolean; retryAfter: number } {
  const key = `${requestIpFromHeaders(request.headers)}:${request.nextUrl.pathname}`;
  return consumeApiRateLimit({ key, limit: API_LIMIT, windowMs: API_WINDOW_MS });
}

/** Reject oversized JSON API requests before they are parsed into memory. Audio
 * transcription has a larger, explicit allowance; file actions do not pass
 * through this API matcher. */
function bodyTooLarge(request: NextRequest): boolean {
  if (!["POST", "PUT", "PATCH"].includes(request.method)) return false;
  const raw = request.headers.get("content-length");
  if (!raw) return false;
  const length = Number(raw);
  if (!Number.isFinite(length) || length < 0) return true;
  const limit = request.nextUrl.pathname.startsWith("/api/voice/") ? API_AUDIO_BODY_LIMIT : API_BODY_LIMIT;
  return length > limit;
}

/** Reject browser state-changing API calls that originate on another host. */
function crossSiteWrite(request: NextRequest): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return false;
  if (request.headers.get("sec-fetch-site") === "cross-site") return true;
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host !== request.headers.get("host");
  } catch {
    return true;
  }
}

function documentRequest(request: NextRequest): boolean {
  const { pathname } = request.nextUrl;
  if (request.method !== "GET") return false;
  if (pathname.startsWith("/api/") || pathname.startsWith("/_next/")) return false;
  return ![
    "/sw.js",
    "/manifest.webmanifest",
    "/pwa-bootstrap.js",
    "/diagnostics.js",
    "/icon.svg",
    "/favicon.ico",
  ].includes(pathname);
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname.startsWith("/api/")) {
    if (bodyTooLarge(request)) {
      return NextResponse.json(
        { error: "Request body is too large." },
        { status: 413, headers: { "Cache-Control": "no-store" } },
      );
    }
    const limit = apiRateLimited(request);
    if (limit.limited) {
      return NextResponse.json(
        { error: "Too many requests. Try again shortly." },
        { status: 429, headers: { "Retry-After": String(limit.retryAfter), "Cache-Control": "no-store" } },
      );
    }
    if (crossSiteWrite(request)) {
      return NextResponse.json({ error: "Cross-site request refused." }, { status: 403 });
    }
  }

  const isProtected = PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
  if (isProtected && !request.cookies.get("atw_session")?.value) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  if (!documentRequest(request)) return NextResponse.next();

  const nonce = newCspNonce();
  const policy = contentSecurityPolicy(nonce, { development: process.env.NODE_ENV === "development" });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", policy);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", policy);
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

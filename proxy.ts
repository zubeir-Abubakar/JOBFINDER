import { NextResponse, type NextRequest } from "next/server";

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
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const isProtected = PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
  if (isProtected && !request.cookies.get("atw_session")?.value) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/setup",
    "/change-password",
    "/dashboard/:path*",
    "/jobs/:path*",
    "/documents/:path*",
    "/inbox/:path*",
    "/applications/:path*",
    "/agents/:path*",
    "/assistant/:path*",
    "/analytics/:path*",
    "/settings/:path*",
    "/profile/:path*",
    "/admin/:path*",
  ],
};

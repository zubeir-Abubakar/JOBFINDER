import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { authUrl, gmailConfig, gmailMissing, stateToken } from "@/lib/gmail";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.redirect(new URL("/login", request.url));
  const missing = gmailMissing();
  if (missing.length > 0) {
    return NextResponse.redirect(new URL(`/inbox?error=${encodeURIComponent(missing.join(" "))}`, request.url));
  }
  const config = gmailConfig();
  if (!config.redirectUri) {
    return NextResponse.redirect(new URL("/inbox?error=Redirect+URI+is+not+configured", request.url));
  }
  const state = stateToken();
  const response = NextResponse.redirect(authUrl(state));
  response.cookies.set("atw_gmail_state", state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/api/gmail/oauth",
    maxAge: 600,
  });
  return response;
}

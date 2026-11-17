import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { exchangeCode, verifyState } from "@/lib/gmail";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const error = url.searchParams.get("error");
  if (error) return NextResponse.redirect(new URL(`/inbox?error=${encodeURIComponent(`Google returned: ${error}`)}`, request.url));
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const store = await cookies();
  const expected = store.get("atw_gmail_state")?.value ?? null;
  if (!code) return NextResponse.redirect(new URL("/inbox?error=Google+did+not+return+an+authorisation+code", request.url));
  if (!expected || !verifyState(state) || state !== expected) {
    return NextResponse.redirect(new URL("/inbox?error=OAuth+state+validation+failed.+Try+connecting+again", request.url));
  }
  try {
    await exchangeCode(code);
    audit({ action: "gmail.connected", entity: "email", detail: "Gmail OAuth completed with encrypted token storage" });
    const response = NextResponse.redirect(new URL("/inbox?ok=Gmail+connected", request.url));
    response.cookies.delete("atw_gmail_state");
    return response;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Gmail authorisation failed";
    return NextResponse.redirect(new URL(`/inbox?error=${encodeURIComponent(message)}`, request.url));
  }
}

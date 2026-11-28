import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { clientIp, currentUser } from "@/lib/auth";
import { consumeOAuthState, exchangeCode } from "@/lib/gmail";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const user = await currentUser();
  if (!user) return NextResponse.redirect(new URL("/login", request.url));

  const store = await cookies();
  const cookie = store.get("atw_gmail_state")?.value ?? null;
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");

  const reject = (message: string) => {
    const response = NextResponse.redirect(new URL(`/inbox?error=${encodeURIComponent(message)}`, request.url));
    response.cookies.delete("atw_gmail_state");
    return response;
  };

  const error = url.searchParams.get("error");
  if (error) {
    return reject(`Google returned: ${error}`);
  }
  if (!code) {
    return reject("Google did not return an authorisation code");
  }

  // The state is signed, must match this browser's cookie, must belong to the
  // signed-in user and can be consumed exactly once.
  const payload = consumeOAuthState({ state, cookie, userId: user.id });
  if (!payload) {
    audit({
      action: "gmail.oauth_state_rejected",
      entity: "email",
      detail: "State missing, expired, replayed or issued to another session",
      ip: await clientIp(),
      userId: user.id,
    });
    return reject("OAuth state validation failed. Try connecting again");
  }

  try {
    await exchangeCode(code);
    audit({
      action: "gmail.connected",
      entity: "email",
      detail: "Gmail OAuth completed with encrypted token storage",
      ip: await clientIp(),
      userId: user.id,
    });
    const response = NextResponse.redirect(new URL("/inbox?ok=Gmail+connected", request.url));
    response.cookies.delete("atw_gmail_state");
    return response;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Gmail authorisation failed";
    return reject(message);
  }
}

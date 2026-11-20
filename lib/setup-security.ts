import crypto from "node:crypto";
import { isLoopbackRequest } from "./request-context";
import { setupClosed } from "./setup";

type HeaderBag = { get(name: string): string | null };

const MIN_TOKEN_LENGTH = 24;

export function setupTokenConfigured(): boolean {
  return Boolean(process.env.SETUP_TOKEN?.trim());
}

function validSetupToken(supplied: string): boolean {
  const configured = process.env.SETUP_TOKEN?.trim() ?? "";
  if (configured.length < MIN_TOKEN_LENGTH || supplied.length !== configured.length) return false;
  return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(configured));
}

/**
 * The page is visible when setup is open. If a token is configured the page
 * renders a token field; otherwise it is available only from a direct local
 * connection. The page never renders or returns the configured token.
 */
export function setupPageState(headers: HeaderBag): {
  closed: boolean;
  allowed: boolean;
  tokenRequired: boolean;
} {
  if (setupClosed()) return { closed: true, allowed: false, tokenRequired: false };
  if (setupTokenConfigured()) return { closed: false, allowed: true, tokenRequired: true };
  return {
    closed: false,
    allowed: isLoopbackRequest(headers),
    tokenRequired: false,
  };
}

export function setupActionAuthorized(headers: HeaderBag, suppliedToken: string): boolean {
  if (setupClosed()) return false;
  if (setupTokenConfigured()) return validSetupToken(suppliedToken);
  return isLoopbackRequest(headers);
}

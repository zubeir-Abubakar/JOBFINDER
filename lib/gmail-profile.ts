/**
 * Pure helpers for Gmail identity and API errors.
 *
 * Gmail's `users.getProfile` response uses `emailAddress`. Any non-2xx response
 * must be surfaced as an actionable error instead of being mistaken for a
 * profile without an email address.
 */

export const REQUIRED_GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.send",
];

/** Identity scopes let Google confirm who connected the mailbox. */
export const GMAIL_IDENTITY_SCOPES = ["openid", "email"];

export type GmailFailureKind = "expired" | "scope" | "api_disabled" | "api_error" | "missing_email";

export class GmailProfileError extends Error {
  kind: GmailFailureKind;
  status: number | null;

  constructor(kind: GmailFailureKind, message: string, status: number | null = null) {
    super(message);
    this.name = "GmailProfileError";
    this.kind = kind;
    this.status = status;
  }
}

function cleanMessage(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 300) : "";
}

/** Map a Gmail API status/message to a useful, credential-free error. */
export function gmailApiError(status: number, rawMessage?: unknown): GmailProfileError {
  const detail = cleanMessage(rawMessage);
  const message = detail || `Gmail API returned HTTP ${status}`;
  const lower = message.toLowerCase();

  if (status === 401 || lower.includes("invalid credentials") || lower.includes("unauthenticated")) {
    return new GmailProfileError(
      "expired",
      "Gmail authorisation expired or was revoked. Reconnect Gmail to grant access again.",
      status,
    );
  }

  if (
    status === 403 &&
    (lower.includes("insufficient authentication scopes") ||
      lower.includes("insufficient permission") ||
      lower.includes("access_token_scope_insufficient") ||
      lower.includes("scope"))
  ) {
    return new GmailProfileError(
      "scope",
      "Gmail authorisation is missing a required permission. Reconnect Gmail and approve read, draft and send access (gmail.readonly, gmail.compose, gmail.send).",
      status,
    );
  }

  if (
    status === 403 &&
    (lower.includes("has not been used in project") ||
      lower.includes("is disabled") ||
      lower.includes("enable it by visiting") ||
      lower.includes("access not configured"))
  ) {
    return new GmailProfileError(
      "api_disabled",
      "The Gmail API is disabled or not enabled for this Google Cloud project. Enable the Gmail API, wait a few minutes, then reconnect Gmail.",
      status,
    );
  }

  if (status === 403) {
    return new GmailProfileError(
      "api_error",
      `Gmail denied the request (HTTP 403). Check that the Gmail API is enabled and the account granted gmail.readonly, then reconnect Gmail. ${message}`,
      status,
    );
  }

  return new GmailProfileError("api_error", `Gmail API error (HTTP ${status}): ${message}`, status);
}

/** Return the account email from a `users.getProfile` response, or throw. */
export function parseGmailProfile(status: number, payload: unknown): string {
  if (status < 200 || status >= 300) {
    const body = payload && typeof payload === "object" ? (payload as { error?: { message?: unknown } }) : null;
    throw gmailApiError(status, body?.error?.message);
  }

  const body = payload && typeof payload === "object" ? (payload as { emailAddress?: unknown }) : null;
  const email = typeof body?.emailAddress === "string" ? body.emailAddress.trim() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new GmailProfileError(
      "missing_email",
      "Gmail profile response did not include emailAddress. Check that the Gmail API is enabled and gmail.readonly is granted, then reconnect Gmail.",
      status,
    );
  }
  return email;
}

/** Compare the scopes Google actually granted with the scopes this app needs. */
export function missingGrantedScopes(granted: string | null | undefined, required: string[] = REQUIRED_GMAIL_SCOPES): string[] {
  const grantedSet = new Set((granted ?? "").split(/[\s,]+/).filter(Boolean));
  return required.filter((scope) => !grantedSet.has(scope));
}

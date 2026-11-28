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

export type GmailFailureKind =
  | "expired"
  | "invalid_grant"
  | "transient"
  | "config"
  | "scope"
  | "api_disabled"
  | "api_error"
  | "missing_email";

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

/**
 * A failed token-endpoint exchange keeps Google's machine-readable error code
 * so callers can separate a dead grant from a temporary outage. The message is
 * never the classifier.
 */
export class GmailTokenError extends Error {
  code: string | null;
  status: number | null;

  constructor(message: string, options: { code?: string | null; status?: number | null } = {}) {
    super(message);
    this.name = "GmailTokenError";
    this.code = options.code ?? null;
    this.status = options.status ?? null;
  }
}

/**
 * Classify a failed refresh-token exchange.
 *
 * `invalid_grant` means the grant itself is gone: only a human reconnection
 * restores access, so it is blocked permanently. A 429/5xx or a network
 * failure is transient and must stay retryable. These two must never share a
 * stored error string.
 */
export function gmailTokenRefreshError(
  status: number | null,
  code?: string | null,
  description?: string | null,
): GmailProfileError {
  const detail = cleanMessage(description);
  const provider = (code ?? "").trim().toLowerCase();
  const suffix = detail && detail.toLowerCase() !== provider ? ` Google said: ${detail}` : "";

  if (provider === "invalid_grant") {
    return new GmailProfileError(
      "invalid_grant",
      `Gmail refresh token was rejected (invalid_grant, HTTP ${status ?? 400}): the authorisation is expired or was revoked. Reconnect Gmail to grant access again; retrying this message cannot succeed.${suffix}`,
      status,
    );
  }

  if (provider === "invalid_client" || provider === "unauthorized_client") {
    return new GmailProfileError(
      "config",
      `Gmail OAuth client configuration was rejected (${provider}, HTTP ${status ?? 400}). Check GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI; reconnecting will not help until the client matches.${suffix}`,
      status,
    );
  }

  if (status === null || status === 429 || status >= 500) {
    return new GmailProfileError(
      "transient",
      `Gmail token refresh failed temporarily (${status === null ? "no HTTP response" : `HTTP ${status}`}${provider ? `, ${provider}` : ""}). This is a transient Google-side or network condition; the outbox retries it automatically and no reconnection is required yet.${suffix}`,
      status,
    );
  }

  return new GmailProfileError(
    "config",
    `Gmail token refresh was refused (HTTP ${status}${provider ? `, ${provider}` : ""}). The stored grant cannot be used and the account must be reconnected.${suffix}`,
    status,
  );
}

/** Stable, machine-readable reason persisted beside an outbox failure. */
export function gmailFailureCode(kind: GmailFailureKind): string {
  switch (kind) {
    case "expired":
      return "access_token_rejected";
    case "invalid_grant":
      return "invalid_grant";
    case "transient":
      return "refresh_transient";
    case "config":
      return "refresh_config";
    case "scope":
      return "scope_insufficient";
    case "api_disabled":
      return "api_disabled";
    case "api_error":
      return "api_error";
    case "missing_email":
      return "missing_email";
  }
}

/** Failure codes whose cause is outside the account and may clear by itself. */
export const TRANSIENT_GMAIL_FAILURE_CODES: ReadonlySet<string> = new Set(["refresh_transient", "api_error"]);

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

import { one, nowIso } from "./db";
import { setSetting } from "./settings";
import { audit } from "./audit";

/**
 * Resend is the single delivery provider for application-owned outbound email.
 *
 * It is used through the documented HTTP API with the key held only in the
 * server environment. The key is never persisted, logged, returned to a browser
 * or written to an audit row. No paid capability is requested and no overage is
 * enabled: the sender uses the plain transactional endpoint on the free tier.
 *
 * Fail-closed rules:
 *  - a missing or malformed key refuses the send before any request;
 *  - a local free-tier allowance guard refuses a send that would exceed the
 *    documented free allowance, because provider-side quota is not exposed;
 *  - there is no Gmail fallback and no second provider.
 *
 * Provider acceptance proves Resend queued the message, not that it reached the
 * recipient's inbox. That distinction is preserved in the delivery evidence.
 */

export const RESEND_ENDPOINT = "https://api.resend.com/emails";
const RESEND_DOMAINS_ENDPOINT = "https://api.resend.com/domains";

/**
 * Resend's documented testing sender. It requires no verified domain, but it can
 * only deliver to the address that owns the Resend account. Using it is not
 * equivalent to a verified production domain and is reported as such.
 */
export const DEFAULT_RESEND_SENDER = "AT AI Workforce <onboarding@resend.dev>";

/** Documented free-tier allowances, used as a local guard only. */
export const RESEND_FREE_DAILY_LIMIT = 100;
export const RESEND_FREE_MONTHLY_LIMIT = 3000;

export type ResendStatus =
  | "accepted"
  | "missing_configuration"
  | "authentication_failed"
  | "permission_denied"
  | "unverified_domain"
  | "unverified_recipient"
  | "invalid_recipient"
  | "invalid_request"
  | "quota_exhausted"
  | "rate_limited"
  | "api_error";

export type ResendSendResult = {
  provider: "resend";
  status: ResendStatus;
  /** Stable reason code for the outbox; null when the call succeeded. */
  failureCode: string | null;
  recipientMasked: string;
  messageId: string | null;
  rfcMessageId: string | null;
  detail: string;
  at: string;
};

export type ResendReadiness = {
  ok: boolean;
  code: "ready" | "missing_configuration" | "authentication_failed" | "permission_denied" | "transient";
  detail: string;
  email: string | null;
};

function validAddress(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

/** Extract the address from `Name <address>` or return the bare address. */
export function senderAddress(from: string): string {
  const match = from.trim().match(/<([^>\s]+)>\s*$/);
  return (match?.[1] ?? from.trim()).trim();
}

function intFromEnv(name: string, fallback: number): number {
  const raw = Number((process.env[name] ?? "").trim());
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

export function resendConfig() {
  const configuredFrom = (process.env.RESEND_FROM ?? "").trim();
  return {
    apiKey: (process.env.RESEND_API_KEY ?? "").trim(),
    from: configuredFrom || DEFAULT_RESEND_SENDER,
    /** True when the documented test sender is in use instead of a verified domain. */
    usingTestSender: configuredFrom.length === 0,
    replyTo: (process.env.NOTIFICATION_EMAIL ?? "").trim(),
    webhookSecret: (process.env.RESEND_WEBHOOK_SECRET ?? "").trim(),
    dailyLimit: intFromEnv("RESEND_FREE_DAILY_LIMIT", RESEND_FREE_DAILY_LIMIT),
    monthlyLimit: intFromEnv("RESEND_FREE_MONTHLY_LIMIT", RESEND_FREE_MONTHLY_LIMIT),
  };
}

/**
 * Fail-closed configuration validation. The sender falls back to Resend's
 * testing sender, so a missing RESEND_FROM is not an error; a malformed one is,
 * because a wrong sender produces an unverified-domain rejection.
 */
export function resendMissing(): string[] {
  const config = resendConfig();
  const missing: string[] = [];
  if (!config.apiKey) missing.push("RESEND_API_KEY is missing.");
  else if (!/^re_[A-Za-z0-9_-]{8,}$/.test(config.apiKey)) missing.push("RESEND_API_KEY is not a valid Resend key.");
  if (!validAddress(senderAddress(config.from))) missing.push("RESEND_FROM must contain one email address.");
  if (config.replyTo && !validAddress(config.replyTo)) missing.push("NOTIFICATION_EMAIL must be a valid email address when set.");
  return missing;
}

export function resendConfigured(): boolean {
  return resendMissing().length === 0;
}

export function maskAddress(value: string): string {
  const email = value.trim();
  const at = email.lastIndexOf("@");
  if (at < 1) return email ? "***" : "not configured";
  return `${email[0]}***${email.slice(at)}`;
}

export type ResendFreeTierUsage = {
  dailyLimit: number;
  monthlyLimit: number;
  acceptedToday: number;
  acceptedThisMonth: number;
  remainingToday: number;
  remainingThisMonth: number;
  exhausted: boolean;
  source: "local-outbox-count";
};

/**
 * Local allowance accounting. Resend exposes no reliable per-request quota
 * figure, so accepted sends are counted from the outbox and compared with the
 * documented free-tier allowance. This can only be conservative: it blocks a
 * send, it never authorises a paid one.
 */
export function resendFreeTierUsage(now: Date = new Date()): ResendFreeTierUsage {
  const config = resendConfig();
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const count = (since: string) =>
    Number(
      one<{ n: number }>(
        `SELECT COUNT(*) AS n FROM notification_outbox
         WHERE provider = 'resend'
           AND delivery IN ('accepted_by_provider','sent_folder_observed','delivery_confirmed')
           AND COALESCE(finished_at, created_at) >= ?`,
        [since],
      )?.n ?? 0,
    );
  let acceptedToday = 0;
  let acceptedThisMonth = 0;
  try {
    acceptedToday = count(dayStart);
    acceptedThisMonth = count(monthStart);
  } catch {
    // An unreadable outbox must not authorise an unlimited send.
    return {
      dailyLimit: config.dailyLimit,
      monthlyLimit: config.monthlyLimit,
      acceptedToday: 0,
      acceptedThisMonth: 0,
      remainingToday: 0,
      remainingThisMonth: 0,
      exhausted: true,
      source: "local-outbox-count",
    };
  }
  const remainingToday = Math.max(0, config.dailyLimit - acceptedToday);
  const remainingThisMonth = Math.max(0, config.monthlyLimit - acceptedThisMonth);
  return {
    dailyLimit: config.dailyLimit,
    monthlyLimit: config.monthlyLimit,
    acceptedToday,
    acceptedThisMonth,
    remainingToday,
    remainingThisMonth,
    exhausted: remainingToday === 0 || remainingThisMonth === 0,
    source: "local-outbox-count",
  };
}

function failure(recipient: string, status: ResendStatus, failureCode: string, detail: string, at: string): ResendSendResult {
  return {
    provider: "resend",
    status,
    failureCode,
    recipientMasked: maskAddress(recipient),
    messageId: null,
    rfcMessageId: null,
    detail,
    at,
  };
}

/**
 * Send exactly one message. A 200/201 response carrying an id is provider
 * acceptance only; no inbox delivery is claimed from it.
 */
export async function sendResendEmail(
  to: string,
  subject: string,
  body: string,
  options: { html?: string | null; rfcMessageId?: string | null; from?: string | null } = {},
): Promise<ResendSendResult> {
  const at = nowIso();
  const recipient = to.trim();
  if (!validAddress(recipient)) {
    return failure(recipient, "invalid_recipient", "invalid_recipient", "Enter a valid notification email address.", at);
  }
  const missing = resendMissing();
  if (missing.length > 0) {
    return failure(recipient, "missing_configuration", "missing_configuration", `Resend is not ready: ${missing.join(" ")}`, at);
  }
  const config = resendConfig();
  const from = (options.from ?? "").trim() || config.from;
  if (!validAddress(senderAddress(from))) {
    return failure(recipient, "missing_configuration", "missing_configuration", "The Resend sender address is not valid.", at);
  }
  const usage = resendFreeTierUsage();
  if (usage.exhausted) {
    return failure(
      recipient,
      "quota_exhausted",
      "free_tier_limit_reached",
      usage.remainingToday === 0
        ? `The documented Resend free-tier daily allowance is used (${usage.acceptedToday}/${usage.dailyLimit} accepted today, counted locally). No further send is attempted and no paid overage is enabled.`
        : `The documented Resend free-tier monthly allowance is used (${usage.acceptedThisMonth}/${usage.monthlyLimit} accepted this month, counted locally). No further send is attempted and no paid overage is enabled.`,
      at,
    );
  }
  const headers: Record<string, string> = {};
  if (options.rfcMessageId) headers["Message-ID"] = options.rfcMessageId;

  let response: Response;
  try {
    response = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({
        from,
        to: [recipient],
        subject,
        text: body,
        ...(options.html ? { html: options.html } : {}),
        ...(config.replyTo && validAddress(config.replyTo) ? { reply_to: [config.replyTo] } : {}),
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      }),
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message.slice(0, 300) : "Resend request failed.";
    return failure(
      recipient,
      "api_error",
      "transport_error",
      `Resend could not be reached (${message}). This is a transient network condition and is retried with backoff.`,
      at,
    );
  }

  const payload = (await response.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
  if (response.ok && payload.id) {
    return {
      provider: "resend",
      status: "accepted",
      failureCode: null,
      recipientMasked: maskAddress(recipient),
      messageId: payload.id,
      rfcMessageId: options.rfcMessageId ?? null,
      detail: config.usingTestSender
        ? "Resend accepted the message using its testing sender. That sender can only deliver to the Resend account owner's address; a verified domain is required for other recipients."
        : "Resend accepted the message for delivery. Recipient inbox delivery is not independently confirmed by this response.",
      at,
    };
  }
  const providerMessage = (payload.message ?? payload.name ?? `HTTP ${response.status}`).slice(0, 300);
  const testSender = config.usingTestSender;

  if (response.status === 401) {
    return failure(recipient, "authentication_failed", "invalid_api_key", `Resend rejected RESEND_API_KEY (${providerMessage}). Replace the key; retrying the same key cannot succeed.`, at);
  }
  if (response.status === 402 || /quota|monthly (limit|quota)|exceeded your/i.test(providerMessage)) {
    return failure(recipient, "quota_exhausted", "provider_quota_exhausted", `Resend reports the account allowance is exhausted (${providerMessage}). No paid overage is enabled, so sending is blocked until the allowance resets.`, at);
  }
  if (response.status === 403) {
    if (/domain/i.test(providerMessage) && !/recipient|email address card|to address/i.test(providerMessage)) {
      return failure(recipient, "unverified_domain", "unverified_domain", `Resend rejected the sender domain (${providerMessage}). Verify the domain in Resend and set RESEND_FROM to an address on it.`, at);
    }
    if (testSender || /not verified|verify a domain|testing|own email|recipient/i.test(providerMessage)) {
      return failure(
        recipient,
        "unverified_recipient",
        "unverified_recipient",
        `Resend refused this recipient (${providerMessage}). ${testSender ? "The testing sender onboarding@resend.dev can only send to the Resend account owner's address." : "Verify the recipient's domain or send to the account owner."} Set RESEND_FROM to an address on a verified domain to reach other recipients.`,
        at,
      );
    }
    return failure(recipient, "permission_denied", "permission_denied", `Resend denied this send (${providerMessage}).`, at);
  }
  if (response.status === 422 || response.status === 400) {
    if (/to\b|recipient|email address/i.test(providerMessage)) {
      return failure(recipient, "invalid_recipient", "recipient_rejected", `Resend rejected the recipient address (${providerMessage}).`, at);
    }
    return failure(recipient, "invalid_request", "invalid_request", `Resend rejected the message content or sender (${providerMessage}).`, at);
  }
  if (response.status === 429) {
    return failure(recipient, "rate_limited", "rate_limited", `Resend rate-limited this send (${providerMessage}). The outbox retries with backoff.`, at);
  }
  return failure(recipient, "api_error", "api_error", `Resend returned HTTP ${response.status}${providerMessage ? ` (${providerMessage})` : ""}.`, at);
}

/**
 * Cheap authenticated preflight that sends no email. It proves the key is
 * accepted and the account is reachable before an outbox row is claimed.
 */
export async function resendSendReadiness(): Promise<ResendReadiness> {
  const missing = resendMissing();
  const config = resendConfig();
  if (missing.length > 0) {
    return { ok: false, code: "missing_configuration", detail: missing.join(" "), email: senderAddress(config.from) };
  }
  const senderNote = config.usingTestSender
    ? " Using Resend's testing sender, which can only deliver to the Resend account owner's address."
    : "";
  try {
    const response = await fetch(RESEND_DOMAINS_ENDPOINT, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 401) {
      return { ok: false, code: "authentication_failed", detail: "Resend rejected RESEND_API_KEY. Replace the key.", email: senderAddress(config.from) };
    }
    if (response.status === 403) {
      return { ok: false, code: "permission_denied", detail: "Resend denied access for this key.", email: senderAddress(config.from) };
    }
    if (!response.ok) {
      return {
        ok: false,
        code: "transient",
        detail: `Resend preflight returned HTTP ${response.status}. This is retryable and does not require a configuration change.`,
        email: senderAddress(config.from),
      };
    }
    return {
      ok: true,
      code: "ready",
      detail: `Resend accepted the configured key for ${senderAddress(config.from)}.${senderNote}`,
      email: senderAddress(config.from),
    };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message.slice(0, 200) : "unknown error";
    return {
      ok: false,
      code: "transient",
      detail: `Resend could not be reached during preflight (${message}). Retry later; no configuration change is indicated.`,
      email: senderAddress(config.from),
    };
  }
}

/** Explicitly requested test message. Exactly one send call is made. */
export async function sendResendTestEmail(to: string): Promise<ResendSendResult> {
  const subject = "AT AI Workforce | Email delivery test";
  const body = [
    "This is a test message from AT AI Workforce.",
    "",
    `Requested at ${nowIso()}.`,
    "If you received this, Resend accepted the send request for the configured sender.",
    "The application can confirm provider acceptance but cannot independently verify inbox delivery.",
  ].join("\n");
  return sendResendEmail(to, subject, body);
}

/** Persist and audit the result so Settings and the dashboard show the real outcome. */
export async function runResendTestEmail(to: string, userId?: string | null): Promise<ResendSendResult> {
  const result = await sendResendTestEmail(to);
  setSetting("email_test_last", result);
  audit({
    userId: userId ?? null,
    action: `email.test_${result.status}`,
    entity: "email",
    detail: [
      "provider=resend",
      `recipient=${result.recipientMasked}`,
      `status=${result.status}`,
      `messageId=${result.messageId ?? "none"}`,
      result.detail,
    ]
      .join(" · ")
      .replace(/\s+/g, " ")
      .slice(0, 1000),
  });
  return result;
}

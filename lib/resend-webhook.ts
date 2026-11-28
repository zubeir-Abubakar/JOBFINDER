import crypto from "node:crypto";

/**
 * Resend delivers events through Svix-signed webhooks. Verification is done
 * locally with node:crypto so no extra dependency is introduced, and an
 * unsigned or stale request is always refused. A webhook can only move a row
 * toward stronger evidence; it never sends mail and never creates a row.
 */

export type ResendWebhookEvent = {
  type?: string;
  created_at?: string;
  data?: {
    email_id?: string;
    to?: string[] | string;
    subject?: string;
    bounce?: { message?: string; type?: string } | null;
  };
};

export type ResendDeliveryEvent = {
  outboxMessageId: string;
  state: "delivery_confirmed" | "bounced";
  evidence: string;
};

const MAX_SKEW_SECONDS = 5 * 60;

function decodeSecret(secret: string): Buffer {
  const raw = secret.trim().replace(/^whsec_/, "");
  try {
    return Buffer.from(raw, "base64");
  } catch {
    return Buffer.from(raw, "utf8");
  }
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/**
 * Verify a Svix signature over `${svix-id}.${svix-timestamp}.${rawBody}`.
 * Returns a reason rather than throwing so the route can answer accurately.
 */
export function verifyResendSignature(input: {
  secret: string;
  id: string | null;
  timestamp: string | null;
  signature: string | null;
  rawBody: string;
  now?: Date;
}): { ok: true } | { ok: false; reason: string } {
  if (!input.secret.trim()) return { ok: false, reason: "RESEND_WEBHOOK_SECRET is not configured." };
  if (!input.id || !input.timestamp || !input.signature) {
    return { ok: false, reason: "Missing Svix signature headers." };
  }
  const timestamp = Number(input.timestamp);
  if (!Number.isFinite(timestamp)) return { ok: false, reason: "Invalid Svix timestamp." };
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSeconds - timestamp) > MAX_SKEW_SECONDS) {
    return { ok: false, reason: "Svix timestamp is outside the accepted tolerance." };
  }
  const expected = crypto
    .createHmac("sha256", decodeSecret(input.secret))
    .update(`${input.id}.${input.timestamp}.${input.rawBody}`)
    .digest("base64");
  const candidates = input.signature
    .split(" ")
    .map((part) => part.trim())
    .filter((part) => part.startsWith("v1,"))
    .map((part) => part.slice(3));
  if (candidates.length === 0) return { ok: false, reason: "No v1 signature was supplied." };
  const matched = candidates.some((candidate) => safeEqual(expected, candidate));
  return matched ? { ok: true } : { ok: false, reason: "Signature does not match the request body." };
}

/**
 * Map a verified event to a delivery state. Unknown or non-terminal events are
 * ignored rather than guessed at, so a webhook can never manufacture delivery.
 */
export function deliveryEventFromWebhook(event: ResendWebhookEvent): ResendDeliveryEvent | null {
  const messageId = (event.data?.email_id ?? "").trim();
  if (!messageId) return null;
  const type = (event.type ?? "").trim().toLowerCase();
  const recipient = Array.isArray(event.data?.to) ? event.data?.to[0] : event.data?.to;
  if (type === "email.delivered") {
    return {
      outboxMessageId: messageId,
      state: "delivery_confirmed",
      evidence: `Resend reported email.delivered for ${recipient ?? "the recipient"} at ${event.created_at ?? "an unrecorded time"}.`,
    };
  }
  if (type === "email.bounced" || type === "email.complained" || type === "email.failed") {
    const bounce = event.data?.bounce;
    const detail = [bounce?.type, bounce?.message].filter(Boolean).join(": ");
    return {
      outboxMessageId: messageId,
      state: "bounced",
      evidence: `Resend reported ${type}${detail ? ` — ${detail}` : ""} at ${event.created_at ?? "an unrecorded time"}.`,
    };
  }
  // email.sent, email.delivery_delayed and unknown types are not terminal
  // evidence and never overwrite the recorded state.
  return null;
}

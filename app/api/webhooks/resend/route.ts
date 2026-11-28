import { NextResponse } from "next/server";
import { deliveryEventFromWebhook, verifyResendSignature } from "@/lib/resend-webhook";
import { outboxByProviderMessageId, recordOutboxDeliveryState } from "@/lib/notify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Resend delivery webhook. This is the only path that can turn provider
 * acceptance into confirmed delivery, and it requires a valid Svix signature
 * from the configured secret. It never sends mail, never creates a row and never
 * trusts the payload's own claim of delivery without the signature.
 *
 * Without RESEND_WEBHOOK_SECRET the endpoint answers 503 instead of accepting
 * unsigned events, so a locally running instance is never silently open.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const secret = (process.env.RESEND_WEBHOOK_SECRET ?? "").trim();
  if (!secret) {
    return NextResponse.json(
      { error: "Resend webhooks are not configured on this instance." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  const rawBody = await request.text();
  const verification = verifyResendSignature({
    secret,
    id: request.headers.get("svix-id"),
    timestamp: request.headers.get("svix-timestamp"),
    signature: request.headers.get("svix-signature"),
    rawBody,
  });
  if (!verification.ok) {
    return NextResponse.json(
      { error: "Invalid webhook signature." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  let event: ReturnType<typeof deliveryEventFromWebhook>;
  try {
    const parsed = JSON.parse(rawBody) as Parameters<typeof deliveryEventFromWebhook>[0];
    event = deliveryEventFromWebhook(parsed);
  } catch {
    return NextResponse.json(
      { error: "Webhook payload is not valid JSON." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (!event) {
    // A signed but non-terminal event (`email.sent`, `email.delivery_delayed`)
    // is acknowledged without changing the recorded evidence.
    return NextResponse.json({ received: true, applied: false }, { headers: { "Cache-Control": "no-store" } });
  }

  const row = outboxByProviderMessageId(event.outboxMessageId);
  if (!row) {
    return NextResponse.json(
      { error: "No outbox record matches this provider message id." },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }

  recordOutboxDeliveryState(row.id, event.state, event.evidence);
  return NextResponse.json({ received: true, applied: true, state: event.state }, { headers: { "Cache-Control": "no-store" } });
}

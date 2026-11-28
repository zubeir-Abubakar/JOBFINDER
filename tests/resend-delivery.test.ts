import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import crypto from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-resend-"));
process.env.APP_SECRET_KEY = "resend-delivery-test-secret";
process.env.FREELLMAPI_ENABLED = "false";
process.env.OLLAMA_ENABLED = "false";
process.env.OPENROUTER_ENABLED = "false";
process.env.GMAIL_ENABLED = "false";
delete process.env.RESEND_API_KEY;
delete process.env.RESEND_FROM;
delete process.env.NOTIFICATION_EMAIL;

const db = await import("../lib/db.ts");
const notifications = await import("../lib/notify.ts");
const resend = await import("../lib/resend.ts");
const webhook = await import("../lib/resend-webhook.ts");
const { setSetting } = await import("../lib/settings.ts");

db.getDb();
notifications.stopNotificationQueue();
db.run("UPDATE profiles SET email = 'owner@example.test' WHERE id = 1");
setSetting("notify_immediate", true);
setSetting("notify_daily_report", true);

const KEY = "***REMOVED***";
const FROM = "AT AI Workforce <notify@atw.example.test>";

function withEnv<T>(fn: () => Promise<T>): Promise<T> {
  process.env.RESEND_API_KEY = KEY;
  process.env.RESEND_FROM = FROM;
  return fn().finally(() => {
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM;
  });
}

test("a missing Resend configuration fails closed without any request", async () => {
  assert.match(resend.resendMissing().join(" "), /RESEND_API_KEY is missing/);
  const readiness = await resend.resendSendReadiness();
  assert.equal(readiness.ok, false);
  assert.equal(readiness.code, "missing_configuration");

  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new Error("no request may be transmitted");
  }) as typeof fetch;
  try {
    const result = await resend.sendResendEmail("owner@example.test", "Subject", "Body");
    assert.equal(result.status, "missing_configuration");
    assert.equal(result.failureCode, "missing_configuration");
    assert.equal(result.messageId, null);
    assert.equal(calls, 0, "validation must run before the provider is contacted");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the documented testing sender is used when RESEND_FROM is absent", () => {
  process.env.RESEND_API_KEY = KEY;
  try {
    const config = resend.resendConfig();
    assert.equal(config.usingTestSender, true);
    assert.match(config.from, /onboarding@resend\.dev/);
    assert.deepEqual(resend.resendMissing(), [], "a missing sender is no longer a configuration failure");
    assert.equal(resend.resendConfigured(), true);
  } finally {
    delete process.env.RESEND_API_KEY;
  }
});

test("an unverified recipient is blocked with actionable wording, not retried", async () => {
  await withEnv(async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(
        JSON.stringify({ message: "You can only send testing emails to your own email address." }),
        { status: 403 },
      );
    }) as typeof fetch;
    try {
      notifications.notify({
        kind: "application_failed",
        subject: "Unverified recipient",
        body: "Controlled delivery test.",
        dedupeKey: "resend:unverified-recipient",
      });
      notifications.stopNotificationQueue();
      const drained = await notifications.drainNotificationQueue({ limit: 1 });
      assert.equal(drained.failed, 1);
      assert.equal(drained.retryScheduled, 0);
      assert.equal(calls, 1);
      const row = db.one<{ delivery: string | null; failure_code: string | null; last_error: string | null }>(
        "SELECT delivery, failure_code, last_error FROM notification_outbox WHERE dedupe_key = 'resend:unverified-recipient'",
      );
      assert.equal(row?.delivery, "blocked");
      assert.equal(row?.failure_code, "unverified_recipient");
      assert.match(row?.last_error ?? "", /testing sender|verify the recipient/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("a rate limit is retried while a free-tier allowance block is not", async () => {
  await withEnv(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ message: "Too many requests" }), { status: 429 })) as typeof fetch;
    try {
      const queued = notifications.notify({
        kind: "application_failed",
        subject: "Rate limited",
        body: "Controlled delivery test.",
        dedupeKey: "resend:rate-limited",
      });
      notifications.stopNotificationQueue();
      const drained = await notifications.drainNotificationQueue({ limit: 1, outboxId: queued.outboxId ?? undefined });
      assert.equal(drained.retryScheduled, 1);
      const row = db.one<{ status: string; failure_code: string | null }>(
        "SELECT status, failure_code FROM notification_outbox WHERE dedupe_key = 'resend:rate-limited'",
      );
      assert.equal(row?.status, "retry_scheduled");
      assert.equal(row?.failure_code, "rate_limited");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  process.env.RESEND_API_KEY = KEY;
  process.env.RESEND_FREE_DAILY_LIMIT = "1";
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ id: "must-not-send" }), { status: 200 });
  }) as typeof fetch;
  try {
    // Self-contained allowance fixture: one already-accepted send today.
    const at = new Date().toISOString();
    db.run(
      `INSERT INTO notification_outbox
         (id, dedupe_key, kind, recipient, subject, body, status, attempts, available_at, delivery,
          provider, provider_message_id, created_at, finished_at)
       VALUES ('mailout_quota_fixture', 'resend:quota-fixture', 'application_failed', 'owner@example.test',
          'Quota fixture', 'Body', 'sent', 1, ?, 'accepted_by_provider', 'resend', 'resend-quota-fixture', ?, ?)`,
      [at, at, at],
    );
    const usage = resend.resendFreeTierUsage();
    assert.equal(usage.dailyLimit, 1);
    assert.equal(usage.acceptedToday >= 1, true, "the accepted fixture is counted locally");
    assert.equal(usage.exhausted, true, "an already-used allowance blocks the next send");
    const result = await resend.sendResendEmail("owner@example.test", "Subject", "Body");
    assert.equal(result.status, "quota_exhausted");
    assert.equal(result.failureCode, "free_tier_limit_reached");
    assert.equal(calls, 0, "the free-tier guard must run before the provider is contacted");
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FREE_DAILY_LIMIT;
  }
});

test("a webhook signature is required and only proves what it says", () => {
  const secretRaw = crypto.randomBytes(24).toString("base64");
  const secret = `whsec_${secretRaw}`;
  const rawBody = JSON.stringify({ type: "email.delivered", data: { email_id: "resend-message-1", to: ["owner@example.test"] } });
  const now = new Date("2026-11-27T12:00:00.000Z");
  const timestamp = String(Math.floor(now.getTime() / 1000));
  const id = "msg_fixture_1";
  const signature = crypto.createHmac("sha256", Buffer.from(secretRaw, "base64")).update(`${id}.${timestamp}.${rawBody}`).digest("base64");

  assert.deepEqual(
    webhook.verifyResendSignature({ secret, id, timestamp, signature: `v1,${signature}`, rawBody, now }),
    { ok: true },
  );
  assert.equal(
    webhook.verifyResendSignature({ secret, id, timestamp, signature: `v1,${signature}`, rawBody: `${rawBody} `, now }).ok,
    false,
    "a tampered body must fail verification",
  );
  assert.equal(
    webhook.verifyResendSignature({ secret, id, timestamp, signature: `v1,${signature}`, rawBody, now: new Date(now.getTime() + 10 * 60_000) }).ok,
    false,
    "a stale timestamp must be refused",
  );
  assert.equal(
    webhook.verifyResendSignature({ secret: "", id, timestamp, signature: `v1,${signature}`, rawBody, now }).ok,
    false,
    "an unconfigured secret must refuse every event",
  );

  const delivered = webhook.deliveryEventFromWebhook(JSON.parse(rawBody));
  assert.equal(delivered?.state, "delivery_confirmed");
  const bounced = webhook.deliveryEventFromWebhook({
    type: "email.bounced",
    data: { email_id: "resend-message-1", bounce: { message: "mailbox full", type: "Permanent" } },
  });
  assert.equal(bounced?.state, "bounced");
  assert.match(bounced?.evidence ?? "", /mailbox full/);
  assert.equal(webhook.deliveryEventFromWebhook({ type: "email.sent", data: { email_id: "x" } }), null);
  const route = readFileSync("app/api/webhooks/resend/route.ts", "utf8");
  assert.match(route, /RESEND_WEBHOOK_SECRET/);
  assert.match(route, /verifyResendSignature/);
  assert.match(route, /recordOutboxDeliveryState/);
});

test("the admin surface reports provider, recipient, allowance and verification honestly", () => {
  const page = readFileSync("app/admin/email/page.tsx", "utf8");
  assert.match(page, /resendFreeTierUsage/);
  assert.match(page, /resendConfig/);
  assert.match(page, /Configured recipient/);
  assert.match(page, /Free tier \(counted locally\)/);
  assert.match(page, /Send test email/);
  assert.match(page, /sendResendTestEmailAction/);
  assert.match(page, /awaiting first accepted send/);
  assert.match(page, /WHERE provider = 'resend' AND delivery IN/, "a historical Gmail acceptance must not verify Resend");
  assert.doesNotMatch(page, /badge-good[^\n]*resendReady\}`/, "presence of a key alone is not a green connected state");
});

test("a malformed key or sender is refused locally", async () => {
  process.env.RESEND_API_KEY = "sk-not-a-resend-key";
  process.env.RESEND_FROM = "not-an-address";
  try {
    const missing = resend.resendMissing().join(" ");
    assert.match(missing, /not a valid Resend key/);
    assert.match(missing, /RESEND_FROM must contain one email address/);
  } finally {
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM;
  }
});

test("the outbox delivers through Resend and never persists the API key", async () => {
  await withEnv(async () => {
    const originalFetch = globalThis.fetch;
    let authorization = "";
    let body: Record<string, unknown> = {};
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      authorization = String((init?.headers as Record<string, string>)?.Authorization ?? "");
      body = JSON.parse(String(init?.body ?? "{}"));
      return new Response(JSON.stringify({ id: "resend-message-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const queued = notifications.notify({
        kind: "job_discovery_completed",
        subject: "Resend outbox",
        body: "Controlled delivery test.",
        dedupeKey: "resend:outbox:one",
      });
      assert.equal(queued.emailQueued, true);
      notifications.stopNotificationQueue();
      const drained = await notifications.drainNotificationQueue({ limit: 1 });
      assert.equal(drained.sent, 1);
      assert.equal(authorization, `Bearer ${KEY}`);
      assert.equal(body.from, FROM);
      assert.deepEqual(body.to, ["owner@example.test"]);
      assert.equal(body.subject, "Resend outbox");

      const row = db.one<{ status: string; delivery: string | null; provider: string | null; provider_message_id: string | null }>(
        "SELECT status, delivery, provider, provider_message_id FROM notification_outbox WHERE dedupe_key = 'resend:outbox:one'",
      );
      assert.equal(row?.status, "sent");
      assert.equal(row?.provider, "resend");
      assert.equal(row?.delivery, "accepted_by_provider");
      assert.equal(row?.provider_message_id, "resend-message-1");
      assert.equal(
        db.one<{ n: number }>("SELECT COUNT(*) AS n FROM notification_outbox WHERE dedupe_key = 'resend:outbox:one'")?.n,
        1,
      );

      const everything = JSON.stringify([
        db.all("SELECT * FROM notification_outbox"),
        db.all("SELECT * FROM notifications"),
        db.all("SELECT * FROM audit_logs"),
      ]);
      assert.equal(everything.includes(KEY), false, "the API key must never be persisted");
      assert.equal(everything.includes("Bearer"), false, "an authorization header must never be persisted");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("a rejected key is a blocked delivery and is not retried", async () => {
  await withEnv(async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ message: "Invalid API key" }), { status: 401 });
    }) as typeof fetch;
    try {
      notifications.notify({
        kind: "application_failed",
        subject: "Rejected key",
        body: "Controlled delivery test.",
        dedupeKey: "resend:rejected-key",
      });
      notifications.stopNotificationQueue();
      const drained = await notifications.drainNotificationQueue({ limit: 1 });
      assert.equal(drained.failed, 1);
      assert.equal(drained.retryScheduled, 0);
      assert.equal(calls, 1, "a dead key is never retried automatically");
      const row = db.one<{ status: string; delivery: string | null; failure_code: string | null; last_error: string | null }>(
        "SELECT status, delivery, failure_code, last_error FROM notification_outbox WHERE dedupe_key = 'resend:rejected-key'",
      );
      assert.equal(row?.status, "failed");
      assert.equal(row?.delivery, "blocked");
      assert.equal(row?.failure_code, "invalid_api_key");
      assert.doesNotMatch(row?.last_error ?? "", new RegExp(KEY));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("a provider outage is retried and only acceptance is recorded", async () => {
  await withEnv(async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) return new Response(JSON.stringify({ message: "upstream unavailable" }), { status: 503 });
      return new Response(JSON.stringify({ id: "resend-message-2" }), { status: 200 });
    }) as typeof fetch;
    try {
      const queued = notifications.notify({
        kind: "application_failed",
        subject: "Transient provider",
        body: "Controlled delivery test.",
        dedupeKey: "resend:transient",
      });
      notifications.stopNotificationQueue();
      const outboxId = queued.outboxId ?? undefined;
      const now = new Date();
      const first = await notifications.drainNotificationQueue({ limit: 1, now, outboxId });
      assert.equal(first.retryScheduled, 1);
      const second = await notifications.drainNotificationQueue({
        limit: 1,
        now: new Date(now.getTime() + 10 * 60_000),
        outboxId,
      });
      assert.equal(second.sent, 1);
      const row = db.one<{ delivery: string | null; provider_message_id: string | null }>(
        "SELECT delivery, provider_message_id FROM notification_outbox WHERE dedupe_key = 'resend:transient'",
      );
      assert.equal(row?.delivery, "accepted_by_provider");
      assert.equal(row?.provider_message_id, "resend-message-2");
      assert.match(
        notifications.deliveryStateMessage("accepted_by_provider"),
        /Resend has accepted.*not yet been independently confirmed/i,
      );
      assert.doesNotMatch(notifications.deliveryStateMessage("accepted_by_provider"), /delivered|check your inbox/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("notification delivery no longer requires a connected Gmail account", () => {
  db.run("DELETE FROM gmail_accounts WHERE id = 1");
  setSetting("email", { provider: "gmail", connected: false, sender: "", account: "" });
  assert.equal(notifications.notificationRecipient(), "owner@example.test");
  const queued = notifications.notify({
    kind: "job_discovery_completed",
    subject: "No mailbox connected",
    body: "Outbound delivery is owned by Resend.",
    dedupeKey: "resend:no-gmail",
  });
  notifications.stopNotificationQueue();
  assert.equal(queued.emailQueued, true);
  assert.notEqual(queued.deliveryState, "blocked");
});

test("a Resend row is never verified through the Gmail Sent folder", async () => {
  db.run(
    `INSERT INTO notification_outbox
       (id, dedupe_key, notification_id, user_id, kind, recipient, subject, body, status, attempts, available_at, delivery,
        provider, provider_message_id, created_at)
     VALUES ('mailout_resend_verify', 'resend:verify', NULL, NULL, 'job_discovery_completed', 'owner@example.test',
        'Verify', 'Body', 'sent', 1, ?, 'accepted_by_provider', 'resend', 'resend-message-3', ?)`,
    [new Date().toISOString(), new Date().toISOString()],
  );
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new Error("Gmail must not be contacted for a Resend row");
  }) as typeof fetch;
  try {
    const result = await notifications.refreshOutboxSentObservation("mailout_resend_verify");
    assert.equal(calls, 0);
    assert.equal(result.state, "accepted_by_provider");
    assert.match(result.detail, /no Sent-folder equivalent/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test.after(() => {
  notifications.stopNotificationQueue();
  db.closeDb();
});

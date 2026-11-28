import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-brief-resend-"));
process.env.APP_SECRET_KEY = "brief-resend-test-secret";
process.env.FREELLMAPI_ENABLED = "false";
process.env.OLLAMA_ENABLED = "false";
process.env.OPENROUTER_ENABLED = "false";
process.env.GMAIL_ENABLED = "false";
process.env.RESEND_API_KEY = "***REMOVED***";
delete process.env.RESEND_FROM;
delete process.env.NOTIFICATION_EMAIL;

const db = await import("../lib/db.ts");
const brief = await import("../lib/executive-brief.ts");
const notifications = await import("../lib/notify.ts");
const resend = await import("../lib/resend.ts");
const { setSetting } = await import("../lib/settings.ts");

db.getDb();
notifications.stopNotificationQueue();
db.run("UPDATE profiles SET email = 'owner@example.test', full_name = 'Test Owner' WHERE id = 1");
setSetting("notify_daily_report", true);
setSetting("email", { provider: "gmail", connected: false, sender: "", account: "" });
db.run("DELETE FROM gmail_accounts");

const KEY = process.env.RESEND_API_KEY as string;
const calls: string[] = [];

function mockResend(options: { emailStatus?: number } = {}) {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url === "https://api.resend.com/domains") {
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    if (url === "https://api.resend.com/emails") {
      if ((options.emailStatus ?? 200) >= 400) {
        return new Response(JSON.stringify({ message: "upstream unavailable" }), { status: options.emailStatus });
      }
      return new Response(JSON.stringify({ id: `re-brief-${calls.length}` }), { status: 200 });
    }
    throw new Error(`Unexpected network call: ${url}`);
  }) as typeof fetch;
}

test("the brief is delivered by Resend with no RESEND_FROM and no Gmail connection", async () => {
  const originalFetch = globalThis.fetch;
  calls.length = 0;
  globalThis.fetch = mockResend();
  try {
    const result = await brief.sendExecutiveBriefNow({
      now: new Date("2026-11-27T10:00:00+01:00"),
      source: "admin",
    });
    notifications.stopNotificationQueue();

    assert.equal(result.state, "accepted_by_provider");
    assert.equal(result.provider, "resend");
    assert.equal(result.sender, "AT AI Workforce <onboarding@resend.dev>");
    assert.match(result.messageId ?? "", /^re-brief-/);
    assert.match(result.message, /Resend has accepted/i);
    assert.equal(result.canResend, false);
    assert.equal(result.staleConfiguration, false);
    assert.equal(
      calls.some((url) => url.includes("googleapis.com")),
      false,
      "Gmail must not be contacted for notification delivery",
    );

    const row = db.one<{ provider: string; delivery: string; sender: string | null; provider_message_id: string }>(
      "SELECT provider, delivery, sender, provider_message_id FROM notification_outbox WHERE report_id = 'brief:2026-11-27'",
    );
    assert.equal(row?.provider, "resend");
    assert.equal(row?.delivery, "accepted_by_provider");
    assert.match(row?.sender ?? "", /onboarding@resend\.dev/);
    assert.match(row?.provider_message_id ?? "", /^re-brief-/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a stored configuration block is reported as historical once the resolver is ready", async () => {
  setSetting("executive_brief_last", {
    reportId: "brief:2026-11-28",
    notificationId: null,
    outboxId: null,
    state: "blocked",
    message: "Your email was not sent. The sending process was blocked because: RESEND_FROM is missing (verified sender address).",
    detail: "RESEND_FROM is missing (verified sender address).",
    recipient: null,
    recipientMasked: "z***@example.test",
    sender: null,
    provider: null,
    subject: "AT Workforce | Daily Executive Brief | 28 Nov 2026",
    messageId: null,
    attempts: 0,
    generatedAt: "2026-11-28T09:00:00.000Z",
  });

  // The snapshot must be the only record for this check, so a newer outbox row
  // cannot mask the stored state under test.
  db.run("DELETE FROM notification_outbox WHERE kind = 'daily_executive_brief'");
  const latest = brief.latestExecutiveBriefDelivery();
  assert.equal(latest.state, "blocked", "the historical state is not rewritten");
  assert.equal(latest.staleConfiguration, true);
  assert.match(latest.message, /configuration is resolved now/i);
  assert.match(latest.message, /onboarding@resend\.dev/);
  assert.doesNotMatch(latest.message, /^Your email was not sent\..*because: RESEND_FROM is missing/i);
  assert.equal(latest.canResend, true, "a resolved block still needs an explicit resend");
});

test("a blocked row is resent through Resend once, with an auditable attempt", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockResend();
  try {
    const now = new Date("2026-11-29T10:00:00+01:00");
    db.run(
      `INSERT INTO notification_outbox
         (id, dedupe_key, notification_id, user_id, kind, recipient, subject, body, status, attempts, available_at,
          delivery, provider, last_error, failure_code, report_id, created_at, finished_at)
       VALUES ('mailout_brief_blocked', 'executive_brief:2026-11-29', NULL, NULL, 'daily_executive_brief',
          'owner@example.test', 'Blocked fixture', 'Body', 'failed', 1, ?, 'blocked', NULL,
          'RESEND_FROM is missing (verified sender address).', 'missing_configuration', 'brief:2026-11-29', ?, ?)`,
      [now.toISOString(), now.toISOString(), now.toISOString()],
    );

    const notResent = await brief.sendExecutiveBriefNow({ now, source: "admin" });
    notifications.stopNotificationQueue();
    assert.equal(notResent.state, "blocked");
    assert.match(notResent.detail, /^Previous attempt: RESEND_FROM is missing/);
    assert.match(notResent.detail, /explicit resend/);
    assert.equal(notResent.attempts, 1, "no new attempt is made without an explicit resend");

    const resent = await brief.sendExecutiveBriefNow({ now, source: "admin", resend: true });
    notifications.stopNotificationQueue();
    assert.equal(resent.state, "accepted_by_provider");
    assert.equal(resent.provider, "resend");
    assert.equal(resent.resendCount, 1);
    assert.equal(resent.attempts, 1);
    assert.equal(
      db.one<{ n: number }>("SELECT COUNT(*) AS n FROM notification_outbox WHERE dedupe_key = 'executive_brief:2026-11-29'")?.n,
      1,
      "a resend reuses the same outbox row",
    );
    const row = db.one<{ provider: string; provider_message_id: string; report_id: string }>(
      "SELECT provider, provider_message_id, report_id FROM notification_outbox WHERE dedupe_key = 'executive_brief:2026-11-29'",
    );
    assert.equal(row?.provider, "resend");
    assert.match(row?.provider_message_id ?? "", /^re-brief-/);
    assert.equal(row?.report_id, "brief:2026-11-29", "the original report identity is preserved");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("historical Gmail rows are preserved and never rewritten by a Resend send", async () => {
  const before = db.one<{ provider: string; delivery: string; provider_message_id: string; sent_verification: string | null }>(
    "SELECT provider, delivery, provider_message_id, sent_verification FROM notification_outbox WHERE dedupe_key = 'executive_brief:2026-11-26'",
  );
  if (!before) {
    db.run(
      `INSERT INTO notification_outbox
         (id, dedupe_key, notification_id, user_id, kind, recipient, subject, body, status, attempts, available_at,
          delivery, provider, provider_message_id, sent_verification, report_id, created_at, finished_at)
       VALUES ('mailout_gmail_history', 'executive_brief:2026-11-26', NULL, NULL, 'daily_executive_brief',
          'owner@example.test', 'Historical Gmail brief', 'Body', 'sent', 5, ?, 'sent_folder_observed', 'gmail',
          '1a21cf13d518cdda', 'Present in Gmail Sent.', 'brief:2026-11-26', ?, ?)`,
      ["2026-11-26T15:00:00.000Z", "2026-11-26T13:46:28.355Z", "2026-11-27T12:18:21.834Z"],
    );
  }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockResend();
  try {
    const result = await brief.sendExecutiveBriefNow({ now: new Date("2026-11-30T10:00:00+01:00"), source: "admin" });
    notifications.stopNotificationQueue();
    assert.equal(result.state, "accepted_by_provider");
    const after = db.one<{ provider: string; delivery: string; provider_message_id: string; sent_verification: string | null }>(
      "SELECT provider, delivery, provider_message_id, sent_verification FROM notification_outbox WHERE dedupe_key = 'executive_brief:2026-11-26'",
    );
    assert.equal(after?.provider, "gmail");
    assert.equal(after?.delivery, "sent_folder_observed");
    assert.equal(after?.provider_message_id, "1a21cf13d518cdda");
    assert.equal(after?.sent_verification, "Present in Gmail Sent.");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an expired Gmail grant cannot block the brief", async () => {
  db.run(
    `INSERT OR REPLACE INTO gmail_accounts (id, email, access_token, refresh_token, expires_at, scopes, connected_at)
     VALUES (1, 'owner@example.test', 'v1.invalid', 'v1.invalid', '2020-01-01T00:00:00.000Z', 'gmail.send', '2026-11-20T00:00:00.000Z')`,
  );
  const originalFetch = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    seen.push(url);
    if (url === "https://api.resend.com/domains") return new Response("{}", { status: 200 });
    if (url === "https://api.resend.com/emails") return new Response(JSON.stringify({ id: "re-expired-gmail" }), { status: 200 });
    throw new Error(`Unexpected network call: ${url}`);
  }) as typeof fetch;
  try {
    const result = await brief.sendExecutiveBriefNow({ now: new Date("2026-12-01T10:00:00+01:00"), source: "admin" });
    notifications.stopNotificationQueue();
    assert.equal(result.state, "accepted_by_provider");
    assert.equal(seen.some((url) => url.includes("oauth2.googleapis.com")), false);
  } finally {
    globalThis.fetch = originalFetch;
    db.run("DELETE FROM gmail_accounts");
  }
});

test("a missing API key blocks before any request and names the variable", async () => {
  const originalFetch = globalThis.fetch;
  const key = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new Error("must not contact Resend");
  }) as typeof fetch;
  try {
    const result = await brief.sendExecutiveBriefNow({ now: new Date("2026-12-02T10:00:00+01:00"), source: "admin" });
    notifications.stopNotificationQueue();
    assert.equal(result.state, "blocked");
    assert.match(result.message, /RESEND_API_KEY is missing/);
    assert.equal(result.outboxId, null);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    process.env.RESEND_API_KEY = key;
  }
});

test("a failed send does not consume the free allowance", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockResend({ emailStatus: 503 });
  try {
    const before = resend.resendFreeTierUsage();
    const result = await brief.sendExecutiveBriefNow({ now: new Date("2026-12-03T10:00:00+01:00"), source: "admin" });
    notifications.stopNotificationQueue();
    assert.notEqual(result.state, "accepted_by_provider");
    const after = resend.resendFreeTierUsage();
    assert.equal(after.acceptedToday, before.acceptedToday, "only accepted sends count toward the allowance");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the dashboard sender and readiness come from the same resolver", () => {
  const page = readFileSync("app/admin/email/page.tsx", "utf8");
  assert.match(page, /resendConfig\(\)/, "the dashboard reads the authoritative resolver");
  assert.match(page, /resendFreeTierUsage\(\)/);
  assert.match(page, /resendAccepted/);
  assert.match(page, /staleConfiguration/);
  assert.equal(resend.resendConfig().from, "AT AI Workforce <onboarding@resend.dev>");

  process.env.RESEND_FROM = "AT AI Workforce <notify@verified.example.test>";
  try {
    const configured = resend.resendConfig();
    assert.equal(configured.from, "AT AI Workforce <notify@verified.example.test>");
    assert.equal(configured.usingTestSender, false);
    assert.deepEqual(resend.resendMissing(), []);
  } finally {
    delete process.env.RESEND_FROM;
  }
});

test.after(() => {
  notifications.stopNotificationQueue();
  db.closeDb();
});

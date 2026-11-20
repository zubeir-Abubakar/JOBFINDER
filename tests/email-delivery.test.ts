import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-email-delivery-"));
process.env.APP_SECRET_KEY = "email-delivery-test-secret";
process.env.FREELLMAPI_ENABLED = "false";
process.env.OLLAMA_ENABLED = "false";
process.env.OPENROUTER_ENABLED = "false";
process.env.GMAIL_ENABLED = "true";
process.env.GOOGLE_CLIENT_ID = "test-client";
process.env.GOOGLE_CLIENT_SECRET = "test-secret";
process.env.GOOGLE_REDIRECT_URI = "https://app.example.test/api/gmail/oauth/callback";
delete process.env.APP_BASE_URL;
delete process.env.NEXT_PUBLIC_APP_BASE_URL;

import type { DeliveryState } from "../lib/notify.ts";

const db = await import("../lib/db.ts");
const notifications = await import("../lib/notify.ts");
const brief = await import("../lib/executive-brief.ts");
const gmail = await import("../lib/gmail.ts");
const { REQUIRED_GMAIL_SCOPES, GMAIL_IDENTITY_SCOPES } = await import("../lib/gmail-profile.ts");
const { setSetting } = await import("../lib/settings.ts");

db.getDb();
notifications.stopNotificationQueue();
const allScopes = [...REQUIRED_GMAIL_SCOPES, ...GMAIL_IDENTITY_SCOPES].join(" ");
db.run("UPDATE profiles SET email = 'owner@example.test', full_name = 'Test Owner' WHERE id = 1");
db.run(
  `INSERT INTO gmail_accounts (id, email, access_token, refresh_token, expires_at, scopes, connected_at)
   VALUES (1, 'owner@example.test', 'v1.invalid', 'v1.invalid', '2030-01-01T00:00:00.000Z', ?, '2026-11-20T00:00:00.000Z')`,
  [allScopes],
);
setSetting("email", {
  provider: "gmail",
  connected: true,
  sender: "owner@example.test",
  account: "owner@example.test",
});
setSetting("notify_daily_report", true);
notifications.stopNotificationQueue();

const ready = async () => ({ ok: true, code: "ready" as const, detail: "Fixture Gmail is ready.", email: "owner@example.test" });

test("Send Now generates outside the schedule and returns the persisted evidence state", async () => {
  let sends = 0;
  const delivery = await brief.sendExecutiveBriefNow({
    now: new Date("2026-12-01T09:30:00+01:00"),
    source: "coordinator",
    readiness: ready,
    send: async ({ rfcMessageId }) => {
      sends += 1;
      return {
        messageId: "gmail-send-now-1",
        threadId: "gmail-thread-1",
        rfcMessageId,
        sentObserved: true,
        sentFolderDetail: "Fixture message found in Gmail Sent.",
        sentFolderCheckedAt: "2026-12-01T08:31:00.000Z",
        deliveryEvidence: "Fixture Sent label contains gmail-send-now-1.",
      };
    },
  });
  notifications.stopNotificationQueue();

  assert.equal(sends, 1);
  assert.equal(delivery.state, "sent_folder_observed");
  assert.equal(delivery.messageId, "gmail-send-now-1");
  assert.equal(delivery.threadId, "gmail-thread-1");
  assert.match(delivery.reportId, /^brief:2026-12-01$/);
  assert.match(delivery.outboxId ?? "", /^mailout_/);
  assert.equal(delivery.dashboardUrl, null);
  assert.match(delivery.message, /found in the connected Gmail Sent folder/i);
  assert.doesNotMatch(delivery.message, /check your inbox|delivered/i);

  const row = db.one<{ body: string; html_body: string; delivery: string; report_id: string; attempts: number }>(
    "SELECT body, html_body, delivery, report_id, attempts FROM notification_outbox WHERE id = ?",
    [delivery.outboxId],
  );
  assert.equal(row?.delivery, "sent_folder_observed");
  assert.equal(row?.report_id, "brief:2026-12-01");
  assert.equal(row?.attempts, 1);
  assert.match(row?.body ?? "", /Dashboard link unavailable/);
  assert.doesNotMatch(row?.html_body ?? "", /https?:\/\/(?:localhost|127\.0\.0\.1)|\.local(?=[/:])/i);
});

test("a repeated Send Now does not submit a duplicate message", async () => {
  let sends = 0;
  const delivery = await brief.sendExecutiveBriefNow({
    now: new Date("2026-12-01T09:35:00+01:00"),
    readiness: ready,
    send: async () => {
      sends += 1;
      return { messageId: "should-not-send", threadId: null };
    },
  });
  notifications.stopNotificationQueue();
  assert.equal(sends, 0);
  assert.equal(delivery.state, "sent_folder_observed");
  assert.match(delivery.detail, /duplicate|already has an outbox record/i);
});

test("accepted Gmail delivery stays distinct until Sent-folder evidence arrives", async () => {
  const delivery = await brief.sendExecutiveBriefNow({
    now: new Date("2026-12-02T10:00:00+01:00"),
    readiness: ready,
    send: async ({ rfcMessageId }) => ({
      messageId: "gmail-accepted-2",
      threadId: "gmail-thread-2",
      rfcMessageId,
      sentObserved: false,
      sentFolderDetail: "Sent-folder check did not complete.",
      deliveryEvidence: "Gmail API acceptance only.",
    }),
  });
  notifications.stopNotificationQueue();
  assert.equal(delivery.state, "accepted_by_gmail");
  assert.equal(delivery.sentObservedAt, null);

  const delayed = await notifications.refreshOutboxSentObservation(delivery.outboxId as string, async (messageId) => ({
    observed: true,
    messageId,
    threadId: "gmail-thread-2",
    labels: ["SENT"],
    method: "message-id",
    detail: "Delayed fixture Sent-folder observation.",
    checkedAt: "2026-12-02T09:05:00.000Z",
  }));
  assert.equal(delayed.state, "sent_folder_observed");
  assert.equal(delayed.row?.sent_observed_at, "2026-12-02T09:05:00.000Z");
});

test("missing Gmail permission blocks Send Now without creating an outbox row", async () => {
  const delivery = await brief.sendExecutiveBriefNow({
    now: new Date("2026-12-03T10:00:00+01:00"),
    readiness: async () => ({
      ok: false,
      code: "permission_denied",
      detail: "Gmail is missing required permissions: send.",
      email: "owner@example.test",
    }),
    send: async () => {
      throw new Error("must not send");
    },
  });
  notifications.stopNotificationQueue();
  assert.equal(delivery.state, "blocked");
  assert.match(delivery.message, /^Your email was not sent\. The sending process was blocked because:/);
  assert.match(delivery.message, /missing required permissions/i);
  assert.equal(delivery.outboxId, null);
  assert.equal(
    db.one<{ n: number }>("SELECT COUNT(*) AS n FROM notification_outbox WHERE report_id = 'brief:2026-12-03'")?.n,
    0,
  );
});

test("a definitive block can be deliberately resent; an accepted message cannot", async () => {
  const blocked = await brief.sendExecutiveBriefNow({
    now: new Date("2026-12-04T10:00:00+01:00"),
    readiness: ready,
    send: async () => {
      throw new notifications.EmailDeliveryError("Gmail lost the send scope.", {
        code: "permission_denied",
        blocked: true,
      });
    },
  });
  notifications.stopNotificationQueue();
  assert.equal(blocked.state, "blocked");
  assert.equal(blocked.canResend, true);

  const resent = await brief.sendExecutiveBriefNow({
    now: new Date("2026-12-04T10:05:00+01:00"),
    resend: true,
    readiness: ready,
    send: async ({ rfcMessageId }) => ({
      messageId: "gmail-resend-4",
      threadId: "gmail-thread-4",
      rfcMessageId,
      sentObserved: false,
      deliveryEvidence: "Gmail API acceptance after explicit resend.",
    }),
  });
  notifications.stopNotificationQueue();
  assert.equal(resent.state, "accepted_by_gmail");
  assert.equal(resent.resendCount, 1);
  assert.equal(resent.attempts, 1);

  const refused = await brief.sendExecutiveBriefNow({
    now: new Date("2026-12-04T10:10:00+01:00"),
    resend: true,
    readiness: ready,
    send: async () => {
      throw new Error("must not send an already accepted message");
    },
  });
  notifications.stopNotificationQueue();
  assert.equal(refused.state, "accepted_by_gmail");
  assert.equal(refused.resendCount, 1);
  assert.match(refused.detail, /Resend is allowed only/i);
});

test("a confirmed bounce has its own state and explicit evidence", async () => {
  const delivery = await brief.sendExecutiveBriefNow({
    now: new Date("2026-12-05T10:00:00+01:00"),
    readiness: ready,
    send: async ({ rfcMessageId }) => ({
      messageId: "gmail-bounced-5",
      threadId: "gmail-thread-5",
      rfcMessageId,
      sentObserved: true,
      sentFolderDetail: "Message is in Sent.",
    }),
  });
  notifications.stopNotificationQueue();
  const bounced = notifications.recordOutboxDeliveryState(
    delivery.outboxId as string,
    "bounced",
    "mailer-daemon: recipient rejected the message (550)",
  );
  assert.equal(bounced?.delivery, "bounced");
  const reread = notifications.refreshOutboxSentObservation(delivery.outboxId as string, async () => ({
    observed: true,
    messageId: "gmail-bounced-5",
    threadId: "gmail-thread-5",
    detail: "Sent contains the message.",
    checkedAt: "2026-12-05T09:10:00.000Z",
  }));
  assert.equal((await reread).state, "bounced", "Sent-folder evidence must not overwrite a bounce");
});

test("Coordinator wording never promotes an intermediate state to delivery", () => {
  const expected: Record<DeliveryState, RegExp> = {
    generated: /has been generated/i,
    queued: /added to the email outbox.*has not yet been confirmed/i,
    sending: /currently being submitted to Gmail/i,
    accepted_by_gmail: /Gmail has accepted.*has not yet been independently confirmed/i,
    sent_folder_observed: /found in the connected Gmail Sent folder.*not yet confirmed/i,
    delivery_confirmed: /independently confirmed/i,
    blocked: /was not sent.*blocked because/i,
    failed: /could not be sent.*Reason/i,
    bounced: /rejected or bounced/i,
  };
  for (const [state, pattern] of Object.entries(expected)) {
    const message = notifications.deliveryStateMessage(state as DeliveryState, "Fixture reason.");
    assert.match(message, pattern, `${state} must use its exact contract wording`);
    if (state !== "delivery_confirmed") {
      assert.doesNotMatch(message, /has been delivered|check your inbox/i);
    }
  }
});

test("the Gmail adapter records API acceptance and Sent-folder presence separately", async () => {
  const originalFetch = globalThis.fetch;
  const sentScopes = allScopes;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === "https://oauth2.googleapis.com/token") {
      return new Response(
        JSON.stringify({
          access_token: "fixture-access-token",
          refresh_token: "fixture-refresh-token",
          expires_in: 3600,
          scope: sentScopes,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.endsWith("/profile")) {
      return new Response(JSON.stringify({ emailAddress: "owner@example.test" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.endsWith("/messages/send") && method === "POST") {
      return new Response(JSON.stringify({ id: "gmail-api-6", threadId: "gmail-thread-6" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/messages/gmail-api-6?format=minimal")) {
      return new Response(JSON.stringify({ id: "gmail-api-6", threadId: "gmail-thread-6", labelIds: ["SENT"] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/messages?maxResults=5&q=")) {
      return new Response(JSON.stringify({ messages: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`Unexpected Gmail fixture URL: ${method} ${url}`);
  }) as typeof fetch;
  try {
    await gmail.exchangeCode("fixture-code");
    const result = await gmail.sendGmailEmail("owner@example.test", "Fixture brief", "Fixture body", {
      html: "<p>Fixture body</p>",
    });
    assert.equal(result.status, "accepted");
    assert.equal(result.messageId, "gmail-api-6");
    assert.equal(result.threadId, "gmail-thread-6");
    assert.match(result.rfcMessageId ?? "", /^<atw-.+@example\.test>$/);
    assert.equal(result.sentObserved, true);
    assert.match(result.sentFolderDetail ?? "", /Sent label/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Gmail readiness distinguishes missing refresh capability, missing scope and invalid stored credentials", async () => {
  db.run("UPDATE gmail_accounts SET scopes = ?, refresh_token = NULL, access_token = 'v1.invalid' WHERE id = 1", [
    allScopes,
  ]);
  const noRefresh = await gmail.gmailSendReadiness();
  assert.equal(noRefresh.ok, false);
  assert.match(noRefresh.detail, /no stored refresh token/i);

  db.run("UPDATE gmail_accounts SET scopes = ?, refresh_token = 'v1.invalid', access_token = 'v1.invalid' WHERE id = 1", [
    "https://www.googleapis.com/auth/gmail.readonly",
  ]);
  const noScope = await gmail.gmailSendReadiness();
  assert.equal(noScope.ok, false);
  assert.equal(noScope.code, "permission_denied");
  assert.match(noScope.detail, /send/i);

  db.run("UPDATE gmail_accounts SET scopes = ?, refresh_token = 'v1.invalid', access_token = 'v1.invalid' WHERE id = 1", [
    allScopes,
  ]);
  const invalid = await gmail.gmailSendReadiness();
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, "authentication_failed");
  assert.match(invalid.detail, /token format is invalid/i);
});

test("the Coordinator Send Now command reports a blocked delivery without claiming success", async () => {
  db.run("DELETE FROM gmail_accounts WHERE id = 1");
  setSetting("email", { provider: "gmail", connected: false, sender: "", account: "" });
  const assistant = await import("../lib/assistant.ts");
  const result = await assistant.handleAssistantMessage("u_fixture", "Send me today's Executive Brief now.");
  notifications.stopNotificationQueue();
  assert.match(result.reply, /was not sent/i);
  assert.match(result.reply, /No configured notification recipient|Gmail is not connected|blocked/i);
  assert.doesNotMatch(result.reply, /has been sent|check your inbox|report delivered/i);
});

test("a bounce classifier requires a delivery-status sender, the target and explicit failure evidence", () => {
  const clear = gmail.classifyBounceNotice({
    from: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
    subject: "Delivery Status Notification (Failure)",
    snippet: "Your message <atw-1@example.test> to owner@example.test could not be delivered. 550 rejected.",
    recipient: "owner@example.test",
    rfcMessageId: "<atw-1@example.test>",
  });
  assert.equal(clear.detected, true);
  assert.match(clear.evidence ?? "", /mailer-daemon/i);

  const marketing = gmail.classifyBounceNotice({
    from: "news@example.test",
    subject: "Delivery status",
    snippet: "A message about owner@example.test bounced in a blog post.",
    recipient: "owner@example.test",
    rfcMessageId: null,
  });
  assert.equal(marketing.detected, false);
});

test("the admin Send Now action enforces administrator authorization", () => {
  const actions = readFileSync("lib/actions/admin.ts", "utf8");
  assert.match(actions, /export async function sendExecutiveBriefNowAction/);
  assert.match(actions, /sendExecutiveBriefNowAction[\s\S]{0,500}await requireAdmin\(\)/);
  const page = readFileSync("app/admin/email/page.tsx", "utf8");
  assert.match(page, /action=\{sendExecutiveBriefNowAction\}/);
  assert.match(page, /mode\" value=\"resend\"/);
  assert.match(page, /reportId|report_id/);
});

test.after(() => {
  notifications.stopNotificationQueue();
  db.closeDb();
});

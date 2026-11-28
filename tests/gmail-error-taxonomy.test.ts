import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-gmail-taxonomy-"));
process.env.APP_SECRET_KEY = "gmail-taxonomy-test-secret";
process.env.GMAIL_ENABLED = "true";
process.env.GOOGLE_CLIENT_ID = "test-client";
process.env.GOOGLE_CLIENT_SECRET = "test-secret";
process.env.GOOGLE_REDIRECT_URI = "https://app.example.test/api/gmail/oauth/callback";
process.env.FREELLMAPI_ENABLED = "false";
process.env.OLLAMA_ENABLED = "false";
process.env.OPENROUTER_ENABLED = "false";

const db = await import("../lib/db.ts");
const notifications = await import("../lib/notify.ts");
const { getSetting } = await import("../lib/settings.ts");

db.getDb();
notifications.stopNotificationQueue();

const now = new Date("2026-11-27T09:00:00.000Z");

function queueRow(id: string): void {
  db.run(
    `INSERT INTO notification_outbox
       (id, dedupe_key, kind, recipient, subject, body, status, attempts, available_at, delivery, created_at, rfc_message_id)
     VALUES (?, ?, 'agent_failure', 'owner@example.test', 'Fixture subject', 'Fixture body', 'pending', 0, ?, 'queued', ?, ?)`,
    [id, `dedupe-${id}`, now.toISOString(), now.toISOString(), `<atw-${id}@example.test>`],
  );
}

test("a dead refresh grant is stored as invalid_grant and is never silently retried", async () => {
  queueRow("mailout_invalid_grant");
  const result = await notifications.drainNotificationQueue({
    now,
    limit: 1,
    outboxId: "mailout_invalid_grant",
    send: async () => {
      throw new notifications.EmailDeliveryError(
        "Gmail refresh token was rejected (invalid_grant, HTTP 400): the authorisation is expired or was revoked. Reconnect Gmail to grant access again; retrying this message cannot succeed.",
        { code: "invalid_grant", blocked: true, retryable: false },
      );
    },
  });
  notifications.stopNotificationQueue();

  assert.equal(result.failed, 1);
  assert.equal(result.retryScheduled, 0);
  const row = notifications.outboxById("mailout_invalid_grant");
  assert.equal(row?.status, "failed");
  assert.equal(row?.delivery, "blocked");
  assert.equal(row?.failure_code, "invalid_grant");
  assert.match(row?.last_error ?? "", /invalid_grant/);
});

test("a temporary refresh failure is retried and stays distinct from invalid_grant", async () => {
  queueRow("mailout_transient");
  const result = await notifications.drainNotificationQueue({
    now,
    limit: 1,
    outboxId: "mailout_transient",
    send: async () => {
      throw new notifications.EmailDeliveryError(
        "Gmail token refresh failed temporarily (HTTP 503, temporarily_unavailable). The outbox retries it automatically and no reconnection is required yet.",
        { code: "refresh_transient", blocked: false, retryable: true },
      );
    },
  });
  notifications.stopNotificationQueue();

  assert.equal(result.retryScheduled, 1);
  assert.equal(result.failed, 0);
  const row = notifications.outboxById("mailout_transient");
  assert.equal(row?.status, "retry_scheduled");
  assert.equal(row?.delivery, "queued");
  assert.equal(row?.failure_code, "refresh_transient");
  assert.equal(row?.attempts, 1);
  assert.ok(Date.parse(row?.available_at ?? "") > now.getTime(), "a retry must be scheduled in the future");
  assert.match(row?.last_error ?? "", /temporarily/i);

  const last = getSetting<{ errorCode?: string; state?: string }>("email_delivery_last", {});
  assert.equal(last.errorCode, "refresh_transient");
  assert.equal(last.state, "queued");
});

test("a transient message without an explicit code is still classified as retryable", async () => {
  queueRow("mailout_transient_unlabelled");
  const result = await notifications.drainNotificationQueue({
    now,
    limit: 1,
    outboxId: "mailout_transient_unlabelled",
    send: async () => {
      throw new Error("Gmail token refresh failed temporarily (HTTP 503).");
    },
  });
  notifications.stopNotificationQueue();

  assert.equal(result.retryScheduled, 1);
  const row = notifications.outboxById("mailout_transient_unlabelled");
  assert.equal(row?.status, "retry_scheduled");
  assert.equal(row?.failure_code, "refresh_transient");
});

test.after(() => {
  notifications.stopNotificationQueue();
  db.closeDb();
});

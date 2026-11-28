import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-recovery-notify-"));
process.env.APP_SECRET_KEY = "recovery-notify-test-secret";
process.env.FREELLMAPI_ENABLED = "false";
process.env.OLLAMA_ENABLED = "false";
process.env.OPENROUTER_ENABLED = "false";
delete process.env.GEMINI_API_KEY;

const db = await import("../lib/db.ts");
const health = await import("../lib/provider-health.ts");
const notifications = await import("../lib/notify.ts");
const recovery = await import("../lib/recruitment-recovery.ts");
const { setSetting } = await import("../lib/settings.ts");

db.getDb();
db.run(
  "UPDATE profiles SET email = 'zubeir.abubakar525@gmail.com' WHERE id = 1",
);
setSetting("email", {
  provider: "gmail",
  connected: true,
  sender: "zubeir.abubakar525@gmail.com",
  account: "zubeir.abubakar525@gmail.com",
});
setSetting("notify_immediate", true);
setSetting("notify_agent_failure", true);
setSetting("notify_daily_report", true);
db.run(
  `INSERT OR IGNORE INTO gmail_accounts (id, email, access_token, refresh_token, expires_at, scopes, connected_at)
   VALUES (1, 'zubeir.abubakar525@gmail.com', 'test-access', 'test-refresh', ?, 'gmail.send', ?)`,
  [new Date(Date.now() + 3_600_000).toISOString(), new Date().toISOString()],
);

test("provider failures are classified, cooled down once, and cleared on success", () => {
  health.clearProviderCooldowns();
  assert.equal(health.classifyProviderFailure("RESOURCE_EXHAUSTED: quota exceeded"), "quota_exhausted");
  assert.equal(health.classifyProviderFailure("Too many requests", 429), "rate_limited");
  assert.equal(health.classifyProviderFailure("Invalid API key", 401), "authentication");
  const cooldown = health.recordProviderFailure({
    provider: "freellmapi",
    model: "gpt-oss-20b",
    kind: "quota_exhausted",
    message: "RESOURCE_EXHAUSTED: free-tier daily quota exceeded",
  });
  assert.ok(cooldown.remainingMs >= 60_000);
  assert.equal(cooldown.kind, "quota_exhausted");
  assert.ok(health.providerCooldown("freellmapi", "gpt-oss-20b"));
  health.recordProviderSuccess("freellmapi", "gpt-oss-20b");
  assert.equal(health.providerCooldown("freellmapi", "gpt-oss-20b"), null);
});

test("notification events are deduplicated and Gmail acceptance is recorded separately", async () => {
  const first = notifications.notify({
    kind: "job_discovery_completed",
    subject: "Discovery completed",
    body: "One durable event.",
    dedupeKey: "test:discovery:one",
  });
  const duplicate = notifications.notify({
    kind: "job_discovery_completed",
    subject: "Discovery completed",
    body: "One durable event.",
    dedupeKey: "test:discovery:one",
  });
  assert.equal(first.notificationId, duplicate.notificationId);
  assert.equal(duplicate.emailQueued, false);
  assert.equal(
    db.one<{ n: number }>("SELECT COUNT(*) AS n FROM notifications WHERE dedupe_key = 'test:discovery:one'")?.n,
    1,
  );
  assert.equal(
    db.one<{ n: number }>("SELECT COUNT(*) AS n FROM notification_outbox WHERE dedupe_key = 'test:discovery:one'")?.n,
    1,
  );
  const storedHtml = db.one<{ html_body: string | null }>(
    "SELECT html_body FROM notification_outbox WHERE dedupe_key = 'test:discovery:one'",
  );
  assert.match(storedHtml?.html_body ?? "", /cid:atw-logo/);

  const sent = await notifications.drainNotificationQueue({
    send: async () => ({ messageId: "gmail-test-id", threadId: "gmail-thread-id" }),
  });
  assert.equal(sent.sent, 1);
  const row = db.one<{ status: string; delivery: string | null; provider_message_id: string | null }>(
    "SELECT status, delivery, provider_message_id FROM notification_outbox WHERE dedupe_key = 'test:discovery:one'",
  );
  assert.equal(row?.status, "sent");
  assert.equal(row?.delivery, "accepted_by_provider");
  assert.equal(row?.provider_message_id, "gmail-test-id");
});

test("approval, failed-submission and unverified-submission events all enqueue Gmail", async () => {
  for (const kind of ["application_approval_required", "application_failed", "application_submission_unverified"] as const) {
    const event = notifications.notify({
      kind,
      subject: `Test ${kind}`,
      body: "Controlled notification acceptance test; the send boundary is mocked.",
      dedupeKey: `test:${kind}`,
    });
    assert.equal(event.emailQueued, true, `${kind} must be in the Gmail allowlist`);
    const row = db.one<{ recipient: string; status: string }>(
      "SELECT recipient, status FROM notification_outbox WHERE dedupe_key = ?",
      [`test:${kind}`],
    );
    assert.equal(row?.recipient, "zubeir.abubakar525@gmail.com");
    assert.equal(row?.status, "pending");
  }
  const delivered = await notifications.drainNotificationQueue({
    send: async () => ({ messageId: "controlled-notification-id", threadId: "controlled-thread-id" }),
  });
  assert.equal(delivered.sent, 3, "the three events use the mocked Gmail sender and send nothing real");
});

test("a failed document stage resumes from the saved vacancy without repeating discovery", async () => {
  const now = new Date().toISOString();
  db.run(
    "INSERT INTO recruitment_runs (id, run_key, scheduled_for, trigger, status, state_history, packages_prepared, created_at) VALUES ('run_recovery', '2026-11-19#recovery', ?, 'manual', 'completed_with_warnings', '[]', 0, ?)",
    [now, now],
  );
  db.run(
    "INSERT INTO jobs (id, source, title, company, status, qualified, match_score, document_state, discovered_at) VALUES ('job_recovery', 'test', 'Senior QA Engineer', 'Acme', 'shortlisted', 1, 92, 'awaiting_documents', ?)",
    [now],
  );
  for (const [id, kind, mime, name] of [
    ["doc_recovery_cv", "tailored_cv", "application/pdf", "recovery-cv.pdf"],
    ["doc_recovery_cover", "cover_letter", "application/pdf", "recovery-cover.pdf"],
  ] as const) {
    db.run(
      `INSERT INTO documents
         (id, user_id, kind, display_name, file_name, mime, relative_path, size_bytes, status, job_id, version, quality_status, quality_score, text_content, created_at)
       VALUES (?, 'system', ?, ?, ?, ?, ?, 1200, 'ready', 'job_recovery', '1.0', 'passed', 100, 'Verified recovery fixture.', ?)`,
      [id, kind, `${kind} fixture`, name, mime, name, now],
    );
  }
  db.run(
    `INSERT INTO applications (id, job_id, status, cv_document_id, cover_letter_id, last_update, created_at)
     VALUES ('app_recovery', 'job_recovery', 'awaiting_documents', 'doc_recovery_cv', 'doc_recovery_cover', ?, ?)`,
    [now, now],
  );

  const queued = recovery.enqueueDocumentRecovery({
    runId: "run_recovery",
    jobId: "job_recovery",
    applicationId: "app_recovery",
    error: "FreeLLMAPI quota exhausted; Ollama unavailable.",
  });
  assert.equal(queued.queued, true);
  assert.equal(
    db.one<{ state: string }>("SELECT document_state AS state FROM jobs WHERE id = 'job_recovery'")?.state,
    "awaiting_documents",
  );

  const result = await recovery.processRecoveryQueue({
    now: new Date(Date.now() + 10_000),
    prepare: async () => ({ ok: true, message: "Recovered package", applicationId: "app_recovery", warnings: [] }),
  });
  assert.equal(result.completed, 1);
  assert.equal(
    db.one<{ status: string }>("SELECT status FROM recruitment_recovery WHERE id = ?", [queued.id])?.status,
    "completed",
  );
  assert.equal(
    db.one<{ state: string }>("SELECT document_state AS state FROM jobs WHERE id = 'job_recovery'")?.state,
    "prepared",
  );
  assert.equal(
    db.one<{ status: string }>("SELECT status FROM applications WHERE id = 'app_recovery'")?.status,
    "quality_check",
  );
  assert.equal(
    db.one<{ n: number }>("SELECT packages_prepared AS n FROM recruitment_runs WHERE id = 'run_recovery'")?.n,
    1,
  );

  // The same checkpoint is idempotent: a second attempt does not duplicate the package.
  const repeated = recovery.enqueueDocumentRecovery({
    runId: "run_recovery",
    jobId: "job_recovery",
    applicationId: "app_recovery",
    error: "repeat",
  });
  assert.equal(repeated.queued, false);
  assert.equal(repeated.id, queued.id);
});

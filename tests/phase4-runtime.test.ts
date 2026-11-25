import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "atw-phase4-"));
process.env.DATA_DIR = dataDir;
process.env.APP_SECRET_KEY = "phase4-runtime-test-secret";
process.env.RECRUITMENT_SCHEDULER = "false";
process.env.RECRUITMENT_SUBMISSION_ENABLED = "false";
process.env.RECRUITMENT_DRY_RUN = "true";
process.env.ENABLE_HSTS = "true";
process.env.FREELLMAPI_ENABLED = "false";
process.env.OLLAMA_ENABLED = "false";
delete process.env.GEMINI_API_KEY;

const db = await import("../lib/db.ts");
const runtime = await import("../lib/runtime-state.ts");
const runs = await import("../lib/recruitment-run.ts");
const notifications = await import("../lib/notify.ts");
const lifecycle = await import("../lib/runtime-lifecycle.ts");
const health = await import("../lib/runtime-health.ts");
const schedule = await import("../lib/recruitment-schedule.ts");
const { setSetting } = await import("../lib/settings.ts");
const auth = await import("../lib/auth.ts");
const security = await import("../lib/security.ts");
const { proxy, config: proxyConfig } = await import("../proxy.ts");
const { NextRequest } = await import("next/server");
const nextConfig = (await import("../next.config.ts")).default;
const csp = await import("../lib/csp.ts");

db.getDb();

test("runtime leases are exclusive across instances and expire to a new owner", () => {
  const key = "test:exclusive-lease";
  assert.equal(runtime.acquireRuntimeLock(key, 30_000, "instance-a"), true);
  assert.equal(runtime.acquireRuntimeLock(key, 30_000, "instance-b"), false);
  assert.equal(runtime.refreshRuntimeLock(key, 30_000, "instance-a"), true);
  const active = runtime.runtimeLockSnapshot().find((row) => row.key === key);
  assert.equal(active?.owner, "instance-a");
  assert.equal(active?.active, true);
  runtime.releaseRuntimeLock(key, "instance-a");
  assert.equal(runtime.acquireRuntimeLock(key, 30_000, "instance-b"), true);
  runtime.releaseRuntimeLock(key, "instance-b");
});

test("the process identity is stable for the life of the process", () => {
  assert.equal(runtime.runtimeInstanceId(), runtime.runtimeInstanceId());
  assert.match(runtime.runtimeInstanceId(), /:\d+$/);
});

test("worker heartbeats distinguish running, stale and stopped workers", () => {
  runtime.startRuntimeWorker("test_worker", "phase 4 test");
  let row = runtime.runtimeWorkerSnapshot().find((worker) => worker.name === "test_worker");
  assert.equal(row?.effectiveStatus, "running");
  db.run("UPDATE runtime_workers SET heartbeat_at = ? WHERE name = 'test_worker'", [
    new Date(Date.now() - 10 * 60_000).toISOString(),
  ]);
  row = runtime.runtimeWorkerSnapshot().find((worker) => worker.name === "test_worker");
  assert.equal(row?.effectiveStatus, "stale");
  db.run("UPDATE runtime_workers SET heartbeat_at = 'not-a-timestamp' WHERE name = 'test_worker'");
  row = runtime.runtimeWorkerSnapshot().find((worker) => worker.name === "test_worker");
  assert.equal(row?.effectiveStatus, "stale", "an unparseable heartbeat is not treated as fresh execution");
  runtime.stopRuntimeWorker("test_worker", "test complete");
  row = runtime.runtimeWorkerSnapshot().find((worker) => worker.name === "test_worker");
  assert.equal(row?.effectiveStatus, "stopped");
});

test("an idle stale queue worker is dormant instead of degrading the application", () => {
  const previousSchedule = schedule.ensureSchedule().enabled;
  schedule.setScheduleEnabled(false);
  db.run("DELETE FROM recruitment_recovery");
  runtime.startRuntimeWorker("document_recovery", "idle-worker test");
  db.run("UPDATE runtime_workers SET heartbeat_at = ? WHERE name = 'document_recovery'", [
    new Date(Date.now() - 10 * 60_000).toISOString(),
  ]);
  const snapshot = health.operationalHealthSnapshot();
  assert.equal(
    snapshot.status,
    "operational",
    `${snapshot.detail} permission=${snapshot.database.permissionWarning} workers=${snapshot.workers.map((worker) => `${worker.name}:${worker.effectiveStatus}`).join(",")}`,
  );
  assert.match(snapshot.detail, /dormant/i);
  runtime.stopRuntimeWorker("document_recovery", "test complete");
  schedule.setScheduleEnabled(previousSchedule === 1);
});

test("an abandoned run and its task are marked interrupted, while a safe scheduled run is resumed", () => {
  const now = new Date("2026-11-19T12:00:00.000Z");
  db.run("INSERT INTO workflows (id, kind, label, status, created_at) VALUES ('wf_phase4', 'autonomous_recruitment', 'Phase 4 recovery', 'running', ?)", [now.toISOString()]);
  db.run(
    "INSERT INTO tasks (id, workflow_id, agent_key, title, status, started_at, created_at) VALUES ('task_phase4', 'wf_phase4', 'research', 'Discovery', 'running', ?, ?)",
    [now.toISOString(), now.toISOString()],
  );
  db.run(
    `INSERT INTO recruitment_runs (id, run_key, workflow_id, scheduled_for, trigger, status, state_history, started_at, created_at)
     VALUES ('run_abandoned', 'phase4#abandoned', 'wf_phase4', ?, 'manual', 'analysing', ?, ?, ?)`,
    [new Date(now.getTime() - 20 * 60_000).toISOString(), JSON.stringify([{ state: "analysing", at: now.toISOString() }]), new Date(now.getTime() - 30 * 60_000).toISOString(), new Date(now.getTime() - 30 * 60_000).toISOString()],
  );
  const recovered = runs.recoverInterruptedRecruitmentRuns(now);
  assert.equal(recovered.interrupted.includes("run_abandoned"), true);
  assert.equal(db.one<{ status: string }>("SELECT status FROM recruitment_runs WHERE id = 'run_abandoned'")?.status, "interrupted");
  assert.equal(db.one<{ status: string }>("SELECT status FROM tasks WHERE id = 'task_phase4'")?.status, "failed");

  db.run(
    `INSERT INTO recruitment_runs (id, run_key, scheduled_for, trigger, status, state_history, created_at)
     VALUES ('run_scheduled_safe', 'phase4#scheduled', ?, 'schedule', 'scheduled', ?, ?)`,
    [new Date(now.getTime() - 60_000).toISOString(), JSON.stringify([{ state: "scheduled", at: now.toISOString() }]), new Date(now.getTime() - 60_000).toISOString()],
  );
  const safe = runs.recoverInterruptedRecruitmentRuns(now);
  assert.equal(safe.resumed.includes("run_scheduled_safe"), true);
  assert.equal(db.one<{ status: string }>("SELECT status FROM recruitment_runs WHERE id = 'run_scheduled_safe'")?.status, "scheduled");
});

test("two notification workers cannot send the same outbox row", async () => {
  db.run("UPDATE profiles SET email = 'phase4@example.com' WHERE id = 1");
  setSetting("email", { provider: "gmail", connected: true, sender: "phase4@example.com", account: "phase4@example.com" });
  setSetting("notify_immediate", true);
  db.run(
    `INSERT OR IGNORE INTO gmail_accounts (id, email, access_token, refresh_token, expires_at, scopes, connected_at)
     VALUES (1, 'phase4@example.com', 'test-access', 'test-refresh', ?, 'gmail.send', ?)`,
    [new Date(Date.now() + 3_600_000).toISOString(), new Date().toISOString()],
  );
  const queued = notifications.notify({
    kind: "application_submitted",
    subject: "Phase 4 atomic outbox",
    body: "This is a mocked delivery, not a real email.",
    dedupeKey: "phase4:atomic-outbox",
  });
  assert.equal(queued.emailQueued, true);
  notifications.stopNotificationQueue();
  let sends = 0;
  const send = async () => {
    sends += 1;
    await new Promise((resolve) => setTimeout(resolve, 40));
    return { messageId: "phase4-mock-id", threadId: "phase4-thread" };
  };
  await Promise.all([
    notifications.drainNotificationQueue({ send, limit: 1 }),
    notifications.drainNotificationQueue({ send, limit: 1 }),
  ]);
  assert.equal(sends, 1, "the outbox row is claimed by exactly one worker");
  const row = db.one<{ status: string; attempts: number; provider_message_id: string | null }>(
    "SELECT status, attempts, provider_message_id FROM notification_outbox WHERE dedupe_key = 'phase4:atomic-outbox'",
  );
  assert.equal(row?.status, "sent");
  assert.equal(row?.attempts, 1);
  assert.equal(row?.provider_message_id, "phase4-mock-id");
  const outbox = notifications.notificationQueueSnapshot();
  assert.equal(outbox.deliveryCounts.accepted_by_gmail, 1);
  assert.equal(outbox.deliveryCounts.sent_folder_observed, 0);
  assert.equal(outbox.deliveryCounts.delivery_confirmed, 0);
  assert.equal(outbox.lastAccepted?.delivery, "accepted_by_gmail", "the last accepted query cannot return a merely Sent-folder row");
});

test("notification retries are bounded and end in a failed dead-letter row", async () => {
  setSetting("notify_immediate", true);
  notifications.notify({
    kind: "application_failed",
    subject: "Phase 4 bounded retries",
    body: "This is a mocked delivery, not a real email.",
    dedupeKey: "phase4:bounded-retries",
  });
  notifications.stopNotificationQueue();
  const send = async () => {
    throw new Error("temporary transport outage");
  };
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const now = new Date(Date.now() + attempt * 60_000);
    const result = await notifications.drainNotificationQueue({ send, now, limit: 1 });
    assert.equal(result.attempted, 1);
    db.run("UPDATE notification_outbox SET available_at = ? WHERE dedupe_key = 'phase4:bounded-retries'", [
      new Date(now.getTime() - 1_000).toISOString(),
    ]);
  }
  const row = db.one<{ status: string; attempts: number; last_error: string | null }>(
    "SELECT status, attempts, last_error FROM notification_outbox WHERE dedupe_key = 'phase4:bounded-retries'",
  );
  assert.equal(row?.status, "failed");
  assert.equal(row?.attempts, 5);
  assert.match(row?.last_error ?? "", /temporary transport outage/);
});

test("passwords use salted scrypt and expired or disabled sessions are rejected", () => {
  const hash = security.hashPassword("Phase4-Test-Password!9");
  assert.notEqual(hash, "Phase4-Test-Password!9");
  assert.equal(security.verifyPassword("Phase4-Test-Password!9", hash), true);
  assert.equal(security.verifyPassword("wrong-password", hash), false);
  assert.equal(security.passwordIssues("weak"), "Password must be at least 10 characters.");

  db.run(
    "INSERT INTO users (id, email, password_hash, name, role, status, must_change_password, created_at) VALUES ('u_phase4_auth', 'phase4-auth@example.com', ?, 'Phase 4', 'owner', 'active', 0, ?)",
    [hash, new Date().toISOString()],
  );
  const token = security.newToken();
  db.run("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, 'u_phase4_auth', ?, ?)", [
    security.sha256(token),
    new Date().toISOString(),
    new Date(Date.now() + 60_000).toISOString(),
  ]);
  const active = auth.sessionUserFromToken(token);
  assert.equal(active?.role, "owner");
  assert.equal(active?.email, "phase4-auth@example.com");

  db.run("UPDATE sessions SET expires_at = ? WHERE token_hash = ?", [new Date(Date.now() - 1_000).toISOString(), security.sha256(token)]);
  assert.equal(auth.sessionUserFromToken(token), null);
  assert.equal(db.one("SELECT token_hash FROM sessions WHERE token_hash = ?", [security.sha256(token)]), null);

  const savedHttps = process.env.ATW_HTTPS;
  process.env.ATW_HTTPS = "1";
  assert.equal(auth.secureCookieForRequest(new Headers({ host: "localhost:3000" })), true, "HTTPS dev cookies are Secure");
  delete process.env.ATW_HTTPS;
  assert.equal(auth.secureCookieForRequest(new Headers({ host: "localhost:3000" })), false, "plain HTTP dev cookies stay usable");
  if (savedHttps !== undefined) process.env.ATW_HTTPS = savedHttps;
});

test("proxy rejects cross-site writes and rate-limits a general API path", () => {
  const crossSite = proxy(
    new NextRequest("http://localhost/api/phase4-write", {
      method: "POST",
      headers: { host: "localhost", origin: "https://evil.example", "sec-fetch-site": "cross-site" },
    }),
  );
  assert.equal(crossSite.status, 403);

  const sameSite = proxy(
    new NextRequest("http://localhost/api/phase4-write", {
      method: "POST",
      headers: { host: "localhost", origin: "http://localhost" },
    }),
  );
  assert.equal(sameSite.status, 200);

  const oversized = proxy(
    new NextRequest("http://localhost/api/phase4-write", {
      method: "POST",
      headers: { host: "localhost", "content-length": "1000001" },
    }),
  );
  assert.equal(oversized.status, 413);

  let last: Response | null = null;
  for (let i = 0; i < 181; i += 1) {
    last = proxy(
      new NextRequest("http://localhost/api/phase4-rate-limit", {
        method: "GET",
        headers: { host: "localhost", "x-forwarded-for": "198.51.100.9" },
      }),
    );
  }
  assert.equal(last?.status, 429);
  assert.ok(Number(last?.headers.get("retry-after") ?? 0) > 0);
});

test("health reports database, worker and scheduler state from persisted data", () => {
  const snapshot = health.operationalHealthSnapshot();
  assert.equal(snapshot.database.integrity, "ok");
  assert.equal(snapshot.database.ok, true);
  assert.ok(snapshot.database.schemaVersion >= 15);
  assert.ok(snapshot.scheduler.nextRunAt);
  assert.ok(snapshot.workers.length >= 1);
  assert.equal(snapshot.database.permissionWarning, null);
  assert.equal(snapshot.executiveBrief.time, "16:00");
  assert.equal(snapshot.executiveBrief.timezone, "Europe/Zurich");
  assert.equal(snapshot.executiveBrief.requiresRunningHost, true);
  assert.equal(snapshot.executiveBrief.heartbeatAgeSeconds, null, "no persisted scheduler tick is reported as no evidence");
  assert.equal(snapshot.executiveBrief.stale, true, "a schedule with no tick evidence is stale, not assumed running");
});

test("security headers include a restrictive CSP and transport protections", async () => {
  const configured = await nextConfig.headers?.();
  const headers = configured?.[0]?.headers ?? [];
  const policy = csp.contentSecurityPolicy("test-nonce", { development: false });
  assert.match(policy, /frame-ancestors 'none'/);
  assert.match(policy, /object-src 'none'/);
  assert.match(policy, /script-src 'self' 'nonce-test-nonce' 'strict-dynamic'/);
  assert.doesNotMatch(policy, /unsafe-inline.*script|script[^;]*unsafe-inline/);
  assert.doesNotMatch(policy, /unsafe-eval/);
  assert.match(policy, /script-src-attr 'none'/);
  assert.ok(headers.some((header) => header.key === "Strict-Transport-Security"));
  assert.ok(headers.some((header) => header.key === "X-Content-Type-Options"));
  assert.ok(proxyConfig.matcher.includes("/((?!_next/static|_next/image|favicon.ico).*)"), "page and API routes must invoke the proxy");
});

test("backup and restore produce a verified, isolated database copy", () => {
  db.run("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('phase4:restore-marker', ?, ?)", [
    JSON.stringify({ marker: "restored" }),
    new Date().toISOString(),
  ]);
  const oldBackup = join(dataDir, "backups", "atw-backup-old");
  mkdirSync(oldBackup, { recursive: true });
  const old = (Date.now() - 3 * 86_400_000) / 1000;
  utimesSync(oldBackup, old, old);
  const backupEnv = { ...process.env, DATA_DIR: dataDir, BACKUP_RETENTION_DAYS: "1" };
  const backup = spawnSync(process.execPath, ["scripts/backup.mjs"], { cwd: process.cwd(), env: backupEnv, encoding: "utf8" });
  assert.equal(backup.status, 0, backup.stderr || backup.stdout);
  const backupRoot = join(dataDir, "backups");
  const backupName = readdirSync(backupRoot).filter((name) => name.startsWith("atw-backup-")).sort().at(-1);
  assert.ok(backupName);
  assert.equal(existsSync(oldBackup), false, "an expired backup is removed by retention");
  const backupDir = join(backupRoot, backupName!);
  const restoreTarget = join(dataDir, "restore-check");
  const restore = spawnSync(
    process.execPath,
    ["scripts/restore.mjs", "--backup", backupDir, "--target", restoreTarget],
    { cwd: process.cwd(), env: { ...process.env, DATA_DIR: join(dataDir, "not-the-live-dir") }, encoding: "utf8" },
  );
  assert.equal(restore.status, 0, restore.stderr || restore.stdout);
  const restored = new DatabaseSync(join(restoreTarget, "at-ai-workforce.db"), { readOnly: true });
  try {
    assert.equal(restored.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
    const marker = restored.prepare("SELECT value FROM settings WHERE key = 'phase4:restore-marker'").get() as { value: string };
    assert.equal(JSON.parse(marker.value).marker, "restored");
  } finally {
    restored.close();
  }
});

test("graceful shutdown stops all worker timers and records stopped state", () => {
  lifecycle.stopBackgroundWorkers("phase4 test shutdown");
  assert.equal(lifecycle.shutdownState().shuttingDown, true);
  const workers = runtime.runtimeWorkerSnapshot();
  const notification = workers.find((worker) => worker.name === "notification_outbox");
  assert.equal(notification?.effectiveStatus, "stopped");
});

test.after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

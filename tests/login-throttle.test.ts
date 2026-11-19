import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const temp = mkdtempSync(join(tmpdir(), "atw-login-throttle-"));
process.env.DATA_DIR = temp;
process.env.APP_SECRET_KEY = "test-only-login-throttle-secret";

const db = await import("../lib/db");
const { loginThrottleState, LOGIN_THROTTLE_WINDOW_MS } = await import("../lib/login-throttle");

db.getDb();

function failed(email: string, ip: string, at: Date): void {
  db.run(
    "INSERT INTO audit_logs (action, entity, entity_id, detail, ip, created_at) VALUES ('login.failed', 'user', ?, 'Invalid credentials', ?, ?)",
    [email, ip, at.toISOString()],
  );
}

test("failed logins are counted durably for the account and IP", () => {
  const now = new Date("2026-11-19T12:00:00.000Z");
  failed("owner@example.com", "198.51.100.1", new Date(now.getTime() - 60_000));
  failed("owner@example.com", "198.51.100.1", new Date(now.getTime() - 120_000));

  const early = loginThrottleState({ email: "owner@example.com", ip: "198.51.100.1", limit: 3, now });
  assert.equal(early.blocked, false);
  assert.equal(early.attempts, 2);

  failed("owner@example.com", "198.51.100.1", new Date(now.getTime() - 180_000));
  const blocked = loginThrottleState({ email: "owner@example.com", ip: "198.51.100.1", limit: 3, now });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.attempts, 3);
  assert.ok(blocked.retryAfterSeconds > 0);
  assert.ok(blocked.retryAfterSeconds <= LOGIN_THROTTLE_WINDOW_MS / 1000);
});

test("a different account and IP is not blocked, and old failures expire", () => {
  const now = new Date("2026-11-19T12:00:00.000Z");
  const other = loginThrottleState({ email: "other@example.com", ip: "198.51.100.2", limit: 3, now });
  assert.equal(other.blocked, false);
  assert.equal(other.attempts, 0);

  failed("old@example.com", "198.51.100.3", new Date(now.getTime() - LOGIN_THROTTLE_WINDOW_MS - 1_000));
  const expired = loginThrottleState({ email: "old@example.com", ip: "198.51.100.3", limit: 3, now });
  assert.equal(expired.blocked, false);
  assert.equal(expired.attempts, 0);
});

test.after(() => {
  rmSync(temp, { recursive: true, force: true });
});

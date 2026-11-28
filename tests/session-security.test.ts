import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temp = mkdtempSync(join(tmpdir(), "atw-session-"));
process.env.DATA_DIR = temp;

const db = await import("../lib/db.ts");
const auth = await import("../lib/auth.ts");
const security = await import("../lib/security.ts");
db.getDb();

const now = new Date();
const future = new Date(now.getTime() + 60 * 60_000).toISOString();
const past = new Date(now.getTime() - 60_000).toISOString();

function user(id: string, status = "active"): void {
  db.run(
    `INSERT INTO users (id, email, password_hash, name, role, status, must_change_password, created_at)
     VALUES (?, ?, ?, ?, 'owner', ?, 0, ?)`,
    [id, `${id}@example.test`, security.hashPassword("Correct-Horse!2026"), id, status, now.toISOString()],
  );
}

function session(token: string, userId: string, expiresAt: string): void {
  db.run(
    "INSERT INTO sessions (token_hash, user_id, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, NULL, 'test')",
    [security.sha256(token), userId, now.toISOString(), expiresAt],
  );
}

user("u_a");
user("u_b");
user("u_disabled", "disabled");

const tokenA = security.newToken();
const tokenB = security.newToken();
session(tokenA, "u_a", future);
session(tokenB, "u_b", future);

test("a session token resolves only to the account it was issued to", () => {
  assert.equal(auth.sessionUserFromToken(tokenA)?.id, "u_a");
  assert.equal(auth.sessionUserFromToken(tokenB)?.id, "u_b");
  assert.equal(auth.sessionUserFromToken("unrelated-token"), null);
});

test("session tokens are stored only as hashes", () => {
  const raw = db.one<{ c: number }>("SELECT COUNT(*) AS c FROM sessions WHERE token_hash IN (?, ?)", [tokenA, tokenB]);
  assert.equal(Number(raw?.c ?? 0), 0);
  const hashed = db.one<{ c: number }>("SELECT COUNT(*) AS c FROM sessions WHERE token_hash = ?", [security.sha256(tokenA)]);
  assert.equal(Number(hashed?.c ?? 0), 1);
});

test("an expired session is rejected and its row is deleted", () => {
  const expired = security.newToken();
  session(expired, "u_a", past);
  assert.equal(auth.sessionUserFromToken(expired), null);
  const remaining = db.one<{ c: number }>("SELECT COUNT(*) AS c FROM sessions WHERE token_hash = ?", [security.sha256(expired)]);
  assert.equal(Number(remaining?.c ?? 0), 0);
});

test("a disabled account's session is rejected and deleted", () => {
  const disabledToken = security.newToken();
  session(disabledToken, "u_disabled", future);
  assert.equal(auth.sessionUserFromToken(disabledToken), null);
  const remaining = db.one<{ c: number }>("SELECT COUNT(*) AS c FROM sessions WHERE token_hash = ?", [
    security.sha256(disabledToken),
  ]);
  assert.equal(Number(remaining?.c ?? 0), 0);
});

test("deleting one session does not invalidate another user's session", () => {
  db.run("DELETE FROM sessions WHERE token_hash = ?", [security.sha256(tokenB)]);
  assert.equal(auth.sessionUserFromToken(tokenB), null);
  assert.equal(auth.sessionUserFromToken(tokenA)?.id, "u_a");
});

test.after(() => rmSync(temp, { recursive: true, force: true }));

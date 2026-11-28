import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temp = mkdtempSync(join(tmpdir(), "atw-oauth-state-"));
process.env.DATA_DIR = temp;
process.env.APP_SECRET_KEY = "oauth-state-test-secret-that-is-long-enough";
process.env.GMAIL_ENABLED = "true";
process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
process.env.GOOGLE_REDIRECT_URI = "http://127.0.0.1:3000/api/gmail/oauth/callback";

const gmail = await import("../lib/gmail.ts");
const db = await import("../lib/db.ts");
db.getDb();

const NOW = new Date("2026-11-28T12:00:00.000Z");

test("state is signed, bound to the initiating user and carries no secret", () => {
  const token = gmail.stateToken("u_owner", NOW);
  const payload = gmail.verifyState(token, NOW);
  assert.equal(payload?.u, "u_owner");
  assert.ok(payload && payload.n.length >= 20);
  assert.ok(!token.includes(process.env.APP_SECRET_KEY as string));
  // A single changed signature character invalidates the state.
  assert.equal(gmail.verifyState(`${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`, NOW), null);
  assert.equal(gmail.verifyState("not-a-state", NOW), null);
  assert.equal(gmail.verifyState(null, NOW), null);
});

test("state expires after ten minutes and rejects a far-future timestamp", () => {
  const token = gmail.stateToken("u_owner", NOW);
  assert.ok(gmail.verifyState(token, new Date(NOW.getTime() + 9 * 60_000)));
  assert.equal(gmail.verifyState(token, new Date(NOW.getTime() + 11 * 60_000)), null);
  const future = gmail.stateToken("u_owner", new Date(NOW.getTime() + 10 * 60_000));
  assert.equal(gmail.verifyState(future, NOW), null);
});

test("state is consumed exactly once and only for the matching cookie and user", () => {
  const first = gmail.stateToken("u_owner", NOW);
  assert.equal(gmail.consumeOAuthState({ state: first, cookie: "different", userId: "u_owner", now: NOW }), null);
  assert.equal(gmail.consumeOAuthState({ state: first, cookie: first, userId: "u_other", now: NOW }), null);
  assert.equal(gmail.consumeOAuthState({ state: first, cookie: null, userId: "u_owner", now: NOW }), null);
  // None of the rejected attempts may burn the nonce.
  assert.ok(gmail.consumeOAuthState({ state: first, cookie: first, userId: "u_owner", now: NOW }));
  assert.equal(
    gmail.consumeOAuthState({ state: first, cookie: first, userId: "u_owner", now: NOW }),
    null,
    "a replayed callback must fail",
  );

  const second = gmail.stateToken("u_owner", NOW);
  assert.ok(gmail.consumeOAuthState({ state: second, cookie: second, userId: "u_owner", now: NOW }));
});

test("an expired state cannot be consumed and stale nonces are pruned", () => {
  const token = gmail.stateToken("u_owner", NOW);
  const later = new Date(NOW.getTime() + 11 * 60_000);
  assert.equal(gmail.consumeOAuthState({ state: token, cookie: token, userId: "u_owner", now: later }), null);

  const fresh = gmail.stateToken("u_owner", later);
  assert.ok(gmail.consumeOAuthState({ state: fresh, cookie: fresh, userId: "u_owner", now: later }));
  const stale = db.one<{ c: number }>(
    "SELECT COUNT(*) AS c FROM oauth_states WHERE expires_at <= ?",
    [later.toISOString()],
  );
  assert.equal(Number(stale?.c ?? 0), 0);
});

test.after(() => rmSync(temp, { recursive: true, force: true }));

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temp = mkdtempSync(join(tmpdir(), "atw-mfa-"));
process.env.DATA_DIR = temp;
process.env.APP_SECRET_KEY = "mfa-test-secret-that-is-long-enough";

const mfa = await import("../lib/mfa.ts");
const auth = await import("../lib/auth.ts");

test("RFC 4226 HOTP vector and TOTP verification with replay protection", () => {
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // "12345678901234567890"
  assert.equal(mfa.hotp(secret, 1, 8), "94287082");

  const code = mfa.totp(secret, 59_000);
  const accepted = mfa.verifyTotp(secret, code, { now: 59_000, lastUsedStep: null });
  assert.equal(accepted.ok, true);
  if (accepted.ok) {
    assert.equal(mfa.verifyTotp(secret, code, { now: 59_000, lastUsedStep: accepted.step }).ok, false);
  }
  assert.equal(mfa.verifyTotp(secret, "000000", { now: 59_000, lastUsedStep: null }).ok, false);
});

test("MFA secrets round-trip with authenticated encryption", () => {
  const secret = mfa.generateMfaSecret();
  const encrypted = mfa.encryptMfaSecret(secret);
  assert.notEqual(encrypted, secret);
  assert.equal(mfa.decryptMfaSecret(encrypted), secret);
  const parts = encrypted.split(".");
  parts[3] = `${parts[3].startsWith("A") ? "B" : "A"}${parts[3].slice(1)}`;
  assert.throws(() => mfa.decryptMfaSecret(parts.join(".")));
});

test("recovery codes are unique, normalised and hashed deterministically", () => {
  const codes = mfa.generateRecoveryCodes();
  assert.equal(codes.length, 8);
  assert.equal(new Set(codes).size, 8);
  assert.equal(mfa.normaliseRecoveryCode(codes[0].toLowerCase()), mfa.normaliseRecoveryCode(codes[0]));
  assert.equal(mfa.recoveryCodeHash(codes[0]), mfa.recoveryCodeHash(` ${codes[0].toLowerCase()} `));
  assert.notEqual(mfa.recoveryCodeHash(codes[0]), mfa.recoveryCodeHash(codes[1]));
});

test("MFA challenges are signed, bound to a user and expire", () => {
  const now = new Date("2026-11-19T12:00:00.000Z");
  const token = auth.createMfaChallenge("u_owner", true, now);
  const verified = auth.verifyMfaChallenge(token, new Date(now.getTime() + 60_000));
  assert.equal(verified?.uid, "u_owner");
  assert.equal(verified?.remember, true);
  assert.equal(auth.verifyMfaChallenge(`${token}x`, now), null);
  assert.equal(auth.verifyMfaChallenge(token, new Date(now.getTime() + 6 * 60_000)), null);
});

test.after(() => rmSync(temp, { recursive: true, force: true }));

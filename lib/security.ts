import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SCRYPT_KEYLEN = 64;

/** Password hashing with scrypt + per-password salt. Format: scrypt$<salt>$<hash>. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password.normalize("NFKC"), salt, SCRYPT_KEYLEN).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const [, salt, hash] = parts;
  try {
    const candidate = scryptSync(password.normalize("NFKC"), salt, SCRYPT_KEYLEN);
    const expected = Buffer.from(hash, "hex");
    if (expected.length !== candidate.length) return false;
    return timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function randomId(): string {
  return randomBytes(12).toString("hex");
}

/**
 * There is deliberately no in-process rate limiter here. Login attempts are
 * counted from durable audit rows (lib/login-throttle.ts) and API calls from
 * durable SQLite counters (lib/api-rate-limit.ts), so a restart or a second
 * process cannot reset a throttle window.
 */

export function passwordIssues(password: string): string | null {
  if (password.length < 10) return "Password must be at least 10 characters.";
  if (!/[a-z]/.test(password)) return "Password must include a lowercase letter.";
  if (!/[A-Z]/.test(password)) return "Password must include an uppercase letter.";
  if (!/[0-9]/.test(password)) return "Password must include a number.";
  if (!/[^A-Za-z0-9]/.test(password)) return "Password must include a symbol.";
  return null;
}

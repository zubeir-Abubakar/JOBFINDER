import crypto from "node:crypto";

/**
 * TOTP MFA primitives. No third-party dependency is used: RFC 4226/6238 is
 * small enough to implement and test directly, which keeps the authentication
 * path auditable and avoids adding a package to the production image.
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const MFA_STEP_SECONDS = 30;
export const MFA_DIGITS = 6;
export const MFA_WINDOW_STEPS = 1;
export const MFA_RECOVERY_CODE_COUNT = 8;

export function generateMfaSecret(bytes = 20): string {
  return base32Encode(crypto.randomBytes(bytes));
}

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input: string): Buffer {
  const cleaned = input.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const character of cleaned) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index < 0) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

export function hotp(secret: string, counter: number, digits = MFA_DIGITS): string {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac("sha1", base32Decode(secret)).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 10 ** digits).padStart(digits, "0");
}

export function totp(secret: string, now: number = Date.now(), stepSeconds = MFA_STEP_SECONDS): string {
  return hotp(secret, Math.floor(now / 1000 / stepSeconds));
}

export function currentTotpStep(now: number = Date.now(), stepSeconds = MFA_STEP_SECONDS): number {
  return Math.floor(now / 1000 / stepSeconds);
}

export type TotpVerification = { ok: true; step: number } | { ok: false; reason: "invalid" | "replayed" };

/**
 * Verify a six-digit code, accepting one step of clock skew in either
 * direction. The matched step is returned so the caller can persist it and
 * reject a second use of the same code.
 */
export function verifyTotp(
  secret: string,
  token: string,
  input: { now?: number; window?: number; stepSeconds?: number; lastUsedStep?: number | null } = {},
): TotpVerification {
  const code = token.replace(/\D/g, "");
  if (code.length !== MFA_DIGITS) return { ok: false, reason: "invalid" };
  const now = input.now ?? Date.now();
  const stepSeconds = input.stepSeconds ?? MFA_STEP_SECONDS;
  const window = Math.max(0, Math.min(3, input.window ?? MFA_WINDOW_STEPS));
  const current = currentTotpStep(now, stepSeconds);
  const candidates: number[] = [];
  for (let offset = -window; offset <= window; offset += 1) candidates.push(current + offset);

  for (const step of candidates) {
    const expected = hotp(secret, step);
    const actual = Buffer.from(code);
    const wanted = Buffer.from(expected);
    if (actual.length === wanted.length && crypto.timingSafeEqual(actual, wanted)) {
      if (typeof input.lastUsedStep === "number" && step <= input.lastUsedStep) {
        return { ok: false, reason: "replayed" };
      }
      return { ok: true, step };
    }
  }
  return { ok: false, reason: "invalid" };
}

export function otpauthUrl(input: { secret: string; email: string; issuer?: string }): string {
  const issuer = input.issuer ?? "AT AI Workforce";
  const label = `${issuer}:${input.email}`;
  const params = new URLSearchParams({
    secret: input.secret,
    issuer,
    algorithm: "SHA1",
    digits: String(MFA_DIGITS),
    period: String(MFA_STEP_SECONDS),
  });
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}

export function formatSecretForDisplay(secret: string): string {
  return secret.replace(/(.{4})/g, "$1 ").trim();
}

export function generateRecoveryCodes(count = MFA_RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => {
    const raw = base32Encode(crypto.randomBytes(8)).slice(0, 12);
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
  });
}

export function normaliseRecoveryCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z2-7]/g, "");
}

export function recoveryCodeHash(value: string): string {
  const secret = process.env.APP_SECRET_KEY;
  if (!secret) throw new Error("APP_SECRET_KEY is required to hash MFA recovery codes.");
  return crypto.createHmac("sha256", secret).update(`mfa-recovery:${normaliseRecoveryCode(value)}`).digest("hex");
}

function secretKey(): Buffer {
  const secret = process.env.APP_SECRET_KEY;
  if (!secret) throw new Error("APP_SECRET_KEY is required to encrypt MFA secrets.");
  return crypto.scryptSync(secret, "atw-mfa-secret", 32);
}

export function encryptMfaSecret(secret: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", secretKey(), iv);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
}

export function decryptMfaSecret(value: string): string {
  const [version, iv, tag, data] = value.split(".");
  if (version !== "v1" || !iv || !tag || !data) throw new Error("Stored MFA secret format is invalid.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", secretKey(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}

export function mfaEnabledForRow(row: { mfa_enabled?: number | null; mfa_secret?: string | null }): boolean {
  return Number(row.mfa_enabled ?? 0) === 1 && Boolean(row.mfa_secret);
}

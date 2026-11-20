import crypto from "node:crypto";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { all, getDb, nowIso, one, run, v } from "./db";
import { hashPassword, newToken, passwordIssues, sha256, verifyPassword } from "./security";
import { requestIpFromHeaders, trustProxyHeaders } from "./request-context";
import { getSetting } from "./settings";
import { audit } from "./audit";
import { loginThrottleState } from "./login-throttle";
import {
  decryptMfaSecret,
  mfaEnabledForRow,
  normaliseRecoveryCode,
  recoveryCodeHash,
  verifyTotp,
} from "./mfa";

export const SESSION_COOKIE = "atw_session";
export const MFA_CHALLENGE_COOKIE = "atw_mfa_challenge";
const MFA_CHALLENGE_TTL_SECONDS = 5 * 60;

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: "owner" | "admin";
  status: string;
  must_change_password: number;
  avatar_path: string | null;
  avatar_mime: string | null;
  avatar_updated_at: string | null;
  mfa_enabled: number;
};

type UserRow = SessionUser & {
  password_hash: string;
  mfa_secret: string | null;
  mfa_pending_secret: string | null;
  mfa_recovery_hashes: string | null;
  mfa_last_step: number | null;
};

export function hasAnyUser(): boolean {
  const row = one<{ c: number }>("SELECT COUNT(*) AS c FROM users");
  return Boolean(row && row.c > 0);
}

export async function clientIp(): Promise<string> {
  return requestIpFromHeaders(await headers());
}

/** HTTPS local development is still HTTPS. Mark cookies Secure when the
 * request is known to be HTTPS, when the dev launcher sets ATW_HTTPS=1, or in
 * production. Typed proxy headers are only believed when TRUST_PROXY=true. */
export function secureCookieForRequest(h: { get(name: string): string | null }): boolean {
  const proto = trustProxyHeaders()
    ? h.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase()
    : null;
  if (proto) return proto === "https";
  if (process.env.ATW_HTTPS === "1" || process.env.ATW_HTTPS === "true") return true;
  return process.env.NODE_ENV === "production";
}

function mfaChallengeKey(): Buffer {
  const secret = process.env.APP_SECRET_KEY;
  if (!secret) throw new Error("APP_SECRET_KEY is required for the MFA login challenge.");
  return crypto.createHmac("sha256", secret).update("atw-mfa-challenge").digest();
}

export type MfaChallenge = { uid: string; remember: boolean; exp: number };

export function createMfaChallenge(userId: string, remember: boolean, now: Date = new Date()): string {
  const payload: MfaChallenge = { uid: userId, remember, exp: now.getTime() + MFA_CHALLENGE_TTL_SECONDS * 1000 };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", mfaChallengeKey()).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export function verifyMfaChallenge(token: string | undefined, now: Date = new Date()): MfaChallenge | null {
  if (!token) return null;
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;
  let expected: string;
  try {
    expected = crypto.createHmac("sha256", mfaChallengeKey()).update(body).digest("base64url");
  } catch {
    return null;
  }
  const actual = Buffer.from(signature);
  const wanted = Buffer.from(expected);
  if (actual.length !== wanted.length || !crypto.timingSafeEqual(actual, wanted)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as MfaChallenge;
    if (typeof payload.uid !== "string" || typeof payload.remember !== "boolean" || !Number.isFinite(payload.exp)) return null;
    if (payload.exp < now.getTime()) return null;
    return payload;
  } catch {
    return null;
  }
}

async function issueSession(
  user: UserRow,
  remember: boolean,
  requestHeaders: { get(name: string): string | null },
  ip: string,
): Promise<{ ok: true; role: string; mustChangePassword: boolean }> {
  const security = getSetting<{ session_days: number; remember_days: number; max_login_attempts: number }>("security", {
    session_days: 7,
    remember_days: 30,
    max_login_attempts: 8,
  });
  const token = newToken();
  const days = remember ? security.remember_days ?? 30 : security.session_days ?? 7;
  const expires = new Date(Date.now() + days * 86400_000);
  run("INSERT INTO sessions (token_hash, user_id, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)", [
    sha256(token),
    user.id,
    nowIso(),
    expires.toISOString(),
    v(ip),
    v((requestHeaders.get("user-agent") ?? "").slice(0, 300)),
  ]);
  run("UPDATE users SET last_login_at = ? WHERE id = ?", [nowIso(), user.id]);
  run("DELETE FROM sessions WHERE expires_at < ?", [nowIso()]);

  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookieForRequest(requestHeaders),
    path: "/",
    expires,
  });
  audit({ action: "login.success", entity: "user", entityId: user.id, detail: `Role: ${user.role}`, ip, userId: user.id });
  return { ok: true, role: user.role, mustChangePassword: user.must_change_password === 1 };
}

function consumeRecoveryCode(user: UserRow, code: string): boolean {
  if (!user.mfa_recovery_hashes) return false;
  let hashes: string[] = [];
  try {
    const parsed = JSON.parse(user.mfa_recovery_hashes);
    if (Array.isArray(parsed)) hashes = parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return false;
  }
  const normalised = normaliseRecoveryCode(code);
  if (!normalised) return false;
  const hash = recoveryCodeHash(code);
  const index = hashes.indexOf(hash);
  if (index < 0) return false;
  hashes.splice(index, 1);
  run("UPDATE users SET mfa_recovery_hashes = ? WHERE id = ?", [JSON.stringify(hashes), user.id]);
  return true;
}

export async function verifyMfaLogin(code: string): Promise<{ ok: true; role: string; mustChangePassword: boolean } | { ok: false; error: string }> {
  const jar = await cookies();
  const challenge = verifyMfaChallenge(jar.get(MFA_CHALLENGE_COOKIE)?.value);
  if (!challenge) {
    jar.delete(MFA_CHALLENGE_COOKIE);
    return { ok: false, error: "Your sign-in challenge expired. Start again." };
  }

  const user = one<UserRow>("SELECT * FROM users WHERE id = ?", [challenge.uid]);
  if (!user || user.status !== "active" || !mfaEnabledForRow(user) || !user.mfa_secret) {
    jar.delete(MFA_CHALLENGE_COOKIE);
    return { ok: false, error: "This sign-in challenge is no longer valid. Start again." };
  }

  const ip = await clientIp();
  const security = getSetting<{ session_days: number; remember_days: number; max_login_attempts: number }>("security", {
    session_days: 7,
    remember_days: 30,
    max_login_attempts: 8,
  });
  const attemptLimit = Math.min(20, Math.max(3, Number(security.max_login_attempts) || 8));
  const throttle = loginThrottleState({ email: user.email, ip, limit: attemptLimit, action: "login.mfa_failed" });
  if (throttle.blocked) {
    audit({ action: "login.mfa_blocked", entity: "user", entityId: user.id, detail: `Rate limited after ${throttle.attempts} failed MFA attempt(s)`, ip, userId: user.id });
    const minutes = Math.max(1, Math.ceil(throttle.retryAfterSeconds / 60));
    return { ok: false, error: `Too many verification attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.` };
  }

  let verified = false;
  try {
    const secret = decryptMfaSecret(user.mfa_secret);
    const totp = verifyTotp(secret, code, { lastUsedStep: user.mfa_last_step });
    if (totp.ok) {
      run("UPDATE users SET mfa_last_step = ? WHERE id = ?", [totp.step, user.id]);
      verified = true;
    }
  } catch {
    // A missing/rotated APP_SECRET_KEY makes the stored secret unreadable. The
    // user can still use a recovery code only if its hashes remain readable.
  }

  if (!verified) {
    try {
      if (consumeRecoveryCode(user, code)) verified = true;
    } catch {
      // Missing APP_SECRET_KEY also makes recovery-code hashing unavailable;
      // fall through to the normal invalid-code response instead of a 500.
    }
  }

  if (!verified) {
    audit({ action: "login.mfa_failed", entity: "user", entityId: user.id, detail: "Invalid authenticator or recovery code", ip, userId: user.id });
    return { ok: false, error: "That code is not valid. Enter a current authenticator code or a recovery code." };
  }

  audit({ action: "login.mfa_success", entity: "user", entityId: user.id, detail: "Second factor accepted", ip, userId: user.id });
  jar.delete(MFA_CHALLENGE_COOKIE);
  return issueSession(user, challenge.remember, await headers(), ip);
}

export async function login(
  email: string,
  password: string,
  remember: boolean,
): Promise<{ ok: true; role: string; mustChangePassword: boolean; mfaRequired?: boolean } | { ok: false; error: string }> {
  const normalised = email.trim().toLowerCase();
  const ip = await clientIp();
  const security = getSetting<{ session_days: number; remember_days: number; max_login_attempts: number }>("security", {
    session_days: 7,
    remember_days: 30,
    max_login_attempts: 8,
  });
  const attemptLimit = Math.min(20, Math.max(3, Number(security.max_login_attempts) || 8));
  const throttle = loginThrottleState({ email: normalised, ip, limit: attemptLimit });
  if (throttle.blocked) {
    audit({
      action: "login.blocked",
      entity: "user",
      entityId: normalised,
      detail: `Rate limited after ${throttle.attempts} failed attempt(s)`,
      ip,
    });
    const minutes = Math.max(1, Math.ceil(throttle.retryAfterSeconds / 60));
    return { ok: false, error: `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.` };
  }

  const credential = verifyLoginCredentials(email, password);
  const requestHeaders = await headers();

  if (!credential.ok) {
    const failedUser = one<{ id: string }>("SELECT id FROM users WHERE lower(email) = ?", [normalised]);
    audit({ action: "login.failed", entity: "user", entityId: normalised, detail: "Invalid credentials", ip, userId: failedUser?.id ?? null });
    return { ok: false, error: credential.error };
  }
  const user = credential.user;
  if (user.status !== "active") {
    audit({ action: "login.blocked", entity: "user", entityId: user.id, detail: "Account disabled", ip, userId: user.id });
    return { ok: false, error: "This account is disabled. Contact the administrator." };
  }

  if (mfaEnabledForRow(user)) {
    let challenge: string;
    try {
      challenge = createMfaChallenge(user.id, remember);
    } catch {
      audit({ action: "login.mfa_unavailable", entity: "user", entityId: user.id, detail: "APP_SECRET_KEY is missing", ip, userId: user.id });
      return { ok: false, error: "Two-factor authentication is temporarily unavailable. Contact the administrator." };
    }
    const jar = await cookies();
    jar.set(MFA_CHALLENGE_COOKIE, challenge, {
      httpOnly: true,
      sameSite: "lax",
      secure: secureCookieForRequest(requestHeaders),
      path: "/",
      maxAge: MFA_CHALLENGE_TTL_SECONDS,
    });
    audit({ action: "login.mfa_required", entity: "user", entityId: user.id, detail: "Password accepted; second factor required", ip, userId: user.id });
    return { ok: true, role: user.role, mustChangePassword: user.must_change_password === 1, mfaRequired: true };
  }

  return issueSession(user, remember, requestHeaders, ip);
}

let dummyPasswordHash: string | null = null;

/** Do the same expensive verification for an unknown account so login timing
 * does not reveal whether an email address exists. */
function verifyDummyPassword(password: string): void {
  dummyPasswordHash ??= hashPassword("atw-unknown-account-dummy-password");
  verifyPassword(password, dummyPasswordHash);
}

export function verifyLoginCredentials(
  email: string,
  password: string,
): { ok: true; user: UserRow } | { ok: false; error: string } {
  getDb();
  const normalised = email.trim().toLowerCase();
  const user = one<UserRow>("SELECT * FROM users WHERE lower(email) = ?", [normalised]);
  if (!user) {
    verifyDummyPassword(password);
    return { ok: false, error: "Invalid email address or password." };
  }
  if (!verifyPassword(password, user.password_hash)) return { ok: false, error: "Invalid email address or password." };
  if (user.status !== "active") return { ok: false, error: "This account is disabled. Contact the administrator." };
  return { ok: true, user };
}

/**
 * Pure session lookup used by the request-bound `currentUser` and by tests.
 * Expired or disabled sessions are deleted, not merely ignored, so a cookie
 * cannot become valid again if an account is re-enabled later.
 */
export function sessionUserFromToken(token: string, now: Date = new Date()): SessionUser | null {
  const row = one<SessionUser & { expires_at: string }>(
    `SELECT u.id, u.email, u.name, u.role, u.status, u.must_change_password,
            u.avatar_path, u.avatar_mime, u.avatar_updated_at, u.mfa_enabled, s.expires_at
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ?`,
    [sha256(token)],
  );
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < now.getTime() || row.status !== "active") {
    run("DELETE FROM sessions WHERE token_hash = ?", [sha256(token)]);
    return null;
  }
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    status: row.status,
    must_change_password: row.must_change_password,
    avatar_path: row.avatar_path,
    avatar_mime: row.avatar_mime,
    avatar_updated_at: row.avatar_updated_at,
    mfa_enabled: row.mfa_enabled,
  };
}

export async function currentUser(): Promise<SessionUser | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  return token ? sessionUserFromToken(token) : null;
}

export async function requireUser(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (user.must_change_password) redirect("/change-password");
  // Administrators are superusers and may inspect the owner workspace;
  // owners still cannot reach /admin (enforced by requireAdmin).
  return user;
}

export async function requireAdmin(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (user.must_change_password) redirect("/change-password");
  if (user.role !== "admin") redirect("/dashboard?denied=admin");
  return user;
}

export async function logout(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    const row = one<{ user_id: string }>("SELECT user_id FROM sessions WHERE token_hash = ?", [sha256(token)]);
    run("DELETE FROM sessions WHERE token_hash = ?", [sha256(token)]);
    if (row) audit({ action: "logout", entity: "user", entityId: row.user_id, userId: row.user_id });
  }
  jar.delete(SESSION_COOKIE);
  redirect("/login");
}

export async function changePassword(userId: string, current: string, next: string, confirm: string): Promise<string | null> {
  const row = one<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = ?", [userId]);
  if (!row) return "Account not found.";
  if (!verifyPassword(current, row.password_hash)) return "Current password is incorrect.";
  const issue = passwordIssues(next);
  if (issue) return issue;
  if (next !== confirm) return "New passwords do not match.";
  const { hashPassword } = await import("./security");
  run("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?", [hashPassword(next), userId]);
  run("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?", [userId, ""]);
  audit({ action: "password.changed", entity: "user", entityId: userId, userId });
  return null;
}

export function countSessions(userId: string): number {
  return one<{ c: number }>("SELECT COUNT(*) AS c FROM sessions WHERE user_id = ? AND expires_at > ?", [userId, nowIso()])?.c ?? 0;
}

export function listAuditForUser(userId: string, limit = 50) {
  return all("SELECT * FROM audit_logs WHERE user_id = ? ORDER BY id DESC LIMIT ?", [userId, limit]);
}

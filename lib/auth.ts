import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { all, getDb, nowIso, one, run, v } from "./db";
import { newToken, passwordIssues, sha256, verifyPassword } from "./security";
import { getSetting } from "./settings";
import { audit } from "./audit";

export const SESSION_COOKIE = "atw_session";

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
};

type UserRow = SessionUser & { password_hash: string };

export function hasAnyUser(): boolean {
  const row = one<{ c: number }>("SELECT COUNT(*) AS c FROM users");
  return Boolean(row && row.c > 0);
}

export async function clientIp(): Promise<string> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "local";
}

/** Do not mark the session cookie Secure when the app is served over plain
 * localhost HTTP. Browsers reject Secure cookies on some local HTTP origins,
 * which makes a successful login bounce straight back to /login. */
function secureCookieForRequest(h: { get(name: string): string | null }): boolean {
  const proto = h.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (proto) return proto === "https";
  const host = (h.get("host") ?? "").toLowerCase();
  const localHost = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
  return process.env.NODE_ENV === "production" && !localHost;
}

export function verifyLoginCredentials(
  email: string,
  password: string,
): { ok: true; user: UserRow } | { ok: false; error: string } {
  getDb();
  const normalised = email.trim().toLowerCase();
  const user = one<UserRow>("SELECT * FROM users WHERE lower(email) = ?", [normalised]);
  if (!user || !verifyPassword(password, user.password_hash)) return { ok: false, error: "Invalid email address or password." };
  if (user.status !== "active") return { ok: false, error: "This account is disabled. Contact the administrator." };
  return { ok: true, user };
}

export async function login(
  email: string,
  password: string,
  remember: boolean,
): Promise<{ ok: true; role: string; mustChangePassword: boolean } | { ok: false; error: string }> {
  const credential = verifyLoginCredentials(email, password);
  const normalised = email.trim().toLowerCase();
  const ip = await clientIp();
  const requestHeaders = await headers();
  const userAgent = requestHeaders.get("user-agent") ?? "";

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

  const token = newToken();
  const security = getSetting<{ session_days: number; remember_days: number }>("security", { session_days: 7, remember_days: 30 });
  const days = remember ? security.remember_days ?? 30 : security.session_days ?? 7;
  const expires = new Date(Date.now() + days * 86400_000);
  run("INSERT INTO sessions (token_hash, user_id, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)", [
    sha256(token),
    user.id,
    nowIso(),
    expires.toISOString(),
    v(ip),
    v(userAgent.slice(0, 300)),
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

export async function currentUser(): Promise<SessionUser | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const row = one<SessionUser & { expires_at: string }>(
    `SELECT u.id, u.email, u.name, u.role, u.status, u.must_change_password,
            u.avatar_path, u.avatar_mime, u.avatar_updated_at, s.expires_at
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ?`,
    [sha256(token)],
  );
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now() || row.status !== "active") {
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
  };
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

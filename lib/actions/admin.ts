"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { DATA_DIR, getDb, nowIso, one, run } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { hashPassword, passwordIssues, randomId } from "@/lib/security";
import { setSetting } from "@/lib/settings";

export async function createUserAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const name = String(formData.get("name") ?? "").trim() || "Account";
  const role = String(formData.get("role") ?? "owner");
  const password = String(formData.get("password") ?? "");
  if (!email.includes("@")) redirect("/admin/users?error=Enter+a+valid+email+address");
  if (!["owner", "admin"].includes(role)) redirect("/admin/users?error=Invalid+role");
  const issue = passwordIssues(password);
  if (issue) redirect(`/admin/users?error=${encodeURIComponent(issue)}`);
  if (one("SELECT id FROM users WHERE lower(email) = ?", [email])) redirect("/admin/users?error=That+email+already+exists");
  run("INSERT INTO users (id, email, password_hash, name, role, status, must_change_password, created_at) VALUES (?, ?, ?, ?, ?, 'active', 1, ?)", [
    `u_${randomId()}`,
    email,
    hashPassword(password),
    name,
    role,
    nowIso(),
  ]);
  audit({ action: "admin.user_created", entity: "user", detail: `${email} (${role})`, userId: admin.id, actor: admin.email });
  revalidatePath("/admin/users");
  redirect("/admin/users?saved=1");
}

export async function setUserStatusAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "");
  if (!["active", "disabled"].includes(status)) redirect("/admin/users?error=Invalid+status");
  if (id === admin.id) redirect("/admin/users?error=You+cannot+disable+your+own+account");
  run("UPDATE users SET status = ? WHERE id = ?", [status, id]);
  if (status === "disabled") run("DELETE FROM sessions WHERE user_id = ?", [id]);
  audit({ action: status === "disabled" ? "admin.user_disabled" : "admin.user_enabled", entity: "user", entityId: id, userId: admin.id });
  revalidatePath("/admin/users");
  redirect("/admin/users?saved=1");
}

export async function resetUserPasswordAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const password = String(formData.get("password") ?? "");
  const issue = passwordIssues(password);
  if (issue) redirect(`/admin/users?error=${encodeURIComponent(issue)}`);
  run("UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?", [hashPassword(password), id]);
  run("DELETE FROM sessions WHERE user_id = ?", [id]);
  audit({ action: "admin.password_reset", entity: "user", entityId: id, userId: admin.id, actor: admin.email });
  revalidatePath("/admin/users");
  redirect("/admin/users?saved=1");
}

export async function saveAiConfigAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const config = {
    provider: String(formData.get("provider") ?? "rules"),
    model: String(formData.get("model") ?? "at-rules-v1"),
    temperature: Math.min(1.5, Math.max(0, Number(formData.get("temperature") ?? 0.2))),
    max_tokens: Math.min(32000, Math.max(256, Number(formData.get("max_tokens") ?? 2048))),
    local_model: String(formData.get("local_model") ?? "llama3.1:8b"),
    fallback: String(formData.get("fallback") ?? "rules"),
    usage_tokens: 0,
  };
  setSetting("ai", config);
  audit({ action: "admin.ai_config", entity: "settings", detail: `${config.provider}/${config.model}`, userId: admin.id });
  revalidatePath("/admin/ai");
  redirect("/admin/ai?saved=1");
}

export async function testProvidersAction(): Promise<void> {
  const admin = await requireAdmin();
  const { generateText } = await import("@/lib/providers");
  try {
    const result = await generateText({
      agentKey: "coordinator",
      source: "admin_test",
      system: "You are a health-check endpoint. Reply with the single word OK.",
      prompt: "Health check. Reply OK.",
      maxTokens: 12,
      temperature: 0,
    });
    audit({ action: "admin.provider_test", entity: "providers", detail: `${result.provider}/${result.model}`, userId: admin.id });
    revalidatePath("/admin/ai");
    redirect(`/admin/ai?ok=${encodeURIComponent(`Provider responded via ${result.provider} (${result.model}).`)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "No provider responded.";
    audit({ action: "admin.provider_test_failed", entity: "providers", detail: message, userId: admin.id });
    revalidatePath("/admin/ai");
    redirect(`/admin/ai?error=${encodeURIComponent(message)}`);
  }
}

export async function saveEmailConfigAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const provider = String(formData.get("provider") ?? "gmail");
  const sender = String(formData.get("sender") ?? "").trim();
  const account = String(formData.get("account") ?? "").trim();
  const connected = formData.get("connected") === "on" && Boolean(sender);
  setSetting("email", { provider, sender, account, connected });
  audit({ action: "admin.email_config", entity: "settings", detail: `${provider} · connected: ${connected}`, userId: admin.id });
  revalidatePath("/admin/email");
  redirect("/admin/email?saved=1");
}

export async function saveSecurityAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const config = {
    session_days: Math.min(30, Math.max(1, Number(formData.get("session_days") ?? 7))),
    remember_days: Math.min(90, Math.max(1, Number(formData.get("remember_days") ?? 30))),
    max_login_attempts: Math.min(20, Math.max(3, Number(formData.get("max_login_attempts") ?? 8))),
  };
  setSetting("security", config);
  audit({ action: "admin.security_config", entity: "settings", detail: JSON.stringify(config), userId: admin.id });
  revalidatePath("/admin/security");
  redirect("/admin/security?saved=1");
}

export async function runBackupAction(): Promise<void> {
  const admin = await requireAdmin();
  const dir = path.join(DATA_DIR, "backups");
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = path.join(dir, `at-ai-workforce-${stamp}.db`);
  getDb().prepare("VACUUM INTO ?").run(target);
  setSetting("backup", { enabled: true, last_backup_at: nowIso() });
  audit({ action: "admin.backup", entity: "database", detail: path.basename(target), userId: admin.id });
  revalidatePath("/admin/security");
  revalidatePath("/admin/storage");
  redirect(`/admin/security?backup=${encodeURIComponent(path.basename(target))}`);
}

export async function purgeSessionsAction(): Promise<void> {
  const admin = await requireAdmin();
  run("DELETE FROM sessions WHERE expires_at < ?", [nowIso()]);
  audit({ action: "admin.sessions_purged", entity: "sessions", userId: admin.id });
  revalidatePath("/admin/security");
  redirect("/admin/security?saved=1");
}

export async function saveAdminRetentionAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const days = Number(formData.get("retention_days") ?? 30);
  if (![7, 14, 30, 60, 90].includes(days)) redirect("/admin/storage?error=Retention+must+be+7,+14,+30,+60+or+90+days");
  setSetting("retention_days", days);
  setSetting("auto_delete_expired", formData.get("auto_delete_expired") === "on");
  audit({ action: "admin.retention_policy", entity: "settings", detail: `${days} days`, userId: admin.id });
  revalidatePath("/admin/storage");
  redirect("/admin/storage?saved=1");
}

export async function adminCleanupAction(): Promise<void> {
  const admin = await requireAdmin();
  const { cleanupExpiredDocuments } = await import("@/lib/retention");
  const result = await cleanupExpiredDocuments(admin.email);
  revalidatePath("/admin/storage");
  redirect(`/admin/storage?cleanup=${result.deleted}&freed=${result.bytes}`);
}

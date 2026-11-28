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
import { INTEGRATION_KEYS, recordIntegrationCheck, testIntegrationConnection, type IntegrationKey } from "@/lib/integrations";
import { refreshLatestExecutiveBriefDelivery, sendExecutiveBriefNow } from "@/lib/executive-brief";
import { notificationRecipient } from "@/lib/notify";
import { runResendTestEmail } from "@/lib/resend";

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

export async function resetUserMfaAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const target = one<{ email: string }>("SELECT email FROM users WHERE id = ?", [id]);
  if (!target) redirect("/admin/users?error=Account+not+found");
  run("UPDATE users SET mfa_enabled = 0, mfa_secret = NULL, mfa_pending_secret = NULL, mfa_recovery_hashes = NULL, mfa_last_step = NULL, mfa_enabled_at = NULL WHERE id = ?", [id]);
  run("DELETE FROM sessions WHERE user_id = ?", [id]);
  audit({ action: "admin.mfa_reset", entity: "user", entityId: id, detail: target.email, userId: admin.id, actor: admin.email });
  revalidatePath("/admin/users");
  revalidatePath("/admin/security");
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

export async function testOllamaAction(): Promise<void> {
  const admin = await requireAdmin();
  const { testOllamaConnection } = await import("@/lib/providers");
  let ok = false;
  let detail = "Ollama connection test failed.";
  try {
    const result = await testOllamaConnection();
    ok = result.ok;
    detail = result.detail;
    audit({
      action: result.ok ? "admin.ollama_test" : "admin.ollama_test_failed",
      entity: "providers",
      detail: `${result.base} · ${result.models.length} installed · ${result.detail}`,
      userId: admin.id,
    });
  } catch (error) {
    detail = error instanceof Error ? error.message : "Ollama connection test failed.";
    audit({ action: "admin.ollama_test_failed", entity: "providers", detail, userId: admin.id });
  }
  revalidatePath("/admin/ai");
  redirect(`/admin/ai?${ok ? "ok" : "error"}=${encodeURIComponent(detail)}`);
}

export async function testProvidersAction(): Promise<void> {
  const admin = await requireAdmin();
  const { generateText, scrubProviderError } = await import("@/lib/providers");
  let ok = false;
  let detail = "No provider responded.";
  try {
    const result = await generateText({
      agentKey: "coordinator",
      source: "admin_test",
      system: "You are a health-check endpoint. Reply with the single word OK.",
      prompt: "Health check. Reply OK.",
      maxTokens: 12,
      temperature: 0,
    });
    ok = true;
    detail = `Provider responded via ${result.provider} (${result.model}).`;
    audit({ action: "admin.provider_test", entity: "providers", detail: `${result.provider}/${result.model}`, userId: admin.id });
  } catch (error) {
    detail = error instanceof Error ? scrubProviderError(error.message) : "No provider responded.";
    audit({ action: "admin.provider_test_failed", entity: "providers", detail, userId: admin.id });
  }
  revalidatePath("/admin/ai");
  redirect(`/admin/ai?${ok ? "ok" : "error"}=${encodeURIComponent(detail)}`);
}

export async function testIntegrationAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const key = String(formData.get("key") ?? "") as IntegrationKey;
  if (!INTEGRATION_KEYS.includes(key)) redirect("/admin/integrations?error=Unknown+integration");
  const result = await testIntegrationConnection(key);
  recordIntegrationCheck(key, result);
  audit({
    action: result.status === "success" ? "admin.integration_test" : "admin.integration_test_blocked",
    entity: "integrations",
    detail: `${key}: ${result.status} — ${result.detail}`.slice(0, 1000),
    userId: admin.id,
    actor: admin.email,
  });
  revalidatePath("/admin/integrations");
  const param = result.status === "success" ? "ok" : result.status === "failed" ? "error" : "notice";
  redirect(`/admin/integrations?${param}=${encodeURIComponent(result.detail)}`);
}

function briefRedirect(state: string, detail: string): string {
  return `/admin/email?brief=${encodeURIComponent(state)}&detail=${encodeURIComponent(detail.slice(0, 900))}`;
}

export async function sendExecutiveBriefNowAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const resend = String(formData.get("mode") ?? "send") === "resend";
  const result = await sendExecutiveBriefNow({ userId: admin.id, source: "admin", resend });
  revalidatePath("/admin/email");
  redirect(briefRedirect(result.state, result.message));
}

export async function sendResendTestEmailAction(): Promise<void> {
  const admin = await requireAdmin();
  const recipient = notificationRecipient();
  if (!recipient) {
    audit({
      action: "admin.email_test_blocked",
      entity: "email",
      detail: "No notification recipient is configured.",
      userId: admin.id,
    });
    redirect(`/admin/email?brief=blocked&detail=${encodeURIComponent("No notification recipient is configured. Save the owner address in Settings first.")}`);
  }
  const result = await runResendTestEmail(recipient, admin.id);
  revalidatePath("/admin/email");
  const state = result.status === "accepted" ? "queued" : result.status === "api_error" || result.status === "rate_limited" ? "failed" : "blocked";
  redirect(
    `/admin/email?brief=${encodeURIComponent(state)}&detail=${encodeURIComponent(`Test email ${result.status}: ${result.detail}`.slice(0, 900))}`,
  );
}

export async function refreshExecutiveBriefDeliveryAction(): Promise<void> {
  const admin = await requireAdmin();
  const result = await refreshLatestExecutiveBriefDelivery();
  audit({
    action: "admin.executive_brief_sent_folder_check",
    entity: "email",
    entityId: result.outboxId,
    detail: `${result.state} · ${result.sentVerification ?? result.detail}`.slice(0, 1000),
    userId: admin.id,
  });
  revalidatePath("/admin/email");
  redirect(briefRedirect(result.state, result.message));
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

"use server";

import { redirect } from "next/navigation";
import { hashPassword, passwordIssues, randomId } from "@/lib/security";
import { getDb, nowIso, one, run } from "@/lib/db";
import { audit } from "@/lib/audit";
import { login, hasAnyUser } from "@/lib/auth";

export type SetupState = { error?: string };

export async function setupAction(_prev: SetupState | undefined, formData: FormData): Promise<SetupState> {
  getDb();
  if (hasAnyUser()) return { error: "This system is already provisioned. Sign in instead." };

  const ownerEmail = String(formData.get("owner_email") ?? "").trim().toLowerCase();
  const ownerName = String(formData.get("owner_name") ?? "").trim() || "Account owner";
  const ownerPassword = String(formData.get("owner_password") ?? "");
  const adminEmail = String(formData.get("admin_email") ?? "").trim().toLowerCase();
  const adminPassword = String(formData.get("admin_password") ?? "");

  if (!ownerEmail.includes("@") || !adminEmail.includes("@")) return { error: "Enter valid owner and administrator email addresses." };
  if (ownerEmail === adminEmail) return { error: "The owner and administrator must use different email addresses." };
  const ownerIssue = passwordIssues(ownerPassword);
  if (ownerIssue) return { error: `Owner password: ${ownerIssue}` };
  const adminIssue = passwordIssues(adminPassword);
  if (adminIssue) return { error: `Administrator password: ${adminIssue}` };
  if (one("SELECT id FROM users WHERE lower(email) IN (?, ?)", [ownerEmail, adminEmail])) return { error: "An account already uses one of those addresses." };

  const ts = nowIso();
  run("INSERT INTO users (id, email, password_hash, name, role, status, created_at) VALUES (?, ?, ?, ?, 'owner', 'active', ?)", [
    `u_${randomId()}`,
    ownerEmail,
    hashPassword(ownerPassword),
    ownerName,
    ts,
  ]);
  run("INSERT INTO users (id, email, password_hash, name, role, status, created_at) VALUES (?, ?, ?, ?, 'admin', 'active', ?)", [
    `u_${randomId()}`,
    adminEmail,
    hashPassword(adminPassword),
    "Administrator",
    ts,
  ]);
  run("UPDATE profiles SET email = ? WHERE id = 1 AND email IS NULL", [ownerEmail]);
  audit({ action: "system.provisioned", entity: "system", detail: "Owner and administrator accounts created through first-run setup", actor: ownerEmail });

  const result = await login(ownerEmail, ownerPassword, false);
  if (!result.ok) return { error: result.error };
  redirect("/dashboard");
}

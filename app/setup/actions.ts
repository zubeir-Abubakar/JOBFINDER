"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { audit } from "@/lib/audit";
import { login } from "@/lib/auth";
import { initializeAccounts } from "@/lib/setup";
import { setupActionAuthorized, setupPageState } from "@/lib/setup-security";

export type SetupState = { error?: string };

export async function setupAction(_prev: SetupState | undefined, formData: FormData): Promise<SetupState> {
  const requestHeaders = await headers();
  if (setupPageState(requestHeaders).closed) {
    return { error: "This system is already provisioned. Sign in instead." };
  }
  const suppliedToken = String(formData.get("setup_token") ?? "");
  if (!setupActionAuthorized(requestHeaders, suppliedToken)) {
    return { error: "Setup is not authorized. Use a valid setup token or a direct local connection." };
  }

  const ownerEmail = String(formData.get("owner_email") ?? "").trim().toLowerCase();
  const ownerName = String(formData.get("owner_name") ?? "").trim() || "Account owner";
  const ownerPassword = String(formData.get("owner_password") ?? "");
  const adminEmail = String(formData.get("admin_email") ?? "").trim().toLowerCase();
  const adminPassword = String(formData.get("admin_password") ?? "");

  const initialized = initializeAccounts({
    ownerEmail,
    ownerName,
    ownerPassword,
    adminEmail,
    adminPassword,
  });
  if (!initialized.ok) return { error: initialized.error };

  audit({ action: "system.provisioned", entity: "system", detail: "Owner and administrator accounts created through first-run setup", actor: ownerEmail });
  const result = await login(ownerEmail, ownerPassword, false);
  if (!result.ok) return { error: result.error };
  redirect("/dashboard");
}

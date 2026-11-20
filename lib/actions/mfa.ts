"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { nowIso, one, run } from "@/lib/db";
import { verifyPassword } from "@/lib/security";
import {
  decryptMfaSecret,
  encryptMfaSecret,
  formatSecretForDisplay,
  generateMfaSecret,
  generateRecoveryCodes,
  mfaEnabledForRow,
  otpauthUrl,
  recoveryCodeHash,
  verifyTotp,
} from "@/lib/mfa";

type MfaRow = {
  email: string;
  mfa_enabled: number;
  mfa_secret: string | null;
  mfa_pending_secret: string | null;
  mfa_last_step: number | null;
  password_hash: string;
};

export type MfaSetupResult = { error?: string; secret?: string; otpauth?: string };
export type MfaConfirmResult = { error?: string; recoveryCodes?: string[] };
export type MfaActionState = { error?: string; ok?: string };

export async function beginMfaSetupAction(): Promise<MfaSetupResult> {
  const user = await requireUser();
  const row = one<MfaRow>("SELECT email, mfa_enabled, mfa_secret, mfa_pending_secret, mfa_last_step, password_hash FROM users WHERE id = ?", [user.id]);
  if (!row) return { error: "Account not found." };
  if (mfaEnabledForRow(row)) return { error: "Two-factor authentication is already enabled. Disable it first to enrol a new device." };

  try {
    const secret = generateMfaSecret();
    run("UPDATE users SET mfa_pending_secret = ?, mfa_enabled = 0, mfa_secret = NULL, mfa_recovery_hashes = NULL, mfa_last_step = NULL WHERE id = ?", [
      encryptMfaSecret(secret),
      user.id,
    ]);
    audit({ action: "mfa.setup_started", entity: "user", entityId: user.id, userId: user.id });
    revalidatePath("/settings");
    return { secret: formatSecretForDisplay(secret), otpauth: otpauthUrl({ secret, email: row.email }) };
  } catch {
    return { error: "MFA cannot be configured because APP_SECRET_KEY is missing or invalid." };
  }
}

export async function confirmMfaSetupAction(formData: FormData): Promise<MfaConfirmResult> {
  const user = await requireUser();
  const code = String(formData.get("code") ?? "").trim();
  const row = one<MfaRow>("SELECT email, mfa_enabled, mfa_secret, mfa_pending_secret, mfa_last_step, password_hash FROM users WHERE id = ?", [user.id]);
  if (!row?.mfa_pending_secret) return { error: "Start the authenticator setup again." };
  if (!code) return { error: "Enter the six-digit code shown by your authenticator." };

  try {
    const secret = decryptMfaSecret(row.mfa_pending_secret);
    const checked = verifyTotp(secret, code, { lastUsedStep: null });
    if (!checked.ok) return { error: "That code is not valid. Check the time on your device and try again." };

    const recoveryCodes = generateRecoveryCodes();
    run(
      `UPDATE users SET
         mfa_enabled = 1,
         mfa_secret = ?,
         mfa_pending_secret = NULL,
         mfa_recovery_hashes = ?,
         mfa_last_step = ?,
         mfa_enabled_at = ?
       WHERE id = ?`,
      [
        encryptMfaSecret(secret),
        JSON.stringify(recoveryCodes.map((value) => recoveryCodeHash(value))),
        checked.step,
        nowIso(),
        user.id,
      ],
    );
    audit({ action: "mfa.enabled", entity: "user", entityId: user.id, detail: "TOTP authenticator enrolled", userId: user.id });
    revalidatePath("/settings");
    revalidatePath("/admin/security");
    return { recoveryCodes };
  } catch {
    return { error: "MFA setup could not be completed. Verify APP_SECRET_KEY and try again." };
  }
}

export async function disableMfaAction(formData: FormData): Promise<MfaActionState> {
  const user = await requireUser();
  const password = String(formData.get("password") ?? "");
  const code = String(formData.get("code") ?? "").trim();
  const row = one<MfaRow>("SELECT email, mfa_enabled, mfa_secret, mfa_pending_secret, mfa_last_step, password_hash FROM users WHERE id = ?", [user.id]);
  if (!row || !mfaEnabledForRow(row) || !row.mfa_secret) return { error: "Two-factor authentication is not enabled." };
  if (!verifyPassword(password, row.password_hash)) return { error: "Current password is incorrect." };

  try {
    const secret = decryptMfaSecret(row.mfa_secret);
    const checked = verifyTotp(secret, code, { lastUsedStep: row.mfa_last_step });
    if (!checked.ok) return { error: "Enter a current authenticator code to disable MFA." };
  } catch {
    return { error: "The stored MFA secret cannot be read. Use an administrator reset." };
  }

  run("UPDATE users SET mfa_enabled = 0, mfa_secret = NULL, mfa_pending_secret = NULL, mfa_recovery_hashes = NULL, mfa_last_step = NULL, mfa_enabled_at = NULL WHERE id = ?", [user.id]);
  audit({ action: "mfa.disabled", entity: "user", entityId: user.id, userId: user.id });
  revalidatePath("/settings");
  revalidatePath("/admin/security");
  return { ok: "Two-factor authentication disabled." };
}

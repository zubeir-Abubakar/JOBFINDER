"use server";

import { redirect } from "next/navigation";
import { login, hasAnyUser, verifyMfaLogin } from "@/lib/auth";

export type LoginState = { error?: string; mfaRequired?: boolean };

export async function loginAction(_prev: LoginState | undefined, formData: FormData): Promise<LoginState> {
  if (!hasAnyUser()) redirect("/setup");
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const remember = formData.get("remember") === "on";
  if (!email || !password) return { error: "Enter your email address and password." };

  const result = await login(email, password, remember);
  if (!result.ok) return { error: result.error };
  if (result.mfaRequired) return { mfaRequired: true };
  if (result.mustChangePassword) redirect("/change-password");
  redirect(result.role === "admin" ? "/admin" : "/dashboard");
}

export async function verifyMfaAction(_prev: LoginState | undefined, formData: FormData): Promise<LoginState> {
  const code = String(formData.get("code") ?? "").trim();
  if (!code) return { mfaRequired: true, error: "Enter your authenticator code or a recovery code." };
  const result = await verifyMfaLogin(code);
  if (!result.ok) return { mfaRequired: true, error: result.error };
  if (result.mustChangePassword) redirect("/change-password");
  redirect(result.role === "admin" ? "/admin" : "/dashboard");
}

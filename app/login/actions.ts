"use server";

import { redirect } from "next/navigation";
import { login, hasAnyUser } from "@/lib/auth";

export type LoginState = { error?: string };

export async function loginAction(_prev: LoginState | undefined, formData: FormData): Promise<LoginState> {
  if (!hasAnyUser()) redirect("/setup");
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const remember = formData.get("remember") === "on";
  if (!email || !password) return { error: "Enter your email address and password." };

  const result = await login(email, password, remember);
  if (!result.ok) return { error: result.error };
  if (result.mustChangePassword) redirect("/change-password");
  redirect(result.role === "admin" ? "/admin" : "/dashboard");
}

"use server";

import { redirect } from "next/navigation";
import { login } from "@/lib/auth";
import { clientIp, hasAnyUser } from "@/lib/auth";
import { rateLimit } from "@/lib/security";
import { audit } from "@/lib/audit";

export type LoginState = { error?: string };

export async function loginAction(_prev: LoginState | undefined, formData: FormData): Promise<LoginState> {
  if (!hasAnyUser()) redirect("/setup");
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const remember = formData.get("remember") === "on";
  if (!email || !password) return { error: "Enter your email address and password." };

  const ip = await clientIp();
  const limit = rateLimit(`login:${ip}:${email.toLowerCase()}`);
  if (!limit.ok) return { error: `Too many attempts. Try again in ${Math.ceil(limit.retryAfter / 60)} minutes.` };

  const result = await login(email, password, remember);
  if (!result.ok) return { error: result.error };
  if (result.mustChangePassword) redirect("/change-password");
  redirect(result.role === "admin" ? "/admin" : "/dashboard");
}

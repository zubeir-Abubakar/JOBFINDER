"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { changePassword, currentSessionTokenHash, currentUser, logout, requireUser } from "@/lib/auth";

export async function logoutAction(): Promise<void> {
  await logout();
}

export async function changePasswordAction(
  _prev: { error?: string; ok?: string } | undefined,
  formData: FormData,
): Promise<{ error?: string; ok?: string }> {
  const user = await requireUser();
  const error = await changePassword(
    user.id,
    String(formData.get("current") ?? ""),
    String(formData.get("next") ?? ""),
    String(formData.get("confirm") ?? ""),
    // Keep the session the owner is using; only the other sessions are signed out.
    await currentSessionTokenHash(),
  );
  if (error) return { error };
  revalidatePath("/settings");
  return { ok: "Password updated. Other sessions were signed out." };
}

export async function changeRequiredPasswordAction(
  _prev: { error?: string; ok?: string } | undefined,
  formData: FormData,
): Promise<{ error?: string; ok?: string }> {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (!user.must_change_password) redirect(user.role === "admin" ? "/admin" : "/dashboard");
  const error = await changePassword(
    user.id,
    String(formData.get("current") ?? ""),
    String(formData.get("next") ?? ""),
    String(formData.get("confirm") ?? ""),
  );
  if (error) return { error };
  revalidatePath("/");
  redirect("/login?changed=1");
}

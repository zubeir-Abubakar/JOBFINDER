"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { nowIso, run } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { getProfileData } from "@/lib/profile";
import { getSetting, setSetting } from "@/lib/settings";
import { cleanupExpiredDocuments } from "@/lib/retention";
import { cleanupTempObjects } from "@/lib/temp-store";

const list = (value: FormDataEntryValue | null) =>
  String(value ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

export async function saveProfessionalPreferencesAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const profile = getProfileData();
  const preferences = {
    ...profile.preferences,
    titles: list(formData.get("titles")),
    locations: list(formData.get("locations")),
    industries: list(formData.get("industries")),
    languages: list(formData.get("languages")),
    min_salary: formData.get("min_salary") ? Number(formData.get("min_salary")) : null,
    employment_types: list(formData.get("employment_types")),
    remote_preference: String(formData.get("remote_preference") ?? "any"),
    german_required: String(formData.get("german_required") ?? "avoid"),
    french: String(formData.get("french") ?? "evaluate"),
  };
  run("UPDATE profiles SET preferences = ?, updated_at = ? WHERE id = 1", [JSON.stringify(preferences), nowIso()]);
  audit({ action: "settings.professional_preferences", entity: "profile", userId: user.id });
  revalidatePath("/settings");
  redirect("/settings?saved=1#professional");
}

export async function saveAutomationAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  setSetting("approval_mode", formData.get("approval_mode") === "on");
  setSetting("autonomous_submission", formData.get("autonomous_submission") === "on");
  setSetting("min_match_score", Math.min(100, Math.max(0, Number(formData.get("min_match_score") ?? 60))));
  setSetting("max_applications_per_day", Math.min(50, Math.max(1, Number(formData.get("max_applications_per_day") ?? 5))));
  setSetting("search_frequency", String(formData.get("search_frequency") ?? "daily"));
  setSetting("duplicate_detection", formData.get("duplicate_detection") === "on");
  audit({ action: "settings.automation", entity: "settings", detail: `Approval mode: ${formData.get("approval_mode") === "on"}`, userId: user.id });
  revalidatePath("/settings");
  redirect("/settings?saved=1#automation");
}

export async function saveNotificationSettingsAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  setSetting("notify_daily_report", formData.get("notify_daily_report") === "on");
  setSetting("notify_weekly_report", formData.get("notify_weekly_report") === "on");
  setSetting("notify_immediate", formData.get("notify_immediate") === "on");
  setSetting("notify_agent_failure", formData.get("notify_agent_failure") === "on");
  setSetting("notify_interview", formData.get("notify_interview") === "on");
  const email = String(formData.get("email") ?? "").trim();
  run("UPDATE profiles SET email = ?, updated_at = ? WHERE id = 1", [email || null, nowIso()]);
  audit({ action: "settings.notifications", entity: "settings", userId: user.id });
  revalidatePath("/settings");
  redirect("/settings?saved=1#notifications");
}

export async function saveDocumentSettingsAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const days = Number(formData.get("retention_days") ?? 30);
  if (![7, 14, 30, 60, 90].includes(days)) redirect("/settings?error=Retention+must+be+7,+14,+30,+60+or+90+days#documents");
  setSetting("retention_days", days);
  setSetting("auto_delete_expired", formData.get("auto_delete_expired") === "on");
  audit({ action: "settings.retention", entity: "settings", detail: `${days} days, auto-delete ${formData.get("auto_delete_expired") === "on"}`, userId: user.id });
  revalidatePath("/settings");
  redirect("/settings?saved=1#documents");
}

export async function clearExpiredDocumentsAction(): Promise<void> {
  const user = await requireUser();
  const result = await cleanupExpiredDocuments(user.email);
  revalidatePath("/documents");
  revalidatePath("/settings");
  revalidatePath("/admin/storage");
  redirect(`/settings?cleanup=${result.deleted}&freed=${result.bytes}#documents`);
}

export async function cleanTempCacheAction(): Promise<void> {
  const user = await requireUser();
  const result = await cleanupTempObjects(user.email);
  revalidatePath("/settings");
  redirect(`/settings?cleanup=${result.removed}&freed=${result.bytes}#cache`);
}

export async function testEmailAction(): Promise<void> {
  const user = await requireUser();
  const email = getSetting<{ connected: boolean; sender: string }>("email", { connected: false, sender: "" });
  audit({ action: "email.test_requested", entity: "email", detail: email.connected ? "Provider marked connected" : "No provider configured", userId: user.id });
  if (!email.connected) {
    redirect("/settings?error=Email+delivery+is+not+configured.+The+administrator+must+connect+a+provider+first.#notifications");
  }
  redirect("/settings?error=The+configured+provider+has+not+been+exercised+by+this+deployment+yet.+Check+Admin+%E2%86%92+Email.#notifications");
}

"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { nowIso, run } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { getProfileData } from "@/lib/profile";
import { setSetting } from "@/lib/settings";
import { maskEmail, runGmailTestEmail } from "@/lib/gmail";
import { cleanupExpiredDocuments } from "@/lib/retention";
import { cleanupTempObjects } from "@/lib/temp-store";
import { effectiveMinMatchScore } from "@/lib/scoring";
import {
  RECRUITMENT_SCHEDULE_KEY,
  REPORT_SCHEDULE_KEY,
  saveScheduleConfiguration,
} from "@/lib/recruitment-schedule";

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
  // Per-application approval is retired. The owner-level switch is the only
  // approval control.
  setSetting("approval_mode", false);
  setSetting("autonomous_submission", formData.get("autonomous_submission") === "on");
  // The floor is enforced here as well as in the scoring engine: a stored value
  // below 85% would otherwise be displayed as if it were the active threshold.
  setSetting("min_match_score", effectiveMinMatchScore(formData.get("min_match_score")));
  setSetting("max_applications_per_day", Math.min(10, Math.max(1, Number(formData.get("max_applications_per_day") ?? 5))));
  setSetting("search_frequency", String(formData.get("search_frequency") ?? "daily"));
  setSetting("duplicate_detection", formData.get("duplicate_detection") === "on");
  audit({ action: "settings.automation", entity: "settings", detail: `Approval mode: ${formData.get("approval_mode") === "on"}`, userId: user.id });
  revalidatePath("/settings");
  redirect("/settings?saved=1#automation");
}

/** Validated recruitment-run schedule. Weekdays and time are persisted. */
export async function saveRecruitmentScheduleAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const result = saveScheduleConfiguration(RECRUITMENT_SCHEDULE_KEY, {
    enabled: formData.get("enabled") === "on",
    weekdays: formData.getAll("weekdays").map((value) => Number(value)),
    time: formData.get("time"),
    timezone: formData.get("timezone") ?? "Europe/Zurich",
  });
  if (!result.ok) redirect(`/settings?error=${encodeURIComponent(result.error)}#scheduling`);
  audit({
    action: "settings.recruitment_schedule",
    entity: "schedule",
    entityId: RECRUITMENT_SCHEDULE_KEY,
    detail: `${result.schedule.enabled ? "enabled" : "disabled"} · ${result.schedule.time} ${result.schedule.timezone} · ${result.schedule.weekdays}`,
    userId: user.id,
  });
  revalidatePath("/settings");
  revalidatePath("/recruitment");
  redirect("/settings?saved=1#scheduling");
}

/** Validated daily-report schedule, independent from recruitment days. */
export async function saveReportScheduleAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const result = saveScheduleConfiguration(REPORT_SCHEDULE_KEY, {
    enabled: formData.get("enabled") === "on",
    weekdays: formData.getAll("weekdays").map((value) => Number(value)),
    time: formData.get("time"),
    timezone: formData.get("timezone") ?? "Europe/Zurich",
  });
  if (!result.ok) redirect(`/settings?error=${encodeURIComponent(result.error)}#scheduling`);
  audit({
    action: "settings.report_schedule",
    entity: "schedule",
    entityId: REPORT_SCHEDULE_KEY,
    detail: `${result.schedule.enabled ? "enabled" : "disabled"} · ${result.schedule.time} ${result.schedule.timezone} · ${result.schedule.weekdays}`,
    userId: user.id,
  });
  revalidatePath("/settings");
  revalidatePath("/recruitment");
  redirect("/settings?saved=1#scheduling");
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
  const profile = getProfileData();
  // This is exactly the address shown and saved in Notifications. The test
  // never accepts a recipient from the request, so it cannot be aimed at an
  // employer or arbitrary third party.
  const recipient = String(profile.profile.email || user.email || "").trim();
  audit({
    action: "email.test_requested",
    entity: "email",
    detail: recipient ? `Requested test for ${maskEmail(recipient)}` : "No notification recipient saved",
    userId: user.id,
  });
  const result = await runGmailTestEmail(recipient, user.id);
  revalidatePath("/settings");
  redirect(`/settings?email_test=${encodeURIComponent(result.status)}#notifications`);
}

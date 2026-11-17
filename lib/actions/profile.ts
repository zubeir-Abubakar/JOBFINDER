"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { nowIso, run, v } from "@/lib/db";
import { requireUser, requireAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";

function touch(): void {
  run("UPDATE profiles SET updated_at = ? WHERE id = 1", [nowIso()]);
}

export async function updateProfileAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const text = (key: string) => {
    const value = String(formData.get(key) ?? "").trim();
    return value || null;
  };
  run(
    `UPDATE profiles SET full_name = ?, headline = ?, email = ?, phone = ?, location = ?, work_authorisation = ?,
     permit_valid_until = ?, summary = ?, linkedin = ?, website = ?, updated_at = ? WHERE id = 1`,
    [
      text("full_name"),
      text("headline"),
      text("email"),
      text("phone"),
      text("location"),
      text("work_authorisation"),
      text("permit_valid_until"),
      text("summary"),
      text("linkedin"),
      text("website"),
      nowIso(),
    ],
  );
  audit({ action: "profile.updated", entity: "profile", entityId: "1", userId: user.id });
  revalidatePath("/profile");
  revalidatePath("/dashboard");
  redirect("/profile?saved=1");
}

export async function addSkillAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const name = String(formData.get("name") ?? "").trim();
  const category = String(formData.get("category") ?? "Automation & testing").trim();
  const level = String(formData.get("level") ?? "working");
  const years = formData.get("years") ? Number(formData.get("years")) : null;
  if (!name) redirect("/profile?error=Skill+name+required");
  if (!["exposure", "working", "advanced", "expert"].includes(level)) redirect("/profile?error=Invalid+level");
  run(
    "INSERT INTO skills (name, category, level, years, verified, source, sort) VALUES (?, ?, ?, ?, 1, 'manual', (SELECT COALESCE(MAX(sort),0)+1 FROM skills))",
    [name, category, level, v(years)],
  );
  audit({ action: "skill.added", entity: "skill", detail: name, userId: user.id });
  revalidatePath("/profile");
  redirect("/profile?saved=1");
}

export async function updateSkillAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = Number(formData.get("id"));
  const level = String(formData.get("level") ?? "working");
  if (!Number.isFinite(id) || !["exposure", "working", "advanced", "expert"].includes(level)) redirect("/profile?error=Invalid+skill+update");
  run("UPDATE skills SET level = ?, verified = 1 WHERE id = ?", [level, id]);
  audit({ action: "skill.updated", entity: "skill", entityId: String(id), detail: `Level: ${level}`, userId: user.id });
  revalidatePath("/profile");
  redirect("/profile?saved=1");
}

export async function deleteSkillAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = Number(formData.get("id"));
  run("DELETE FROM skills WHERE id = ?", [id]);
  audit({ action: "skill.deleted", entity: "skill", entityId: String(id), userId: user.id });
  revalidatePath("/profile");
  redirect("/profile?saved=1");
}

export async function addExperienceAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const company = String(formData.get("company") ?? "").trim();
  const title = String(formData.get("title") ?? "").trim();
  if (!company || !title) redirect("/profile?error=Company+and+title+are+required");
  const achievements = String(formData.get("achievements") ?? "")
    .split("\n")
    .map((line) => line.replace(/^[-•]\s*/, "").trim())
    .filter(Boolean);
  run(
    `INSERT INTO experiences (company, title, location, start_date, end_date, is_current, summary, achievements, sort)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort),0)+1 FROM experiences))`,
    [
      company,
      title,
      String(formData.get("location") ?? "").trim() || null,
      String(formData.get("start_date") ?? "").trim() || null,
      String(formData.get("end_date") ?? "").trim() || null,
      formData.get("is_current") === "on" ? 1 : 0,
      String(formData.get("summary") ?? "").trim() || null,
      JSON.stringify(achievements),
    ],
  );
  audit({ action: "experience.added", entity: "experience", detail: `${title} at ${company}`, userId: user.id });
  revalidatePath("/profile");
  redirect("/profile?saved=1");
}

export async function updateExperienceAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = Number(formData.get("id"));
  const achievements = String(formData.get("achievements") ?? "")
    .split("\n")
    .map((line) => line.replace(/^[-•]\s*/, "").trim())
    .filter(Boolean);
  run(
    "UPDATE experiences SET location = ?, start_date = ?, end_date = ?, is_current = ?, summary = ?, achievements = ? WHERE id = ?",
    [
      String(formData.get("location") ?? "").trim() || null,
      String(formData.get("start_date") ?? "").trim() || null,
      String(formData.get("end_date") ?? "").trim() || null,
      formData.get("is_current") === "on" ? 1 : 0,
      String(formData.get("summary") ?? "").trim() || null,
      JSON.stringify(achievements),
      id,
    ],
  );
  audit({ action: "experience.updated", entity: "experience", entityId: String(id), userId: user.id });
  revalidatePath("/profile");
  redirect("/profile?saved=1");
}

export async function deleteExperienceAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  run("DELETE FROM experiences WHERE id = ?", [Number(formData.get("id"))]);
  audit({ action: "experience.deleted", entity: "experience", entityId: String(formData.get("id")), userId: user.id });
  revalidatePath("/profile");
  redirect("/profile?saved=1");
}

export async function addProfileItemAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const kind = String(formData.get("kind") ?? "certification");
  const title = String(formData.get("title") ?? "").trim();
  if (!title) redirect("/profile?error=Title+required");
  run(
    "INSERT INTO profile_items (kind, title, subtitle, detail, start_date, end_date, sort) VALUES (?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort),0)+1 FROM profile_items))",
    [
      kind,
      title,
      String(formData.get("subtitle") ?? "").trim() || null,
      String(formData.get("detail") ?? "").trim() || null,
      String(formData.get("start_date") ?? "").trim() || null,
      String(formData.get("end_date") ?? "").trim() || null,
    ],
  );
  audit({ action: "profile_item.added", entity: "profile_item", detail: `${kind}: ${title}`, userId: user.id });
  revalidatePath("/profile");
  redirect("/profile?saved=1");
}

export async function deleteProfileItemAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  run("DELETE FROM profile_items WHERE id = ?", [Number(formData.get("id"))]);
  audit({ action: "profile_item.deleted", entity: "profile_item", entityId: String(formData.get("id")), userId: user.id });
  revalidatePath("/profile");
  redirect("/profile?saved=1");
}

export async function saveLanguagesAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const languages = String(formData.get("languages") ?? "")
    .split(",")
    .map((l) => l.trim())
    .filter(Boolean);
  run("UPDATE profiles SET languages = ?, updated_at = ? WHERE id = 1", [JSON.stringify(languages), nowIso()]);
  audit({ action: "profile.languages_updated", entity: "profile", detail: languages.join(", "), userId: user.id });
  revalidatePath("/profile");
  redirect("/profile?saved=1");
}

/** Shared by admin and owner: link the active original CV to the profile. */
export async function applyCvAsSource(formData: FormData): Promise<void> {
  await requireAdmin().catch(() => null);
  const user = await requireUser();
  const documentId = String(formData.get("document_id") ?? "");
  run("UPDATE profiles SET source_cv_id = ?, updated_at = ? WHERE id = 1", [documentId, nowIso()]);
  audit({ action: "profile.source_cv_linked", entity: "document", entityId: documentId, userId: user.id });
  revalidatePath("/documents");
  redirect("/documents?saved=1");
}

"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { all, nowIso, one, run, v } from "@/lib/db";
import { requireUser, requireAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { normaliseLanguageLevel, parseLanguageEntries, type LanguageEntry } from "@/lib/profile";
import { syncProfileFromCv } from "@/lib/profile-sync";
import { richTextToBullets, richTextToPlain, sanitizeRichText } from "@/lib/rich-text";

function touch(): void {
  run("UPDATE profiles SET updated_at = ? WHERE id = 1", [nowIso()]);
}

const SKILL_LEVELS = ["exposure", "working", "advanced", "expert", "unspecified"];

function skillLevel(value: FormDataEntryValue | null): string {
  const level = String(value ?? "working");
  return SKILL_LEVELS.includes(level) ? level : "working";
}

function roleContent(formData: FormData): {
  summary: string | null;
  achievements: string[];
  projects: string | null;
  summaryHtml: string;
  achievementsHtml: string;
  projectsHtml: string;
} {
  const hasRichFields = formData.has("summary_html") || formData.has("achievements_html") || formData.has("projects_html");
  if (!hasRichFields) {
    const summary = String(formData.get("summary") ?? "").trim();
    const achievements = String(formData.get("achievements") ?? "")
      .split("\n")
      .map((line) => line.replace(/^[-•]\s*/, "").trim())
      .filter(Boolean);
    return {
      summary: summary || null,
      achievements,
      projects: String(formData.get("projects") ?? "").trim() || null,
      summaryHtml: "",
      achievementsHtml: "",
      projectsHtml: "",
    };
  }
  const summaryHtml = sanitizeRichText(String(formData.get("summary_html") ?? ""));
  const achievementsHtml = sanitizeRichText(String(formData.get("achievements_html") ?? ""));
  const projectsHtml = sanitizeRichText(String(formData.get("projects_html") ?? ""));
  return {
    summary: richTextToPlain(summaryHtml) || null,
    achievements: richTextToBullets(achievementsHtml),
    projects: richTextToPlain(projectsHtml) || null,
    summaryHtml,
    achievementsHtml,
    projectsHtml,
  };
}

export async function syncProfileAction(): Promise<{ experiences: number; skills: number; languages: number }> {
  await requireUser();
  const result = await syncProfileFromCv();
  revalidatePath("/profile");
  return result;
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
  redirect("/profile?ok=Profile+updated+successfully");
}

export async function addSkillAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const name = String(formData.get("name") ?? "").replace(/\s+/g, " ").trim();
  const category = String(formData.get("category") ?? "Other").trim() || "Other";
  const level = skillLevel(formData.get("level"));
  const years = formData.get("years") ? Number(formData.get("years")) : null;
  if (!name) redirect("/profile?error=Skill+name+required");
  const existing = one<{ id: number; deleted_at: string | null; source: string }>("SELECT id, deleted_at, source FROM skills WHERE lower(name) = lower(?)", [name]);
  if (existing && !existing.deleted_at && existing.source !== "seed") redirect("/profile?error=That+skill+already+exists");
  if (existing) {
    run("UPDATE skills SET category = ?, level = ?, years = ?, verified = 1, source = 'manual', deleted_at = NULL WHERE id = ?", [category, level, v(years), existing.id]);
  } else {
    run(
      "INSERT INTO skills (name, category, level, years, verified, source, sort) VALUES (?, ?, ?, ?, 1, 'manual', (SELECT COALESCE(MAX(sort),0)+1 FROM skills))",
      [name, category, level, v(years)],
    );
  }
  audit({ action: existing ? "skill.restored" : "skill.added", entity: "skill", detail: name, userId: user.id });
  revalidatePath("/profile");
  redirect("/profile?ok=Skill+added+successfully");
}

export async function updateSkillAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = Number(formData.get("id"));
  const current = one<{ name: string }>("SELECT name FROM skills WHERE id = ?", [id]);
  if (!current) redirect("/profile?error=Skill+not+found");
  const name = String(formData.get("name") ?? current.name).replace(/\s+/g, " ").trim() || current.name;
  const category = String(formData.get("category") ?? "Other").trim() || "Other";
  const level = skillLevel(formData.get("level"));
  const clash = one<{ id: number }>("SELECT id FROM skills WHERE lower(name) = lower(?) AND id != ? AND deleted_at IS NULL", [name, id]);
  if (clash) redirect("/profile?error=That+skill+already+exists");
  run("UPDATE skills SET name = ?, category = ?, level = ?, verified = 1 WHERE id = ?", [name, category, level, id]);
  audit({ action: "skill.updated", entity: "skill", entityId: String(id), detail: `${name}: ${level}`, userId: user.id });
  revalidatePath("/profile");
  redirect("/profile?ok=Skill+updated+successfully");
}

export async function deleteSkillAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = Number(formData.get("id"));
  run("UPDATE skills SET deleted_at = ? WHERE id = ?", [nowIso(), id]);
  audit({ action: "skill.deleted", entity: "skill", entityId: String(id), userId: user.id });
  revalidatePath("/profile");
  redirect("/profile?ok=Skill+removed+successfully");
}

export async function saveSkillLevelsAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  // Delete is submitted through the same form using an explicit intent. A
  // nested delete form is invalid HTML, and a named formAction button causes a
  // React server/client attribute mismatch on this page.
  const intent = String(formData.get("intent") ?? "");
  if (intent.startsWith("delete:")) {
    const id = Number(intent.slice("delete:".length));
    if (Number.isFinite(id)) {
      run("UPDATE skills SET deleted_at = ? WHERE id = ?", [nowIso(), id]);
      audit({ action: "skill.deleted", entity: "skill", entityId: String(id), userId: user.id });
    }
    revalidatePath("/profile");
    redirect("/profile?ok=Skill+removed+successfully");
  }
  const ids = formData.getAll("skill_id");
  const levels = formData.getAll("level");
  let updated = 0;
  for (const [index, rawId] of ids.entries()) {
    const id = Number(rawId);
    if (!Number.isFinite(id)) continue;
    const level = skillLevel(levels[index] ?? null);
    run("UPDATE skills SET level = ?, verified = 1 WHERE id = ? AND deleted_at IS NULL", [level, id]);
    updated += 1;
  }
  audit({ action: "skills.levels_updated", entity: "skill", detail: `${updated} skill level(s) updated`, userId: user.id });
  revalidatePath("/profile");
  redirect("/profile?ok=Skills+updated+successfully");
}

export async function addExperienceAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const company = String(formData.get("company") ?? "").replace(/\s+/g, " ").trim();
  const title = String(formData.get("title") ?? "").replace(/\s+/g, " ").trim();
  if (!company || !title) redirect("/profile?error=Company+and+title+are+required");
  const content = roleContent(formData);
  run(
    `INSERT INTO experiences
     (company, title, location, start_date, end_date, is_current, summary, achievements, projects,
      responsibilities_html, achievements_html, projects_html, edited_at, sort)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort),0)+1 FROM experiences))`,
    [
      company,
      title,
      String(formData.get("location") ?? "").trim() || null,
      String(formData.get("start_date") ?? "").trim() || null,
      String(formData.get("end_date") ?? "").trim() || null,
      formData.get("is_current") === "on" ? 1 : 0,
      content.summary,
      JSON.stringify(content.achievements),
      content.projects,
      content.summaryHtml,
      content.achievementsHtml,
      content.projectsHtml,
      nowIso(),
    ],
  );
  audit({ action: "experience.added", entity: "experience", detail: `${title} at ${company}`, userId: user.id });
  revalidatePath("/profile");
  redirect("/profile?ok=Role+added+successfully");
}

export async function updateExperienceAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = Number(formData.get("id"));
  const current = one<{ company: string; title: string }>("SELECT company, title FROM experiences WHERE id = ?", [id]);
  if (!current) redirect("/profile?error=Role+not+found");
  const company = String(formData.get("company") ?? current.company).replace(/\s+/g, " ").trim() || current.company;
  const title = String(formData.get("title") ?? current.title).replace(/\s+/g, " ").trim() || current.title;
  const content = roleContent(formData);
  run(
    `UPDATE experiences SET company = ?, title = ?, location = ?, start_date = ?, end_date = ?, is_current = ?,
     summary = ?, achievements = ?, projects = ?, responsibilities_html = ?, achievements_html = ?, projects_html = ?,
     edited_at = ?, deleted_at = NULL WHERE id = ?`,
    [
      company,
      title,
      String(formData.get("location") ?? "").trim() || null,
      String(formData.get("start_date") ?? "").trim() || null,
      String(formData.get("end_date") ?? "").trim() || null,
      formData.get("is_current") === "on" ? 1 : 0,
      content.summary,
      JSON.stringify(content.achievements),
      content.projects,
      content.summaryHtml,
      content.achievementsHtml,
      content.projectsHtml,
      nowIso(),
      id,
    ],
  );
  audit({ action: "experience.updated", entity: "experience", entityId: String(id), detail: `${title} at ${company}`, userId: user.id });
  revalidatePath("/profile");
  redirect("/profile?ok=Role+updated+successfully");
}

export async function deleteExperienceAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = Number(formData.get("id"));
  run("UPDATE experiences SET deleted_at = ?, edited_at = ? WHERE id = ?", [nowIso(), nowIso(), id]);
  audit({ action: "experience.deleted", entity: "experience", entityId: String(id), userId: user.id });
  revalidatePath("/profile");
  redirect("/profile?ok=Role+removed+successfully");
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
  redirect("/profile?ok=Entry+added+successfully");
}

export async function deleteProfileItemAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  run("DELETE FROM profile_items WHERE id = ?", [Number(formData.get("id"))]);
  audit({ action: "profile_item.deleted", entity: "profile_item", entityId: String(formData.get("id")), userId: user.id });
  revalidatePath("/profile");
  redirect("/profile?ok=Entry+removed+successfully");
}

export async function saveLanguagesAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const names = formData.getAll("language_name").map((value) => String(value));
  const levels = formData.getAll("language_level").map((value) => String(value));
  const raw = names.map((name, index) => ({ name: name.trim(), level: normaliseLanguageLevel(levels[index]) }));
  const entries = parseLanguageEntries(JSON.stringify(raw));
  if (entries.length !== raw.filter((entry) => entry.name).length) {
    redirect("/profile?error=Duplicate+languages+are+not+allowed");
  }
  const effective: LanguageEntry[] = entries;
  run("UPDATE profiles SET languages = ?, languages_synced_at = ?, updated_at = ? WHERE id = 1", [JSON.stringify(effective), nowIso(), nowIso()]);
  audit({ action: "profile.languages_updated", entity: "profile", detail: effective.map((entry) => `${entry.name} (${entry.level})`).join(", "), userId: user.id });
  revalidatePath("/profile");
  redirect("/profile?ok=Languages+updated+successfully");
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

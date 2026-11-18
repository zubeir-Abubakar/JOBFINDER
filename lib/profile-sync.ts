import { all, nowIso, run } from "./db";
import { getProfileData, parseLanguageText, type Experience, type Skill } from "./profile";
import { loadMasterCv } from "./master-cv";

const MONTHS: Record<string, string> = {
  jan: "01",
  feb: "02",
  mar: "03",
  apr: "04",
  may: "05",
  jun: "06",
  jul: "07",
  aug: "08",
  sep: "09",
  oct: "10",
  nov: "11",
  dec: "12",
};

function isoMonth(value: string): string | null {
  const match = value.match(/([A-Za-z]{3,9})\s+(\d{4})/);
  if (!match) return null;
  const month = MONTHS[match[1].slice(0, 3).toLowerCase()];
  return month ? `${match[2]}-${month}` : null;
}

function datesFromRange(value: string): { start: string | null; end: string | null; current: boolean } {
  const [startPart, endPart = ""] = value.split(/\s*[–—]\s*/);
  const current = /\b(present|current)\b/i.test(endPart);
  return { start: isoMonth(startPart), end: current ? null : isoMonth(endPart), current };
}

function normalise(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function companyStem(value: string): string {
  return normalise(value.replace(/\b(?:plc|ltd|limited|inc|ag|gmbh|sa|sarl)\b\.?/gi, " "));
}

function titleStem(value: string): string {
  return normalise(value.replace(/\([^)]*\)/g, " ").replace(/\/.*$/, " "));
}

/** Match an imported row without confusing two roles at the same employer. */
function matchesRole(experience: Experience, role: { key: string; company: string; title: string }): boolean {
  if (experience.source_key && experience.source_key === role.key) return true;
  if (companyStem(experience.company) !== companyStem(role.company)) return false;
  return titleStem(experience.title) === titleStem(role.title);
}

/**
 * Additive, idempotent import from the active uploaded CV. It only adds content
 * the profile does not have, never rewrites an existing or edited row, and
 * skips tombstones so an explicit removal is respected.
 */
export async function syncProfileFromCv(): Promise<{ experiences: number; skills: number; languages: number }> {
  const data = getProfileData();
  if (!data.profile.source_cv_id) return { experiences: 0, skills: 0, languages: 0 };
  if (data.profile.cv_synced_source === data.profile.source_cv_id) return { experiences: 0, skills: 0, languages: 0 };
  const master = await loadMasterCv(data);
  if (!master.sourceId) return { experiences: 0, skills: 0, languages: 0 };

  let languages = 0;
  if (!data.profile.languages_synced_at) {
    // One automatic import only. After that the user's removals and level edits
    // are authoritative and are never re-created by a page reload.
    if (master.languages && (data.languageEntries.length === 0 || data.languageEntries.every((entry) => entry.level === "unspecified"))) {
      const entries = parseLanguageText(master.languages);
      if (entries.length > 0) {
        run("UPDATE profiles SET languages = ?, languages_synced_at = ?, updated_at = ? WHERE id = 1", [JSON.stringify(entries), nowIso(), nowIso()]);
        languages = entries.length;
      }
    } else {
      run("UPDATE profiles SET languages_synced_at = ? WHERE id = 1", [nowIso()]);
    }
  }

  const skillRows = all<Skill>("SELECT * FROM skills WHERE deleted_at IS NULL AND source <> 'seed' ORDER BY sort, id");
  const skillNames = new Set(skillRows.map((skill) => normalise(skill.name)));
  let skills = 0;
  for (const group of master.skillGroups) {
    for (const value of group.values) {
      const name = value.replace(/\s+/g, " ").trim();
      if (!name || skillNames.has(normalise(name))) continue;
      run(
        "INSERT INTO skills (name, category, level, years, verified, source, sort) VALUES (?, ?, 'unspecified', NULL, 1, 'cv', (SELECT COALESCE(MAX(sort),0)+1 FROM skills))",
        [name, group.label],
      );
      skillNames.add(normalise(name));
      skills += 1;
    }
  }

  const experienceRows = all<Experience>("SELECT * FROM experiences");
  let experiences = 0;
  for (const [index, role] of master.roles.entries()) {
    const existing = experienceRows.find((experience) => matchesRole(experience, role));
    if (existing) {
      if (!existing.source_key) run("UPDATE experiences SET source_key = ? WHERE id = ?", [role.key, existing.id]);
      continue;
    }
    const dates = datesFromRange(role.dates);
    const achievements = role.bullets.map((bullet) => bullet.trim()).filter(Boolean);
    run(
      `INSERT INTO experiences
       (company, title, location, start_date, end_date, is_current, summary, achievements, projects, source_key, sort)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      [
        role.company || "Company to confirm",
        role.title || "Role to confirm",
        role.location,
        dates.start,
        dates.end,
        dates.current ? 1 : 0,
        role.note,
        JSON.stringify(achievements),
        role.key,
        1000 + index,
      ],
    );
    experiences += 1;
  }

  run("UPDATE profiles SET cv_synced_source = ?, updated_at = ? WHERE id = 1", [master.sourceId, nowIso()]);
  return { experiences, skills, languages };
}

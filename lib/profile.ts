import { all, one } from "./db";
import {
  LANGUAGE_LEVELS,
  languageLevelLabel,
  languageLevelShort,
  normaliseLanguageLevel,
  skillLevelLabel,
  type LanguageEntry,
  type LanguageLevel,
  type SkillLevel,
} from "./profile-options";

export { LANGUAGE_LEVELS, languageLevelLabel, languageLevelShort, normaliseLanguageLevel, skillLevelLabel } from "./profile-options";
export type { LanguageEntry, LanguageLevel, SkillLevel } from "./profile-options";

export type Skill = {
  id: number;
  name: string;
  category: string;
  level: SkillLevel;
  years: number | null;
  verified: number;
  source: string;
  sort: number;
  deleted_at: string | null;
};

export type Experience = {
  id: number;
  company: string;
  title: string;
  location: string | null;
  start_date: string | null;
  end_date: string | null;
  is_current: number;
  summary: string | null;
  achievements: string | null;
  projects: string | null;
  responsibilities_html: string | null;
  achievements_html: string | null;
  projects_html: string | null;
  source_key: string | null;
  edited_at: string | null;
  deleted_at: string | null;
  sort: number;
};

export type ProfileItem = {
  id: number;
  kind: string;
  title: string;
  subtitle: string | null;
  detail: string | null;
  start_date: string | null;
  end_date: string | null;
  sort: number;
};

export type ProfileRow = {
  id: number;
  full_name: string | null;
  headline: string | null;
  email: string | null;
  phone: string | null;
  location: string | null;
  work_authorisation: string | null;
  permit_valid_until: string | null;
  summary: string | null;
  linkedin: string | null;
  website: string | null;
  languages: string | null;
  languages_synced_at: string | null;
  cv_synced_source: string | null;
  preferences: string | null;
  source_cv_id: string | null;
  updated_at: string | null;
};

export type Preferences = {
  titles: string[];
  locations: string[];
  min_salary: number | null;
  employment_types: string[];
  remote_preference: string;
  industries: string[];
  languages: string[];
  german_required: string;
  french: string;
};

export type ProfileData = {
  profile: ProfileRow;
  skills: Skill[];
  experiences: Experience[];
  deletedExperiences: Experience[];
  items: ProfileItem[];
  preferences: Preferences;
  languages: string[];
  languageEntries: LanguageEntry[];
};

export const EMPTY_PREFERENCES: Preferences = {
  titles: [],
  locations: [],
  min_salary: null,
  employment_types: [],
  remote_preference: "any",
  industries: [],
  languages: ["English"],
  german_required: "avoid",
  french: "evaluate",
};

export function plain<T extends object>(value: T): T {
  return { ...value };
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function parseLanguageString(value: string): LanguageEntry {
  const clean = value.replace(/\s+/g, " ").trim();
  const match = clean.match(/^(.+?)\s*(?:\(([^)]+)\)|[-–—]\s*(.+))$/);
  if (!match) return { name: clean, level: "unspecified" };
  const name = match[1].replace(/[,\s]+$/, "").trim();
  return { name, level: normaliseLanguageLevel(match[2] ?? match[3]) };
}

function dedupeLanguages(entries: LanguageEntry[]): LanguageEntry[] {
  const seen = new Set<string>();
  const result: LanguageEntry[] = [];
  for (const entry of entries) {
    const name = entry.name.replace(/\s+/g, " ").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ name, level: normaliseLanguageLevel(entry.level) });
  }
  return result;
}

/** Parses both the old string array and the new {name, level} array without a data migration. */
export function parseLanguageEntries(value: string | null | undefined): LanguageEntry[] {
  if (!value) return [];
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(value);
  } catch {
    parsed = value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  if (!Array.isArray(parsed)) return [];
  return dedupeLanguages(
    parsed.map((item) => {
      if (typeof item === "string") return parseLanguageString(item);
      if (item && typeof item === "object") {
        const row = item as { name?: unknown; level?: unknown };
        return { name: String(row.name ?? "").trim(), level: normaliseLanguageLevel(row.level) };
      }
      return { name: "", level: "unspecified" as const };
    }),
  );
}

/** Parses a CV language line such as `English (C2) | French (B2)`. */
export function parseLanguageText(value: string | null | undefined): LanguageEntry[] {
  if (!value) return [];
  const parts = value.includes("|") ? value.split("|") : value.split(/,\s*(?=[A-Z])/);
  return dedupeLanguages(parts.map((part) => parseLanguageString(part)).filter((entry) => entry.name));
}

export function formatLanguageEntries(entries: LanguageEntry[]): string {
  return dedupeLanguages(entries)
    .map((entry) => {
      const short = languageLevelShort(entry.level);
      return short ? `${entry.name} (${short})` : entry.name;
    })
    .join(" | ");
}

export function hasSpecifiedLanguageLevels(entries: LanguageEntry[]): boolean {
  return entries.some((entry) => entry.level !== "unspecified");
}

const DATE_MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function dateSortValue(value: string | null): number {
  if (!value) return 0;
  const iso = value.match(/^(\d{4})-(\d{2})/);
  if (iso) return Number(iso[1]) * 100 + Number(iso[2]);
  const month = value.match(/([A-Za-z]{3,9})\s+(\d{4})/);
  if (month) return Number(month[2]) * 100 + (DATE_MONTHS[month[1].slice(0, 3).toLowerCase()] ?? 0);
  const year = value.match(/(\d{4})/);
  return year ? Number(year[1]) * 100 : 0;
}

export function getProfileData(): ProfileData {
  const profileRow = one<ProfileRow>("SELECT * FROM profiles WHERE id = 1");
  const profile = profileRow ? plain(profileRow) : null;
  const allSkills = all<Skill>("SELECT * FROM skills ORDER BY sort, id").map(plain);
  const allExperiences = all<Experience>("SELECT * FROM experiences").map(plain).sort(
    (a, b) =>
      b.is_current - a.is_current ||
      dateSortValue(b.start_date) - dateSortValue(a.start_date) ||
      a.sort - b.sort ||
      a.id - b.id,
  );
  const experiences = allExperiences.filter((experience) => !experience.deleted_at);
  const deletedExperiences = allExperiences.filter((experience) => Boolean(experience.deleted_at));
  const items = all<ProfileItem>("SELECT * FROM profile_items ORDER BY sort, id").map(plain);
  const fallback: ProfileRow = {
    id: 1,
    full_name: "Abubakar Towfiq",
    headline: "Senior QA Engineer",
    email: null,
    phone: null,
    location: "Switzerland",
    work_authorisation: null,
    permit_valid_until: null,
    summary: null,
    linkedin: null,
    website: null,
    languages: "[]",
    languages_synced_at: null,
    cv_synced_source: null,
    preferences: null,
    source_cv_id: null,
    updated_at: null,
  };
  const languageEntries = parseLanguageEntries(profile?.languages);
  return {
    profile: profile ?? fallback,
    // Seed-only skills predate the CV editor and are not evidence from the
    // uploaded CV. Keep them in the database, but do not present or use them.
    // Dedupe older repeated imports by name so the editor never shows a 100+
    // skills pile made of the same entry again.
    skills: allSkills
      .filter((skill) => !skill.deleted_at && skill.source !== "seed")
      .filter((() => {
        const seen = new Set<string>();
        return (skill: Skill) => {
          const key = skill.name.trim().toLowerCase();
          if (!key || seen.has(key)) return false;
          seen.add(key);
          return true;
        };
      })()),
    experiences,
    deletedExperiences,
    items,
    preferences: parseJson<Preferences>(profile?.preferences, EMPTY_PREFERENCES),
    languages: languageEntries.map((entry) => entry.name),
    languageEntries,
  };
}

/** Ordered evidence of the owner's skills, strongest first. Unknown levels stay honest at the bottom. */
export function rankedSkills(profile: ProfileData): Skill[] {
  const weight: Record<string, number> = { expert: 4, advanced: 3, working: 2, exposure: 1, unspecified: 0 };
  return [...profile.skills].sort((a, b) => (weight[b.level] ?? 0) - (weight[a.level] ?? 0) || a.name.localeCompare(b.name));
}

export function profileCompleteness(profile: ProfileData): number {
  const p = profile.profile;
  const checks = [
    Boolean(p.full_name),
    Boolean(p.headline),
    Boolean(p.email),
    Boolean(p.phone),
    Boolean(p.location),
    Boolean(p.summary),
    profile.skills.length > 0,
    profile.experiences.length > 0,
    profile.experiences.some((e) => Boolean(e.start_date)),
    Boolean(p.source_cv_id),
  ];
  return Math.round((checks.filter(Boolean).length / checks.length) * 100);
}

import { all, one } from "./db";

export type Skill = {
  id: number;
  name: string;
  category: string;
  level: "exposure" | "working" | "advanced" | "expert";
  years: number | null;
  verified: number;
  source: string;
  sort: number;
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
  items: ProfileItem[];
  preferences: Preferences;
  languages: string[];
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

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function getProfileData(): ProfileData {
  const profile = one<ProfileRow>("SELECT * FROM profiles WHERE id = 1");
  const skills = all<Skill>("SELECT * FROM skills ORDER BY sort, id");
  const experiences = all<Experience>("SELECT * FROM experiences ORDER BY is_current DESC, sort, id");
  const items = all<ProfileItem>("SELECT * FROM profile_items ORDER BY sort, id");
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
    languages: '["English"]',
    preferences: null,
    source_cv_id: null,
    updated_at: null,
  };
  return {
    profile: profile ?? fallback,
    skills,
    experiences,
    items,
    preferences: parseJson<Preferences>(profile?.preferences, EMPTY_PREFERENCES),
    languages: parseJson<string[]>(profile?.languages, ["English"]),
  };
}

export function skillLevelLabel(level: string): string {
  switch (level) {
    case "expert":
      return "Expert";
    case "advanced":
      return "Advanced";
    case "exposure":
      return "Exposure";
    default:
      return "Working";
  }
}

/** Ordered evidence of the owner's skills, strongest first. */
export function rankedSkills(profile: ProfileData): Skill[] {
  const weight: Record<string, number> = { expert: 4, advanced: 3, working: 2, exposure: 1 };
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

/** Browser-safe profile constants. This module must never import the database. */

export type LanguageLevel = "native" | "C2" | "C1" | "B2" | "B1" | "A2" | "A1" | "unspecified";
export type LanguageEntry = { name: string; level: LanguageLevel };
export type SkillLevel = "exposure" | "working" | "advanced" | "expert" | "unspecified";

export const LANGUAGE_LEVELS: Array<{ value: LanguageLevel; label: string }> = [
  { value: "native", label: "Native / First language" },
  { value: "C2", label: "C2 — Proficient" },
  { value: "C1", label: "C1 — Advanced" },
  { value: "B2", label: "B2 — Upper intermediate" },
  { value: "B1", label: "B1 — Intermediate" },
  { value: "A2", label: "A2 — Elementary" },
  { value: "A1", label: "A1 — Beginner" },
  { value: "unspecified", label: "Level not specified" },
];

const LEVEL_ALIASES: Record<string, LanguageLevel> = {
  native: "native",
  "first language": "native",
  "mother tongue": "native",
  c2: "C2",
  c1: "C1",
  b2: "B2",
  b1: "B1",
  a2: "A2",
  a1: "A1",
};

export function normaliseLanguageLevel(value: unknown): LanguageLevel {
  const key = String(value ?? "").trim().toLowerCase();
  return LEVEL_ALIASES[key] ?? "unspecified";
}

export function languageLevelLabel(level: LanguageLevel | string): string {
  return LANGUAGE_LEVELS.find((entry) => entry.value === level)?.label ?? "Level not specified";
}

export function languageLevelShort(level: LanguageLevel | string): string {
  if (level === "native") return "Native";
  if (level === "unspecified") return "";
  return level;
}

export function skillLevelLabel(level: string): string {
  switch (level) {
    case "expert":
      return "Expert";
    case "advanced":
      return "Advanced";
    case "exposure":
      return "Exposure";
    case "unspecified":
      return "Unspecified";
    default:
      return "Working";
  }
}

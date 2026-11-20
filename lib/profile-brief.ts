import { one } from "./db";
import { getProfileData, rankedSkills } from "./profile";

/**
 * Owner-facing profile facts with explicit provenance.
 *
 * This is deliberately read-only and bounded. It never infers experience from
 * a job description and never fills missing fields with plausible defaults.
 */
export function profileBrief(): string {
  const data = getProfileData();
  const profile = data.profile;
  const original = profile.source_cv_id
    ? one<{ display_name: string; text_content: string | null }>(
        "SELECT display_name, text_content FROM documents WHERE id = ? AND kind = 'original_cv' AND deleted_at IS NULL",
        [profile.source_cv_id],
      )
    : null;

  const stored = [
    profile.full_name ? `Name: ${profile.full_name}` : "Name: not stored",
    profile.headline ? `Headline: ${profile.headline}` : "Headline: not stored",
    profile.location ? `Location: ${profile.location}` : "Location: not stored",
    profile.email ? `Email: ${profile.email}` : "Email: not stored",
    profile.phone ? `Phone: ${profile.phone}` : "Phone: not stored",
    profile.work_authorisation ? `Work authorisation: ${profile.work_authorisation}` : "Work authorisation: not stored",
    profile.summary ? `About me: ${profile.summary}` : "About me: not stored",
  ];

  const experiences = data.experiences.slice(0, 6).map((experience) => {
    const dates = [experience.start_date, experience.is_current ? "present" : experience.end_date].filter(Boolean).join("–");
    const detail = [experience.location, dates].filter(Boolean).join(", ");
    return `- ${experience.title} at ${experience.company}${detail ? ` (${detail})` : ""}`;
  });

  const skills = rankedSkills(data).slice(0, 12).map((skill) => {
    const level = skill.level && skill.level !== "unspecified" ? `, ${skill.level}` : "";
    return `${skill.name}${level}`;
  });

  const languages = data.languageEntries.map((entry) => {
    return `${entry.name}${entry.level && entry.level !== "unspecified" ? ` (${entry.level})` : ""}`;
  });

  const preferences = [
    data.preferences.titles.length ? `target roles: ${data.preferences.titles.join(", ")}` : "",
    data.preferences.locations.length ? `locations: ${data.preferences.locations.join(", ")}` : "",
    data.preferences.employment_types.length ? `employment: ${data.preferences.employment_types.join(", ")}` : "",
    data.preferences.remote_preference ? `work mode: ${data.preferences.remote_preference.replace(/_/g, " ")}` : "",
    data.preferences.min_salary ? `minimum salary: CHF ${data.preferences.min_salary.toLocaleString("en-CH")}` : "",
  ].filter(Boolean);

  const missing = [
    !profile.summary ? "About me summary" : "",
    !profile.phone ? "phone" : "",
    !profile.work_authorisation ? "work authorisation" : "",
    !data.experiences.length ? "work experience" : "",
    !data.skills.length ? "skills" : "",
    !data.languageEntries.length ? "languages" : "",
  ].filter(Boolean);

  const cvText = original?.text_content?.replace(/\s+/g, " ").trim().slice(0, 900) ?? "";

  return [
    "Stored profile fields (account records; not independently verified):",
    ...stored,
    `CV document: ${original ? `${original.display_name} (extracted text is available)` : "no original CV is stored in this account"}.`,
    `Work experience${experiences.length ? " (stored/extracted)" : ""}: ${experiences.length ? `\n${experiences.join("\n")}` : "none stored"}.`,
    `Skills${skills.length ? " (stored/extracted)" : ""}: ${skills.length ? skills.join(", ") : "none stored"}.`,
    `Languages: ${languages.length ? languages.join(", ") : "none stored"}.`,
    `Job preferences: ${preferences.length ? preferences.join("; ") : "none stored"}.`,
    cvText ? `CV extract: “${cvText}${original && (original.text_content?.length ?? 0) > 900 ? "…" : ""}”` : "",
    `Missing information: ${missing.length ? missing.join(", ") : "none of the core profile fields are missing"}.`,
    "I have not inferred qualifications, employers, dates or achievements beyond these stored/extracted records.",
  ]
    .filter(Boolean)
    .join("\n");
}

const PROFILE_INTENT =
  /\b(profile|about me|cv|resume|résumé|curriculum vitae|qualifications?|work experience|employment history|my skills|my languages?|my preferences|work authori[sz]ation)\b/i;
const PROFILE_READ =
  /\b(show|tell|what|know|contain|include|summar|read|display|see|review|list|details?|have)\b/i;
const PROFILE_MUTATION =
  /\b(generate|tailor|create|update|edit|delete|upload|replace|apply|send|analyse|analyze)\b/i;

/** True for a request to inspect the owner's stored profile or CV. */
export function isProfileQuestion(message: string): boolean {
  const text = message.trim();
  return PROFILE_INTENT.test(text) && PROFILE_READ.test(text) && !PROFILE_MUTATION.test(text);
}
